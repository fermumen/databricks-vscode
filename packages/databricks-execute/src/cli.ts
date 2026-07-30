import {spawn} from "node:child_process";
import type {ChildProcess} from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import type {CancellationToken} from "@databricks/sdk-experimental";
import {
    ApiClient,
    ApiError,
    Time,
    TimeUnits,
    WorkspaceClient,
} from "@databricks/sdk-experimental";

import bootstrapTemplate from "../../databricks-vscode/resources/python/bootstrap.py";
import {parseErrorResult} from "../../databricks-vscode/src/run/ErrorParser";
import {
    Cluster,
    ExecutionContext,
    WorkflowRun,
} from "../../databricks-vscode/src/sdk-extensions";
import {
    coalesce,
    compileBootstrapCommand,
    createProgressReporter,
    detectNotebookType,
    extractNotebookTextOutputFromExportedHtml,
    htmlToPlainText,
    parseKeyValueOption,
    localPathToRemoteWorkspacePath,
    normalizeHost,
    normalizeWorkspacePath,
    remoteWorkspacePathToLocalPath,
    workspacePrefixedPath,
    isLikelyClusterId,
} from "./core";

let activeDatabricksCliProcess: ChildProcess | undefined;
const WAIT_HEARTBEAT_MS = 60_000;

type CliOptions = {
    target?: string;
    host?: string;
    token?: string;
    cluster?: string;
    serverless?: boolean;
    startCluster: boolean;
    contextId?: string;
    keepContext?: boolean;
    env: Record<string, string>;
    widgetParams: Record<string, string>;
};

class SimpleCancellationTokenSource {
    private listeners: Array<(e?: any) => any> = [];

    readonly token: CancellationToken = {
        isCancellationRequested: false,
        onCancellationRequested: (f: (e?: any) => any) => {
            this.listeners.push((e) => f(e));
        },
    };

    cancel(e?: any) {
        if (this.token.isCancellationRequested) {
            return;
        }
        this.token.isCancellationRequested = true;
        for (const l of this.listeners) {
            try {
                l(e);
            } catch {}
        }
    }
}

function printHelp() {
    // Keep this lightweight; the goal is a simple wrapper mirroring the VS Code command.
    // eslint-disable-next-line no-console
    console.log(
        [
            "Usage:",
            "  databricks-execute <path/to/file.py|file.ipynb> [options] [-- script args...]",
            "  databricks-execute init [--host <url>] [--cluster <id>] [--target <name>]",
            "",
            "Notes:",
            "  - Run 'databricks-execute init' to create or update databricks.yml with a dbexec target.",
            "  - .ipynb and 'Databricks notebook source' files run as workflow notebooks (Jobs API).",
            "  - Positional args and --env are only supported for plain .py files.",
            "  - --widget sets notebook widget/base parameters and is only supported for notebook runs.",
            "  - Long runs are supported: the CLI keeps waiting and prints periodic progress heartbeats.",
            "",
            "Options:",
            "  --target <name>        Bundle target (default: bundle default)",
            "  --host <url>           Databricks workspace host (or set DATABRICKS_HOST; default: from bundle)",
            "  --token <token>        Databricks PAT token (or set DATABRICKS_TOKEN; otherwise uses CLI auth)",
            "  --cluster <name|id>    Cluster name or cluster id (default: from bundle validate output)",
            "  --serverless           [Experimental] Use serverless compute (notebooks only; no cluster needed)",
            "  --start-cluster        Start cluster if not running (default: on)",
            "  --no-start-cluster     Do not auto-start a stopped cluster",
            "  --context-id <id>      Reuse an existing execution context (plain .py only)",
            "  --keep-context         Keep created execution context alive and print its id (plain .py only)",
            "  --env KEY=VALUE        Inject env var for the remote process (repeatable)",
            "  --widget KEY=VALUE     Set notebook widget/base parameter (repeatable)",
            "  --help                 Show help",
        ].join("\n")
    );
}

function fail(message: string): never {
    process.exitCode = 1;
    throw new Error(message);
}

type NormalizedApiErrorResponse = {
    logs?: string;
    error?: string;
    [key: string]: unknown;
};

function normalizeApiErrorResponse(
    e: unknown
): NormalizedApiErrorResponse | undefined {
    if (!(e instanceof ApiError)) {
        return undefined;
    }

    const response = e.response;
    if (typeof response === "string") {
        try {
            return JSON.parse(response) as NormalizedApiErrorResponse;
        } catch {
            return undefined;
        }
    }

    if (response && typeof response === "object") {
        return response as NormalizedApiErrorResponse;
    }

    return undefined;
}

function printApiErrorDetails(e: unknown): boolean {
    const response = normalizeApiErrorResponse(e);
    if (!response) {
        return false;
    }

    let printed = false;
    if (response.logs) {
        // eslint-disable-next-line no-console
        process.stdout.write(
            response.logs.endsWith("\n") ? response.logs : `${response.logs}\n`
        );
        printed = true;
    }
    if (response.error) {
        // eslint-disable-next-line no-console
        console.error(response.error);
        printed = true;
    }
    const errorTrace = response["error_trace"];
    if (typeof errorTrace === "string") {
        // eslint-disable-next-line no-console
        console.error(errorTrace);
        printed = true;
    }

    return printed;
}

function parseArgs(argv: string[]): {
    filePath?: string;
    options: CliOptions;
    scriptArgs: string[];
} {
    const delimiterIndex = argv.indexOf("--");
    const cliArgs =
        delimiterIndex === -1 ? argv : argv.slice(0, delimiterIndex);
    const scriptArgs =
        delimiterIndex === -1 ? [] : argv.slice(delimiterIndex + 1);

    const options: CliOptions = {
        env: {},
        widgetParams: {},
        startCluster: true,
    };
    let filePath: string | undefined;

    for (let i = 0; i < cliArgs.length; i++) {
        const a = cliArgs[i];

        if (a === "--help" || a === "-h") {
            printHelp();
            process.exit(0);
        }

        if (!a.startsWith("-") && filePath === undefined) {
            filePath = a;
            continue;
        }

        const next = () => {
            const v = cliArgs[i + 1];
            if (v === undefined) {
                fail(`Missing value for ${a}`);
            }
            i++;
            return v;
        };

        switch (a) {
            case "--target":
                options.target = next();
                break;
            case "--host":
                options.host = next();
                break;
            case "--token":
                options.token = next();
                break;
            case "--cluster":
                options.cluster = next();
                break;
            case "--serverless":
                options.serverless = true;
                break;
            case "--start-cluster":
                options.startCluster = true;
                break;
            case "--no-start-cluster":
                options.startCluster = false;
                break;
            case "--context-id":
                options.contextId = next();
                break;
            case "--keep-context":
                options.keepContext = true;
                break;
            case "--env": {
                const {key, value} = parseKeyValueOption(next(), "--env");
                options.env[key] = value;
                break;
            }
            case "--widget": {
                const {key, value} = parseKeyValueOption(next(), "--widget");
                options.widgetParams[key] = value;
                break;
            }
            default:
                fail(`Unknown argument: ${a}`);
        }
    }

    return {filePath, options, scriptArgs};
}

async function findBundleRoot(startDir: string): Promise<string | undefined> {
    const bundleFiles = [
        "databricks.yml",
        "databricks.yaml",
        "bundle.yml",
        "bundle.yaml",
    ];

    let current = path.resolve(startDir);
    while (true) {
        for (const f of bundleFiles) {
            try {
                await fs.access(path.join(current, f));
                return current;
            } catch {}
        }

        const parent = path.dirname(current);
        if (parent === current) {
            return undefined;
        }
        current = parent;
    }
}

function nowPrefix(message: string) {
    // eslint-disable-next-line no-console
    console.log(`${new Date().toLocaleString()} - ${message}`);
}

async function readFirstLine(filePath: string): Promise<string | undefined> {
    const fh = await fs.open(filePath, "r");
    try {
        const buf = Buffer.alloc(4096);
        const {bytesRead} = await fh.read(buf, 0, buf.length, 0);
        if (bytesRead <= 0) {
            return undefined;
        }
        const chunk = buf.toString("utf8", 0, bytesRead);
        return chunk.split(/\r?\n/u, 1)[0];
    } finally {
        await fh.close();
    }
}

async function runDatabricksCli(
    args: string[],
    options: {cwd: string; env: Record<string, string>; inherit?: boolean}
): Promise<{stdout: string; stderr: string; code: number}> {
    return await new Promise((resolve, reject) => {
        const child = spawn("databricks", args, {
            cwd: options.cwd,
            env: {...process.env, ...options.env},
            stdio: options.inherit ? "inherit" : "pipe",
        });
        activeDatabricksCliProcess = child;

        const stdout: string[] = [];
        const stderr: string[] = [];

        child.on("error", (err) => {
            if (activeDatabricksCliProcess === child) {
                activeDatabricksCliProcess = undefined;
            }
            reject(err);
        });

        if (child.stdout) {
            child.stdout.on("data", (d) => stdout.push(d.toString()));
        }
        if (child.stderr) {
            child.stderr.on("data", (d) => stderr.push(d.toString()));
        }

        child.on("close", (code) => {
            if (activeDatabricksCliProcess === child) {
                activeDatabricksCliProcess = undefined;
            }
            resolve({
                stdout: stdout.join(""),
                stderr: stderr.join(""),
                code: code ?? 0,
            });
        });
    });
}

async function main() {
    if (process.argv[2] === "init") {
        const {runInit} = await import("./init");
        await runInit(process.argv.slice(3));
        return;
    }

    const {filePath, options, scriptArgs} = parseArgs(process.argv.slice(2));
    if (!filePath) {
        printHelp();
        process.exit(1);
    }

    const startedAt = Date.now();
    const cts = new SimpleCancellationTokenSource();
    let sigintCount = 0;
    let forceExitTimer: NodeJS.Timeout | undefined;
    process.on("SIGINT", () => {
        sigintCount += 1;
        if (cts.token.isCancellationRequested) {
            if (sigintCount >= 2) {
                process.exit(130);
            }
            return;
        }
        nowPrefix("Cancellation requested. Attempting to stop execution...");
        if (activeDatabricksCliProcess && !activeDatabricksCliProcess.killed) {
            try {
                activeDatabricksCliProcess.kill("SIGINT");
            } catch {}
        }
        cts.cancel();
        forceExitTimer =
            forceExitTimer ?? setTimeout(() => process.exit(130), 5000);
        forceExitTimer.unref();
    });

    const absoluteFilePath = path.resolve(filePath);
    try {
        const st = await fs.stat(absoluteFilePath);
        if (!st.isFile()) {
            fail(`Not a file: ${absoluteFilePath}`);
        }
    } catch {
        fail(`File not found: ${absoluteFilePath}`);
    }

    const fileExt = path.extname(absoluteFilePath).replace(/^\./u, "");
    const firstLine =
        fileExt &&
        fileExt !== "ipynb" &&
        ["py", "scala", "sql", "r"].includes(fileExt.toLowerCase())
            ? await readFirstLine(absoluteFilePath)
            : undefined;
    const notebookType = detectNotebookType(fileExt, firstLine);
    const isPlainPythonFile = !notebookType && fileExt.toLowerCase() === "py";
    if (!notebookType && Object.keys(options.widgetParams).length > 0) {
        fail(
            "--widget is only supported for notebooks (.ipynb or 'Databricks notebook source' files)."
        );
    }
    if (options.contextId && options.keepContext) {
        fail("--context-id and --keep-context cannot be used together.");
    }
    if (options.contextId && !isPlainPythonFile) {
        fail("--context-id is only supported for plain .py files.");
    }
    if (options.keepContext && !isPlainPythonFile) {
        fail("--keep-context is only supported for plain .py files.");
    }

    const bundleRoot =
        (await findBundleRoot(path.dirname(absoluteFilePath))) ??
        (await findBundleRoot(process.cwd()));
    if (!bundleRoot) {
        fail(
            "Could not find bundle root (expected databricks.yml/bundle.yml in a parent directory)."
        );
    }

    const target = coalesce(
        options.target,
        process.env.DATABRICKS_BUNDLE_TARGET
    );

    const clusterSpec = options.cluster;

    if (options.serverless && clusterSpec) {
        fail("--serverless and --cluster are mutually exclusive.");
    }

    const hostOverrideRaw = coalesce(options.host, process.env.DATABRICKS_HOST);
    const tokenOverride = coalesce(options.token, process.env.DATABRICKS_TOKEN);

    const env: Record<string, string> = {};
    if (hostOverrideRaw) {
        // eslint-disable-next-line @typescript-eslint/naming-convention
        env.DATABRICKS_HOST = normalizeHost(hostOverrideRaw);
    }
    if (tokenOverride) {
        // eslint-disable-next-line @typescript-eslint/naming-convention
        env.DATABRICKS_TOKEN = tokenOverride;
    }

    // Validate that the Databricks CLI exists early.
    try {
        const versionRes = await runDatabricksCli(["--version"], {
            cwd: bundleRoot,
            env,
        });
        if (versionRes.code !== 0) {
            fail(
                `Databricks CLI check failed. stderr:\n${
                    versionRes.stderr || versionRes.stdout
                }`
            );
        }
    } catch (e: any) {
        if (e?.code === "ENOENT") {
            fail(
                "Databricks CLI not found on PATH. Install it first (the VS Code extension bundles it, this CLI does not)."
            );
        }
        throw e;
    }

    nowPrefix("Reading bundle configuration...");
    const validateArgs = [
        "bundle",
        "validate",
        ...(target ? ["--target", target] : []),
        "--output",
        "json",
    ];
    const validate = await runDatabricksCli(validateArgs, {
        cwd: bundleRoot,
        env,
    });
    if (validate.code !== 0) {
        fail(`bundle validate failed:\n${validate.stderr || validate.stdout}`);
    }

    let validateJson: any;
    try {
        validateJson = JSON.parse(validate.stdout);
    } catch {
        const start = validate.stdout.indexOf("{");
        const end = validate.stdout.lastIndexOf("}");
        if (start !== -1 && end !== -1 && end > start) {
            try {
                validateJson = JSON.parse(
                    validate.stdout.slice(start, end + 1)
                );
            } catch {}
        }
        if (!validateJson) {
            fail(
                `Failed to parse 'databricks bundle validate' output as JSON. Output:\n${validate.stdout}`
            );
        }
    }

    if (validateJson?.mode && validateJson.mode !== "development") {
        fail(
            `Bundle target mode is '${validateJson.mode}'. This tool only supports 'development' (mirrors VS Code run behavior).`
        );
    }

    const hostFromBundle = coalesce(
        validateJson?.workspace?.host as string | undefined,
        validateJson?.workspace?.workspace_host as string | undefined
    );
    const host = coalesce(env.DATABRICKS_HOST, hostFromBundle);
    const workspaceIdFromBundle = coalesce(
        validateJson?.workspace?.workspace_id as string | undefined,
        validateJson?.workspace?.workspaceId as string | undefined
    );
    if (workspaceIdFromBundle && !env.DATABRICKS_WORKSPACE_ID) {
        env.DATABRICKS_WORKSPACE_ID = workspaceIdFromBundle;
    }
    if (!host) {
        fail(
            "Missing Databricks host. Provide --host, set DATABRICKS_HOST, or set workspace.host in the bundle target."
        );
    }

    const remoteRootPath = validateJson?.workspace?.file_path as
        | string
        | undefined;
    if (!remoteRootPath) {
        fail(
            "Could not determine workspace file path from bundle validate output (expected workspace.file_path)."
        );
    }

    nowPrefix("Uploading assets to Databricks workspace...");
    const syncArgs = [
        "bundle",
        "sync",
        ...(target ? ["--target", target] : []),
        "--output",
        "text",
    ];
    const sync = await runDatabricksCli(syncArgs, {
        cwd: bundleRoot,
        env,
        inherit: true,
    });
    if (sync.code !== 0) {
        fail("bundle sync failed.");
    }

    // If no explicit token was provided, resolve it from the Databricks CLI's
    // auth chain (reads ~/.databrickscfg, Azure CLI, etc.) so that the
    // WorkspaceClient authenticates as the same identity used by bundle sync.
    let resolvedToken = tokenOverride;
    if (!resolvedToken) {
        try {
            const authEnv = await runDatabricksCli(
                ["auth", "env", "--host", host, "-o", "json"],
                {cwd: bundleRoot, env}
            );
            if (authEnv.code === 0) {
                const authJson = JSON.parse(authEnv.stdout);
                if (authJson?.env?.DATABRICKS_TOKEN) {
                    resolvedToken = authJson.env.DATABRICKS_TOKEN;
                }
            }
        } catch {
            // Fall through to SDK default auth chain
        }
    }

    const wsClient = new WorkspaceClient(
        resolvedToken ? {host, token: resolvedToken, authType: "pat"} : {host}
    );
    const apiClient: ApiClient = wsClient.apiClient;

    let cluster: Cluster | undefined;
    if (!options.serverless) {
        const clusterIdFromBundle =
            (validateJson?.bundle?.compute_id as string | undefined) ??
            (validateJson?.bundle?.cluster_id as string | undefined);

        if (clusterSpec) {
            if (isLikelyClusterId(clusterSpec)) {
                cluster = await Cluster.fromClusterId(apiClient, clusterSpec);
            } else {
                cluster = await Cluster.fromClusterName(apiClient, clusterSpec);
            }
        } else if (clusterIdFromBundle) {
            cluster = await Cluster.fromClusterId(
                apiClient,
                clusterIdFromBundle
            );
        }

        if (!cluster) {
            fail(
                "No cluster configured. Provide --cluster (name or id), set cluster_id / bundle.compute_id in databricks.yml target, or use --serverless for notebooks."
            );
        }

        await cluster.refresh();
        if (!["RUNNING", "RESIZING"].includes(cluster.state)) {
            if (options.startCluster) {
                nowPrefix(
                    `Starting cluster ${cluster.name} (${cluster.id})...`
                );
                await cluster.start(
                    cts.token,
                    createProgressReporter(
                        (state) => nowPrefix(`Cluster state: ${state}`),
                        WAIT_HEARTBEAT_MS
                    )
                );
            } else {
                fail(
                    `Cluster is ${cluster.state}. Start it and retry, or pass --start-cluster.`
                );
            }
        }
    }

    const remotePythonFile = localPathToRemoteWorkspacePath(
        absoluteFilePath,
        bundleRoot,
        remoteRootPath
    );
    const remoteRepoRoot = workspacePrefixedPath(remoteRootPath);

    if (notebookType) {
        if (scriptArgs.length > 0) {
            fail(
                "Notebook mode does not support positional args. Use --widget KEY=VALUE to set notebook widget/base parameters instead."
            );
        }
        if (Object.keys(options.env).length > 0) {
            fail(
                "Notebook mode does not support --env. Use cluster init scripts or set env vars within the notebook instead."
            );
        }

        const remoteNotebookPath = normalizeWorkspacePath(
            remotePythonFile
        ).replace(/\.(py|ipynb|scala|r|sql)$/iu, "");

        const computeLabel = options.serverless
            ? "serverless"
            : `cluster ${cluster!.id}`;
        nowPrefix(
            `Running ${path.relative(
                bundleRoot,
                absoluteFilePath
            )} as workflow notebook (${notebookType}) on ${computeLabel} ...`
        );

        /* eslint-disable @typescript-eslint/naming-convention */
        const task: Record<string, unknown> = {
            task_key: "databricks_execute_notebook",
            notebook_task: {
                notebook_path: remoteNotebookPath,
                base_parameters: options.widgetParams,
            },
            timeout_seconds: 0,
        };
        if (options.serverless) {
            task.environment_key = "databricks_execute_serverless";
        } else {
            task.existing_cluster_id = cluster!.id;
        }
        const submitRequest: Record<string, unknown> = {
            timeout_seconds: 0,
            tasks: [task],
        };
        if (options.serverless) {
            submitRequest.environments = [
                {
                    environment_key: "databricks_execute_serverless",
                    spec: {client: "1"},
                },
            ];
        }
        let run: WorkflowRun;
        try {
            run = await WorkflowRun.submitRun(apiClient, submitRequest as any);
        } catch (e) {
            printApiErrorDetails(e);
            throw e;
        }
        /* eslint-enable @typescript-eslint/naming-convention */

        if (run.runPageUrl) {
            nowPrefix(`Run URL: ${run.runPageUrl}`);
        } else if (run.details.run_id !== undefined) {
            nowPrefix(`Run ID: ${run.details.run_id}`);
        }

        await run.wait(
            createProgressReporter(
                (state) => nowPrefix(`Run state: ${state}`),
                WAIT_HEARTBEAT_MS
            ),
            cts.token
        );

        const resultState = run.state?.result_state;
        const stateMessage = run.state?.state_message;
        if (resultState) {
            nowPrefix(`Run result: ${resultState}`);
        }
        if (stateMessage) {
            nowPrefix(`Run message: ${stateMessage}`);
        }

        let printedOutput = false;
        let printedError = false;
        try {
            const exported = await run.export();
            const views = exported.views ?? [];
            const view = views.find((v) => (v as any)?.content) as
                | {content?: string; name?: string}
                | undefined;
            if (view?.content) {
                const extracted = extractNotebookTextOutputFromExportedHtml(
                    view.content
                );
                if (extracted) {
                    if (extracted.stdout) {
                        // eslint-disable-next-line no-console
                        process.stdout.write(
                            extracted.stdout.endsWith("\n")
                                ? extracted.stdout
                                : `${extracted.stdout}\n`
                        );
                        printedOutput = true;
                    }
                    if (extracted.stderr) {
                        // eslint-disable-next-line no-console
                        process.stderr.write(
                            extracted.stderr.endsWith("\n")
                                ? extracted.stderr
                                : `${extracted.stderr}\n`
                        );
                        printedOutput = true;
                        printedError = true;
                    }
                    if (extracted.error) {
                        // eslint-disable-next-line no-console
                        process.stderr.write(
                            extracted.error.endsWith("\n")
                                ? extracted.error
                                : `${extracted.error}\n`
                        );
                        printedOutput = true;
                        printedError = true;
                    }
                } else {
                    const text = htmlToPlainText(view.content);
                    if (text) {
                        // eslint-disable-next-line no-console
                        process.stdout.write(`${text}\n`);
                        printedOutput = true;
                    }
                }
            }
        } catch (e) {
            printApiErrorDetails(e);
        }

        try {
            const output = await run.getOutput();
            const notebookOutput = (output as any)?.notebook_output?.result as
                | string
                | undefined;
            const notebookTruncated = Boolean(
                (output as any)?.notebook_output?.truncated
            );
            if (!printedOutput && notebookOutput) {
                // eslint-disable-next-line no-console
                process.stdout.write(
                    notebookTruncated
                        ? `${notebookOutput}\n\n[Notebook output truncated]\n`
                        : `${notebookOutput}\n`
                );
                printedOutput = true;
            }
            if (!printedError && output.error) {
                // eslint-disable-next-line no-console
                console.error(output.error);
                printedError = true;
            }
            if (!printedError && (output as any).error_trace) {
                // eslint-disable-next-line no-console
                console.error((output as any).error_trace);
                printedError = true;
            }
        } catch (e) {
            printApiErrorDetails(e);
        }

        const normalizedResultState = resultState?.toUpperCase();
        const exitCode =
            cts.token.isCancellationRequested &&
            (normalizedResultState === "CANCELED" ||
                normalizedResultState === "CANCELLED")
                ? 130
                : resultState === "SUCCESS"
                  ? 0
                  : 1;
        nowPrefix(`Done (took ${Date.now() - startedAt}ms)`);
        process.exitCode = exitCode;
        return;
    }

    if (options.serverless) {
        fail(
            "Serverless compute is not supported for plain .py files (the Command Execution API requires a cluster).\n" +
                "Use --serverless with notebooks (.ipynb or 'Databricks notebook source' files), or remove --serverless and provide a cluster."
        );
    }

    const shouldKeepExecutionContext =
        Boolean(options.contextId) || options.keepContext === true;
    let executionContext: ExecutionContext;
    if (options.contextId) {
        nowPrefix(
            `Reusing execution context ${options.contextId} on cluster ${
                cluster!.id
            } ...`
        );
        executionContext = ExecutionContext.fromId(
            apiClient,
            cluster!,
            options.contextId,
            "python"
        );
    } else {
        nowPrefix(`Creating execution context on cluster ${cluster!.id} ...`);
        executionContext = await cluster!.createExecutionContext("python");
        if (options.keepContext && executionContext.id) {
            nowPrefix(`Execution context ID: ${executionContext.id}`);
        }
    }
    if (!shouldKeepExecutionContext) {
        cts.token.onCancellationRequested(async () => {
            try {
                await executionContext.destroy();
            } catch {}
        });
    }

    try {
        nowPrefix(
            `Running ${path.relative(bundleRoot, absoluteFilePath)} ...\n`
        );

        const command = compileBootstrapCommand(bootstrapTemplate, {
            remotePythonFile,
            remoteRepoRoot,
            argv: [remotePythonFile, ...scriptArgs],
            envVars: options.env,
            persistContextState: shouldKeepExecutionContext,
        });

        const reportCommandStatus = createProgressReporter(
            (status) => nowPrefix(`Command status: ${status}`),
            WAIT_HEARTBEAT_MS
        );
        const response = await executionContext.execute(
            command,
            (status) => reportCommandStatus(status.status ?? "Unknown"),
            cts.token,
            new Time(240, TimeUnits.hours)
        );

        const result = response.result;
        const results = result.results!;

        let exitCode = 0;
        if (results.resultType === "text") {
            // eslint-disable-next-line no-console
            process.stdout.write(String((results as any).data ?? ""));
            exitCode = 0;
        } else if (results.resultType === "error") {
            const frames = parseErrorResult(results);
            for (const frame of frames) {
                try {
                    if (frame.file) {
                        const mapped = remoteWorkspacePathToLocalPath(
                            frame.file,
                            bundleRoot,
                            remoteRootPath
                        );
                        if (mapped) {
                            frame.text = frame.text.replace(frame.file, mapped);
                        }
                    }
                } catch {}

                // eslint-disable-next-line no-console
                console.log(frame.text);
            }
            exitCode = 1;
        } else {
            // eslint-disable-next-line no-console
            console.log(JSON.stringify(results as any, null, 2));
            exitCode = 0;
        }

        nowPrefix(`Done (took ${Date.now() - startedAt}ms)`);
        process.exitCode = exitCode;
    } finally {
        if (!shouldKeepExecutionContext) {
            await executionContext.destroy();
        }
    }
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises
main().catch((e: any) => {
    if (e?.message) {
        // eslint-disable-next-line no-console
        console.error(e.message);
    } else {
        // eslint-disable-next-line no-console
        console.error(e);
    }
    process.exitCode = process.exitCode ?? 1;
});
