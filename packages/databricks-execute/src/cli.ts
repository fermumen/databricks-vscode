import {spawn} from "node:child_process";
import type {ChildProcess} from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import type {CancellationToken} from "@databricks/databricks-sdk";
import {
    ApiClient,
    Time,
    TimeUnits,
    WorkspaceClient,
} from "@databricks/databricks-sdk";

import bootstrapTemplate from "../../databricks-vscode/resources/python/bootstrap.py";
import {parseErrorResult} from "../../databricks-vscode/src/run/ErrorParser";
import {Cluster} from "../../databricks-vscode/src/sdk-extensions/Cluster";
import {
    coalesce,
    compileBootstrapCommand,
    localPathToRemoteWorkspacePath,
    normalizeHost,
    parseDotConfig,
    remoteWorkspacePathToLocalPath,
    workspacePrefixedPath,
    isLikelyClusterId,
} from "./core";

let activeDatabricksCliProcess: ChildProcess | undefined;

type CliOptions = {
    configPath?: string;
    target?: string;
    host?: string;
    token?: string;
    cluster?: string;
    startCluster?: boolean;
    noSync?: boolean;
    env: Record<string, string>;
};

type ExecuteConfig = {
    host?: string;
    token?: string;
    target?: string;
    cluster?: string;
};

class SimpleCancellationTokenSource {
    private listeners: Array<(e?: any) => any> = [];

    readonly token: CancellationToken = {
        isCancellationRequested: false,
        onCancellationRequested: (f: (e?: any) => any, ...args: any[]) => {
            this.listeners.push((e) => f(e, ...args));
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
            "  databricks-execute <path/to/file.py> [options] -- [script args...]",
            "",
            "Options:",
            "  --config <path>        Path to .config file (default: <bundleRoot>/.config)",
            "  --target <name>        Bundle target (default: from .config or bundle default)",
            "  --host <url>           Databricks workspace host (or set DATABRICKS_HOST; default: from bundle)",
            "  --token <token>        Databricks PAT token (or set DATABRICKS_TOKEN; otherwise uses CLI auth)",
            "  --cluster <name|id>    Cluster name or cluster id (default: from bundle validate output)",
            "  --start-cluster        Start cluster if not running",
            "  --no-sync              Skip 'databricks bundle sync' step",
            "  --env KEY=VALUE        Inject env var for the remote process (repeatable)",
            "  --help                 Show help",
        ].join("\n")
    );
}

function fail(message: string): never {
    process.exitCode = 1;
    throw new Error(message);
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

    const options: CliOptions = {env: {}};
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
            case "--config":
                options.configPath = next();
                break;
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
            case "--start-cluster":
                options.startCluster = true;
                break;
            case "--no-sync":
                options.noSync = true;
                break;
            case "--env": {
                const kv = next();
                const eq = kv.indexOf("=");
                if (eq <= 0) {
                    fail("Invalid --env value (expected KEY=VALUE)");
                }
                const key = kv.slice(0, eq);
                const value = kv.slice(eq + 1);
                options.env[key] = value;
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

    const bundleRoot =
        (await findBundleRoot(path.dirname(absoluteFilePath))) ??
        (await findBundleRoot(process.cwd()));
    if (!bundleRoot) {
        fail(
            "Could not find bundle root (expected databricks.yml/bundle.yml in a parent directory)."
        );
    }

    const defaultConfigPath = path.join(bundleRoot, ".config");
    const configPath = options.configPath
        ? path.resolve(options.configPath)
        : defaultConfigPath;

    let config: ExecuteConfig = {};
    try {
        const raw = await fs.readFile(configPath, "utf8");
        const parsed = parseDotConfig(raw);

        config = {
            host: coalesce(parsed.host, parsed.DATABRICKS_HOST),
            token: coalesce(parsed.token, parsed.DATABRICKS_TOKEN),
            target: coalesce(parsed.target, parsed.DATABRICKS_BUNDLE_TARGET),
            cluster: coalesce(
                parsed.cluster,
                parsed.clusterName,
                parsed.cluster_id,
                parsed.clusterId,
                parsed.DATABRICKS_CLUSTER,
                parsed.DATABRICKS_CLUSTER_ID
            ),
        };
    } catch (e: any) {
        if (configPath !== defaultConfigPath) {
            throw e;
        }
        // No default config file is fine; fall back to env + CLI flags.
    }

    const target = coalesce(
        options.target,
        config.target,
        process.env.DATABRICKS_BUNDLE_TARGET
    );

    const clusterSpec = coalesce(options.cluster, config.cluster);

    const hostOverrideRaw = coalesce(
        options.host,
        config.host,
        process.env.DATABRICKS_HOST
    );
    const tokenOverride = coalesce(
        options.token,
        config.token,
        process.env.DATABRICKS_TOKEN
    );

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
    } catch (e) {
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

    if (!options.noSync) {
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
    }

    const wsClient = new WorkspaceClient(
        tokenOverride ? {host, token: tokenOverride, authType: "pat"} : {host}
    );
    const apiClient: ApiClient = wsClient.apiClient;

    let cluster: Cluster | undefined;
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
        cluster = await Cluster.fromClusterId(apiClient, clusterIdFromBundle);
    }

    if (!cluster) {
        fail(
            "No cluster configured. Provide --cluster (name or id), add `cluster=` to .config, or set bundle.compute_id/cluster_id."
        );
    }

    await cluster.refresh();
    if (!["RUNNING", "RESIZING"].includes(cluster.state)) {
        if (options.startCluster) {
            nowPrefix(`Starting cluster ${cluster.name} (${cluster.id})...`);
            await cluster.start(cts.token, (state) => {
                nowPrefix(`Cluster state: ${state}`);
            });
        } else {
            fail(
                `Cluster is ${cluster.state}. Start it and retry, or pass --start-cluster.`
            );
        }
    }

    const remotePythonFile = localPathToRemoteWorkspacePath(
        absoluteFilePath,
        bundleRoot,
        remoteRootPath
    );
    const remoteRepoRoot = workspacePrefixedPath(remoteRootPath);

    nowPrefix(`Creating execution context on cluster ${cluster.id} ...`);
    const executionContext = await cluster.createExecutionContext("python");
    cts.token.onCancellationRequested(async () => {
        try {
            await executionContext.destroy();
        } catch {}
    });

    try {
        nowPrefix(
            `Running ${path.relative(bundleRoot, absoluteFilePath)} ...\n`
        );

        const command = compileBootstrapCommand(bootstrapTemplate, {
            remotePythonFile,
            remoteRepoRoot,
            argv: [remotePythonFile, ...scriptArgs],
            envVars: options.env,
        });

        const response = await executionContext.execute(
            command,
            undefined,
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
        await executionContext.destroy();
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
