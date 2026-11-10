import process from "node:process";

import {
    ApiClient,
    ApiError,
    Time,
    TimeUnits,
    compute,
} from "@databricks/sdk-experimental";

import {parseErrorResult} from "../../databricks-vscode/src/run/ErrorParser";
import {
    Cluster,
    ExecutionContext,
} from "../../databricks-vscode/src/sdk-extensions";
import type {SessionArgs} from "./args";
import {
    BundleWorkspace,
    WAIT_HEARTBEAT_MS,
    ensureClusterRunning,
    resolveBundleWorkspace,
    resolveCluster,
    syncBundle,
} from "./bundle";
import {
    createProgressReporter,
    formatTableResult,
    moduleUnloadCommand,
    remapRemotePaths,
    sessionSetupCommand,
    stripAnsi,
    summarizePythonError,
    workspacePrefixedPath,
} from "./core";
import {
    EXIT_CANCELLED,
    EXIT_FAILED,
    EXIT_OK,
    EXIT_SESSION_MISSING,
    Output,
    SessionMissingError,
    UsageError,
} from "./output";
import type {CancellationSource} from "./run";
import {SessionCache, SessionEntry, SessionKey} from "./sessionCache";

type Liveness = "running" | "pending" | "lost";

const MAX_COMMAND_TIME = new Time(240, TimeUnits.hours);

function createHint(name: string): string {
    return `run 'databricks-execute session create${
        name === "default" ? "" : ` -s ${name}`
    }'`;
}

/**
 * Ask the API whether a session's context still exists. A stopped cluster or
 * a context the API no longer knows means the session is lost; any other
 * failure (auth, network) is rethrown rather than pruning the cache.
 */
async function checkLiveness(
    apiClient: ApiClient,
    entry: {clusterId: string; contextId: string}
): Promise<Liveness> {
    try {
        const cluster = await new compute.ClustersService(apiClient).get({
            // eslint-disable-next-line @typescript-eslint/naming-convention
            cluster_id: entry.clusterId,
        });
        if (!["RUNNING", "RESIZING"].includes(cluster.state ?? "")) {
            return "lost";
        }
        const status = await new compute.CommandExecutionService(
            apiClient
        ).contextStatus({
            clusterId: entry.clusterId,
            contextId: entry.contextId,
        });
        if (status.status === "Running") {
            return "running";
        }
        return status.status === "Pending" ? "pending" : "lost";
    } catch (e) {
        if (
            e instanceof ApiError &&
            (e.statusCode === 400 || e.statusCode === 404)
        ) {
            return "lost";
        }
        throw e;
    }
}

async function readStdin(): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
}

/** Run setup/sync helper code; a failure here is ours, not the user's. */
async function runInternal(
    context: ExecutionContext,
    code: string,
    what: string
) {
    const {result} = await context.execute(code);
    if (result.results?.resultType === "error") {
        throw new Error(
            `${what} failed: ${stripAnsi(
                result.results.cause ?? result.results.summary ?? ""
            )}`
        );
    }
    if (result.status !== "Finished") {
        throw new Error(
            `${what} failed: command ${result.status ?? "Unknown"}.`
        );
    }
}

class SessionRunner {
    private readonly cache = new SessionCache(SessionCache.defaultPath());
    private readonly startedAt = Date.now();

    constructor(
        private readonly args: SessionArgs,
        private readonly ws: BundleWorkspace,
        private readonly cts: CancellationSource,
        private readonly out: Output
    ) {}

    private get name() {
        return this.args.name;
    }

    private key(clusterId: string): SessionKey {
        return {
            host: this.ws.host,
            clusterId,
            bundleRoot: this.remoteRoot(),
            name: this.name,
        };
    }

    private remoteRoot() {
        return workspacePrefixedPath(this.ws.remoteRootPath);
    }

    private async cluster(): Promise<Cluster> {
        return await resolveCluster(this.ws, this.args.cluster, "");
    }

    /** The cached session, verified live; prunes and throws if it is gone. */
    private async liveEntry(cluster: Cluster): Promise<SessionEntry> {
        const entry = await this.cache.get(this.key(cluster.id));
        if (!entry) {
            throw new SessionMissingError(
                `No session '${this.name}' on cluster ${
                    cluster.id
                }; ${createHint(this.name)}.`
            );
        }
        if ((await checkLiveness(this.ws.apiClient, entry)) === "lost") {
            await this.cache.delete(entry);
            throw new SessionMissingError(
                `Session '${
                    this.name
                }' was lost (cluster restarted or terminated); ${createHint(
                    this.name
                )}.`
            );
        }
        return entry;
    }

    private base(clusterId: string | undefined) {
        return {
            mode: "session",
            action: this.args.action,
            session: this.name,
            clusterId,
        };
    }

    async create(): Promise<number> {
        const cluster = await this.cluster();
        const existing = await this.cache.get(this.key(cluster.id));
        if (existing) {
            const liveness = await checkLiveness(this.ws.apiClient, existing);
            if (liveness !== "lost" && !this.args.force) {
                this.out.human(
                    `Session '${this.name}' already exists on cluster ${cluster.id} (context ${existing.contextId}). Use --force to replace it.`
                );
                this.out.result({
                    ...this.base(cluster.id),
                    contextId: existing.contextId,
                    status: "existing",
                    exitCode: EXIT_OK,
                });
                return EXIT_OK;
            }
            if (liveness !== "lost") {
                this.out.status(
                    `Destroying existing context ${existing.contextId}...`
                );
                await ExecutionContext.fromId(
                    this.ws.apiClient,
                    cluster,
                    existing.contextId
                )
                    .destroy()
                    .catch(() => undefined);
            }
            await this.cache.delete(existing);
        }

        await ensureClusterRunning(
            cluster,
            this.args.startCluster,
            this.cts.token,
            this.out
        );
        await syncBundle(this.ws, this.out);

        this.out.status(
            `Creating execution context on cluster ${cluster.id}...`
        );
        const context = await cluster.createExecutionContext("python");
        try {
            await runInternal(
                context,
                sessionSetupCommand(this.remoteRoot()),
                "Session setup"
            );
        } catch (e) {
            await context.destroy().catch(() => undefined);
            throw e;
        }
        await this.cache.set({
            ...this.key(cluster.id),
            contextId: context.id!,
            createdAt: new Date().toISOString(),
        });

        this.out.human(
            `Session '${this.name}' ready on cluster ${cluster.id} (context ${context.id}).`
        );
        this.out.result({
            ...this.base(cluster.id),
            contextId: context.id,
            status: "created",
            exitCode: EXIT_OK,
            durationMs: Date.now() - this.startedAt,
        });
        return EXIT_OK;
    }

    async exec(): Promise<number> {
        const code = this.args.stdin ? await readStdin() : this.args.code!;
        if (!code.trim()) {
            throw new UsageError("No code to execute.");
        }

        const cluster = await this.cluster();
        const entry = await this.liveEntry(cluster);
        const context = ExecutionContext.fromId(
            this.ws.apiClient,
            cluster,
            entry.contextId
        );

        if (this.args.sync) {
            await syncBundle(this.ws, this.out);
            await runInternal(
                context,
                moduleUnloadCommand(this.remoteRoot()),
                "Reloading bundle modules"
            );
        }

        const reportStatus = createProgressReporter(
            (status: string) => this.out.status(`Command status: ${status}`),
            WAIT_HEARTBEAT_MS
        );
        const {result} = await context.execute(
            code,
            (s) => reportStatus(s.status ?? "Unknown"),
            this.cts.token,
            MAX_COMMAND_TIME
        );
        const results = result.results;

        let stdout = "";
        let rendered: string | undefined;
        let error:
            | {type: string; message: string; traceback: string}
            | undefined;
        switch (results?.resultType) {
            case "text":
                stdout = String(results.data ?? "");
                this.out.programStdout(stdout);
                break;
            case "table":
                rendered = formatTableResult(results.data, results.schema);
                this.out.programStdout(rendered);
                break;
            case "image":
            case "images":
                rendered = `[image result: ${
                    results.fileNames?.join(", ") ?? results.fileName ?? ""
                }]`;
                this.out.programStdout(rendered);
                break;
            case "error": {
                const traceback = remapRemotePaths(
                    parseErrorResult(results)
                        .map((f) => f.text)
                        .join("\n"),
                    this.ws.bundleRoot,
                    this.ws.remoteRootPath
                );
                this.out.programStderr(traceback);
                error = {
                    ...summarizePythonError(results.summary, traceback),
                    traceback: stripAnsi(traceback),
                };
                break;
            }
        }

        // A terminal Error/Cancelled status can come back without an error
        // result; never report it as success.
        if (!error && result.status !== "Finished") {
            const message = `Command ${result.status ?? "Unknown"}${
                results?.cause ? `: ${stripAnsi(results.cause)}` : "."
            }`;
            this.out.programStderr(message);
            error = {
                type: `Command${result.status ?? "Unknown"}`,
                message,
                traceback: "",
            };
        }

        let exitCode: number;
        let status: string;
        if (this.cts.token.isCancellationRequested) {
            exitCode = EXIT_CANCELLED;
            status = "cancelled";
        } else if (error) {
            exitCode = EXIT_FAILED;
            status = "error";
        } else {
            exitCode = EXIT_OK;
            status = "ok";
        }

        this.out.result({
            ...this.base(cluster.id),
            contextId: entry.contextId,
            status,
            exitCode,
            stdout,
            result: rendered,
            error,
            truncated: Boolean((results as any)?.truncated),
            durationMs: Date.now() - this.startedAt,
        });
        return exitCode;
    }

    async status(): Promise<number> {
        const cluster = await this.cluster();
        const entry = await this.cache.get(this.key(cluster.id));
        let liveness: Liveness | "missing" = "missing";
        if (entry) {
            liveness = await checkLiveness(this.ws.apiClient, entry);
            if (liveness === "lost") {
                await this.cache.delete(entry);
            }
        }
        const exitCode =
            liveness === "running" || liveness === "pending"
                ? EXIT_OK
                : EXIT_SESSION_MISSING;
        this.out.human(
            entry
                ? `Session '${this.name}' on cluster ${cluster.id}: ${liveness} (context ${entry.contextId}, created ${entry.createdAt}).`
                : `No session '${this.name}' on cluster ${cluster.id}.`
        );
        this.out.result({
            ...this.base(cluster.id),
            contextId: entry?.contextId,
            createdAt: entry?.createdAt,
            status: liveness,
            exitCode,
        });
        return exitCode;
    }

    async stop(): Promise<number> {
        const cluster = await this.cluster();
        const entry = await this.cache.get(this.key(cluster.id));
        if (!entry) {
            throw new SessionMissingError(
                `No session '${this.name}' on cluster ${cluster.id}.`
            );
        }
        try {
            await ExecutionContext.fromId(
                this.ws.apiClient,
                cluster,
                entry.contextId
            ).destroy();
        } catch (e) {
            // Already gone (e.g. cluster restarted): stopping is still done.
            if ((await checkLiveness(this.ws.apiClient, entry)) !== "lost") {
                throw e;
            }
        }
        await this.cache.delete(entry);
        this.out.human(`Session '${this.name}' stopped.`);
        this.out.result({
            ...this.base(cluster.id),
            contextId: entry.contextId,
            status: "stopped",
            exitCode: EXIT_OK,
        });
        return EXIT_OK;
    }

    async list(): Promise<number> {
        const live: Array<SessionEntry & {status: Liveness}> = [];
        for (const entry of await this.cache.listForBundle(
            this.ws.host,
            this.remoteRoot()
        )) {
            const liveness = await checkLiveness(this.ws.apiClient, entry);
            if (liveness === "lost") {
                await this.cache.delete(entry);
            } else {
                live.push({...entry, status: liveness});
            }
        }
        this.out.human(
            live.length === 0
                ? "No live sessions."
                : [
                      "NAME\tCLUSTER\tCONTEXT\tCREATED\tSTATUS",
                      ...live.map((e) =>
                          [
                              e.name,
                              e.clusterId,
                              e.contextId,
                              e.createdAt,
                              e.status,
                          ].join("\t")
                      ),
                  ].join("\n")
        );
        this.out.result({
            mode: "session",
            action: "list",
            sessions: live.map((e) => ({
                session: e.name,
                clusterId: e.clusterId,
                contextId: e.contextId,
                createdAt: e.createdAt,
                status: e.status,
            })),
            exitCode: EXIT_OK,
        });
        return EXIT_OK;
    }
}

export async function sessionCommand(
    args: SessionArgs,
    cts: CancellationSource,
    out: Output
): Promise<number> {
    const ws = await resolveBundleWorkspace([process.cwd()], args, out);
    const runner = new SessionRunner(args, ws, cts, out);
    switch (args.action) {
        case "create":
            return await runner.create();
        case "exec":
            return await runner.exec();
        case "status":
            return await runner.status();
        case "stop":
            return await runner.stop();
        case "list":
            return await runner.list();
    }
}
