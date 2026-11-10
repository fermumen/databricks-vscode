import {spawn} from "node:child_process";
import type {ChildProcess} from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import type {CancellationToken} from "@databricks/sdk-experimental";
import {ApiClient, WorkspaceClient} from "@databricks/sdk-experimental";

import {Cluster} from "../../databricks-vscode/src/sdk-extensions";
import {
    coalesce,
    createProgressReporter,
    isLikelyClusterId,
    normalizeHost,
} from "./core";
import {Output, UsageError} from "./output";

export const WAIT_HEARTBEAT_MS = 60_000;

let activeDatabricksCliProcess: ChildProcess | undefined;

/** Forward Ctrl+C to a running `databricks` child process. */
export function interruptDatabricksCli() {
    if (activeDatabricksCliProcess && !activeDatabricksCliProcess.killed) {
        try {
            activeDatabricksCliProcess.kill("SIGINT");
        } catch {}
    }
}

export type ConnectionOptions = {
    target?: string;
    host?: string;
    token?: string;
};

/** A resolved bundle and an authenticated client for its workspace. */
export type BundleWorkspace = {
    bundleRoot: string;
    target?: string;
    host: string;
    /** `workspace.file_path` from `bundle validate`, as the bundle reports it. */
    remoteRootPath: string;
    /** Extra env for `databricks` CLI calls (host/token overrides). */
    cliEnv: Record<string, string>;
    clusterIdFromBundle?: string;
    wsClient: WorkspaceClient;
    apiClient: ApiClient;
};

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

/**
 * Run the Databricks CLI. With `passthrough`, its output streams to our
 * stderr (never stdout, which is reserved for program output).
 */
export async function runDatabricksCli(
    args: string[],
    options: {cwd: string; env: Record<string, string>; passthrough?: boolean}
): Promise<{stdout: string; stderr: string; code: number}> {
    return await new Promise((resolve, reject) => {
        const child = spawn("databricks", args, {
            cwd: options.cwd,
            env: {...process.env, ...options.env},
            stdio: options.passthrough ? ["ignore", 2, 2] : "pipe",
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

        child.stdout?.on("data", (d) => stdout.push(d.toString()));
        child.stderr?.on("data", (d) => stderr.push(d.toString()));

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

function parseValidateOutput(stdout: string): any {
    try {
        return JSON.parse(stdout);
    } catch {
        const start = stdout.indexOf("{");
        const end = stdout.lastIndexOf("}");
        if (start !== -1 && end > start) {
            try {
                return JSON.parse(stdout.slice(start, end + 1));
            } catch {}
        }
    }
    throw new Error(
        `Failed to parse 'databricks bundle validate' output as JSON. Output:\n${stdout}`
    );
}

/**
 * Find the bundle, read its configuration with `bundle validate`, and build a
 * client authenticated as the same identity the Databricks CLI uses.
 */
export async function resolveBundleWorkspace(
    startDirs: string[],
    options: ConnectionOptions,
    out: Output
): Promise<BundleWorkspace> {
    let bundleRoot: string | undefined;
    for (const dir of startDirs) {
        bundleRoot = await findBundleRoot(dir);
        if (bundleRoot) {
            break;
        }
    }
    if (!bundleRoot) {
        throw new UsageError(
            "Could not find bundle root (expected databricks.yml/bundle.yml in a parent directory). Run 'databricks-execute init' to create one."
        );
    }

    const target = coalesce(
        options.target,
        process.env.DATABRICKS_BUNDLE_TARGET
    );
    const hostOverride = coalesce(options.host, process.env.DATABRICKS_HOST);
    const tokenOverride = coalesce(options.token, process.env.DATABRICKS_TOKEN);

    const cliEnv: Record<string, string> = {};
    if (hostOverride) {
        // eslint-disable-next-line @typescript-eslint/naming-convention
        cliEnv.DATABRICKS_HOST = normalizeHost(hostOverride);
    }
    if (tokenOverride) {
        // eslint-disable-next-line @typescript-eslint/naming-convention
        cliEnv.DATABRICKS_TOKEN = tokenOverride;
    }

    try {
        const versionRes = await runDatabricksCli(["--version"], {
            cwd: bundleRoot,
            env: cliEnv,
        });
        if (versionRes.code !== 0) {
            throw new Error(
                `Databricks CLI check failed. stderr:\n${
                    versionRes.stderr || versionRes.stdout
                }`
            );
        }
    } catch (e: any) {
        if (e?.code === "ENOENT") {
            throw new Error(
                "Databricks CLI not found on PATH. Install it first (the VS Code extension bundles it, this CLI does not)."
            );
        }
        throw e;
    }

    out.status("Reading bundle configuration...");
    const validate = await runDatabricksCli(
        [
            "bundle",
            "validate",
            ...(target ? ["--target", target] : []),
            "--output",
            "json",
        ],
        {cwd: bundleRoot, env: cliEnv}
    );
    if (validate.code !== 0) {
        throw new Error(
            `bundle validate failed:\n${validate.stderr || validate.stdout}`
        );
    }
    const validateJson = parseValidateOutput(validate.stdout);

    if (validateJson?.mode && validateJson.mode !== "development") {
        throw new UsageError(
            `Bundle target mode is '${validateJson.mode}'. This tool only supports 'development' (mirrors VS Code run behavior).`
        );
    }

    const host = coalesce(
        cliEnv.DATABRICKS_HOST,
        validateJson?.workspace?.host as string | undefined,
        validateJson?.workspace?.workspace_host as string | undefined
    );
    if (!host) {
        throw new UsageError(
            "Missing Databricks host. Provide --host, set DATABRICKS_HOST, or set workspace.host in the bundle target."
        );
    }
    const workspaceId = coalesce(
        validateJson?.workspace?.workspace_id as string | undefined,
        validateJson?.workspace?.workspaceId as string | undefined
    );
    if (workspaceId && !cliEnv.DATABRICKS_WORKSPACE_ID) {
        // eslint-disable-next-line @typescript-eslint/naming-convention
        cliEnv.DATABRICKS_WORKSPACE_ID = workspaceId;
    }

    const remoteRootPath = validateJson?.workspace?.file_path as
        | string
        | undefined;
    if (!remoteRootPath) {
        throw new Error(
            "Could not determine workspace file path from bundle validate output (expected workspace.file_path)."
        );
    }

    // Without an explicit token, take one from the Databricks CLI's auth
    // chain (~/.databrickscfg, Azure CLI, ...) so the SDK client acts as the
    // same identity as `bundle sync`.
    let resolvedToken = tokenOverride;
    if (!resolvedToken) {
        try {
            const authEnv = await runDatabricksCli(
                ["auth", "env", "--host", host, "-o", "json"],
                {cwd: bundleRoot, env: cliEnv}
            );
            if (authEnv.code === 0) {
                resolvedToken = JSON.parse(authEnv.stdout)?.env
                    ?.DATABRICKS_TOKEN;
            }
        } catch {
            // Fall through to the SDK's default auth chain.
        }
    }

    const wsClient = new WorkspaceClient(
        resolvedToken ? {host, token: resolvedToken, authType: "pat"} : {host}
    );

    return {
        bundleRoot,
        target,
        host,
        remoteRootPath,
        cliEnv,
        clusterIdFromBundle:
            (validateJson?.bundle?.compute_id as string | undefined) ??
            (validateJson?.bundle?.cluster_id as string | undefined),
        wsClient,
        apiClient: wsClient.apiClient,
    };
}

export async function syncBundle(ws: BundleWorkspace, out: Output) {
    out.status("Uploading assets to Databricks workspace...");
    const sync = await runDatabricksCli(
        [
            "bundle",
            "sync",
            ...(ws.target ? ["--target", ws.target] : []),
            "--output",
            "text",
        ],
        {cwd: ws.bundleRoot, env: ws.cliEnv, passthrough: true}
    );
    if (sync.code !== 0) {
        throw new Error("bundle sync failed.");
    }
}

/** The cluster named by `--cluster`, or the bundle target's cluster. */
export async function resolveCluster(
    ws: BundleWorkspace,
    clusterSpec: string | undefined,
    missingHint: string
): Promise<Cluster> {
    let cluster: Cluster | undefined;
    if (clusterSpec) {
        cluster = isLikelyClusterId(clusterSpec)
            ? await Cluster.fromClusterId(ws.apiClient, clusterSpec)
            : await Cluster.fromClusterName(ws.apiClient, clusterSpec);
        if (!cluster) {
            throw new UsageError(`Cluster '${clusterSpec}' not found.`);
        }
    } else if (ws.clusterIdFromBundle) {
        cluster = await Cluster.fromClusterId(
            ws.apiClient,
            ws.clusterIdFromBundle
        );
    }
    if (!cluster) {
        throw new UsageError(
            `No cluster configured. Provide --cluster (name or id) or set cluster_id / bundle.compute_id in the databricks.yml target${missingHint}.`
        );
    }
    return cluster;
}

export async function ensureClusterRunning(
    cluster: Cluster,
    startCluster: boolean,
    token: CancellationToken,
    out: Output
) {
    await cluster.refresh();
    if (["RUNNING", "RESIZING"].includes(cluster.state)) {
        return;
    }
    if (!startCluster) {
        throw new Error(
            `Cluster is ${cluster.state}. Start it and retry, or drop --no-start-cluster.`
        );
    }
    out.status(`Starting cluster ${cluster.name} (${cluster.id})...`);
    await cluster.start(
        token,
        createProgressReporter(
            (state) => out.status(`Cluster state: ${state}`),
            WAIT_HEARTBEAT_MS
        )
    );
}
