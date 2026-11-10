import {parseKeyValueOption, parseTimeoutSeconds} from "./core";
import {UsageError} from "./output";

export type CommonOptions = {
    target?: string;
    host?: string;
    token?: string;
    cluster?: string;
    startCluster: boolean;
    json: boolean;
};

export type RunArgs = CommonOptions & {
    command: "run";
    file?: string;
    serverless: boolean;
    widgets: Record<string, string>;
    timeoutSeconds?: number;
    scriptArgs: string[];
};

export type ParsedArgs = {command: "help"} | RunArgs;

const REMOVED_FLAGS: Record<string, string> = {
    "--keep-context":
        "--keep-context was removed in 3.0.0. Use 'databricks-execute session create' and 'session exec' to keep state between snippets.",
    "--context-id":
        "--context-id was removed in 3.0.0. Use named sessions instead: 'databricks-execute session exec -s <name> -c <code>'.",
    "--env":
        "--env was removed in 3.0.0. Pass values as script args (-- arg1 arg2) or, for notebooks, with --widget KEY=VALUE.",
};

/** Walks the args, handing flags we don't own back to `handle`. */
function walk(
    argv: string[],
    common: CommonOptions,
    handle: (arg: string, next: () => string) => boolean
) {
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = () => {
            const v = argv[i + 1];
            if (v === undefined) {
                throw new UsageError(`Missing value for ${a}`);
            }
            i++;
            return v;
        };

        if (REMOVED_FLAGS[a]) {
            throw new UsageError(REMOVED_FLAGS[a]);
        }

        switch (a) {
            case "--target":
                common.target = next();
                continue;
            case "--host":
                common.host = next();
                continue;
            case "--token":
                common.token = next();
                continue;
            case "--cluster":
                common.cluster = next();
                continue;
            case "--start-cluster":
                common.startCluster = true;
                continue;
            case "--no-start-cluster":
                common.startCluster = false;
                continue;
            case "--json":
                common.json = true;
                continue;
        }

        if (!handle(a, next)) {
            throw new UsageError(`Unknown argument: ${a}`);
        }
    }
}

function wrapUsage<T>(fn: () => T): T {
    try {
        return fn();
    } catch (e) {
        if (e instanceof Error && !(e instanceof UsageError)) {
            throw new UsageError(e.message);
        }
        throw e;
    }
}

function defaultCommon(): CommonOptions {
    return {startCluster: true, json: false};
}

function parseRun(argv: string[]): RunArgs {
    const delimiterIndex = argv.indexOf("--");
    const cliArgs =
        delimiterIndex === -1 ? argv : argv.slice(0, delimiterIndex);
    const args: RunArgs = {
        ...defaultCommon(),
        command: "run",
        serverless: false,
        widgets: {},
        scriptArgs: delimiterIndex === -1 ? [] : argv.slice(delimiterIndex + 1),
    };

    walk(cliArgs, args, (a, next) => {
        switch (a) {
            case "--serverless":
                args.serverless = true;
                return true;
            case "--widget": {
                const {key, value} = wrapUsage(() =>
                    parseKeyValueOption(next(), "--widget")
                );
                args.widgets[key] = value;
                return true;
            }
            case "--timeout":
                args.timeoutSeconds = wrapUsage(() =>
                    parseTimeoutSeconds(next())
                );
                return true;
        }
        if (!a.startsWith("-") && args.file === undefined) {
            args.file = a;
            return true;
        }
        return false;
    });

    if (!args.file) {
        throw new UsageError("Missing file to run.");
    }
    if (args.serverless && args.cluster) {
        throw new UsageError(
            "--serverless and --cluster are mutually exclusive."
        );
    }
    return args;
}

export function parseCliArgs(argv: string[]): ParsedArgs {
    if (
        argv.length === 0 ||
        argv[0] === "--help" ||
        argv[0] === "-h" ||
        argv[0] === "help"
    ) {
        return {command: "help"};
    }
    const [first, ...rest] = argv;
    const isHelp = (a: string[]) => a.includes("--help") || a.includes("-h");

    if (first === "run") {
        return isHelp(rest) ? {command: "help"} : parseRun(rest);
    }
    // `databricks-execute <file> ...` is kept as an alias for `run`.
    return isHelp(argv) ? {command: "help"} : parseRun(argv);
}

export const HELP_TEXT = [
    "Usage:",
    "  databricks-execute run <file> [options] [-- script args...]",
    "  databricks-execute <file> [options] [-- script args...]   (alias for run)",
    "  databricks-execute init [--host <url>] [--cluster <id>] [--target <name>]",
    "",
    "run: execute a file as a one-off Jobs run.",
    "  .ipynb and 'Databricks notebook source' files run as notebook tasks;",
    "  plain .py files run as Python file tasks. Other file types are rejected.",
    "",
    "Options (all commands):",
    "  --target <name>        Bundle target (default: bundle default)",
    "  --host <url>           Workspace host (or DATABRICKS_HOST; default: from bundle)",
    "  --token <token>        PAT (or DATABRICKS_TOKEN; default: Databricks CLI auth)",
    "  --cluster <name|id>    Cluster name or id (default: from bundle validate output)",
    "  --no-start-cluster     Fail instead of starting a stopped cluster",
    "  --json                 Print one result object on stdout; logs go to stderr",
    "  --help                 Show help",
    "",
    "Options (run):",
    "  --serverless           Use serverless compute instead of a cluster",
    "  --widget KEY=VALUE     Notebook widget/base parameter (notebooks only, repeatable)",
    "  --timeout <seconds>    Cancel the run after this many seconds (exit 124)",
    "  -- args...             Script arguments (plain .py only)",
    "",
    "Exit codes:",
    "  0 success, 1 run failed or error, 2 usage error, 124 timeout, 130 cancelled",
].join("\n");
