import {
    isValidSessionName,
    parseKeyValueOption,
    parseTimeoutSeconds,
} from "./core";
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

export const SESSION_ACTIONS = [
    "create",
    "exec",
    "status",
    "stop",
    "list",
] as const;
export type SessionAction = (typeof SESSION_ACTIONS)[number];

export type SessionArgs = CommonOptions & {
    command: "session";
    action: SessionAction;
    name: string;
    force: boolean;
    code?: string;
    stdin: boolean;
    sync: boolean;
};

export type ParsedArgs = {command: "help"} | RunArgs | SessionArgs;

/* eslint-disable @typescript-eslint/naming-convention */
const REMOVED_FLAGS: Record<string, string> = {
    "--keep-context":
        "--keep-context was removed in 3.0.0. Use 'databricks-execute session create' and 'session exec' to keep state between snippets.",
    "--context-id":
        "--context-id was removed in 3.0.0. Use named sessions instead: 'databricks-execute session exec -s <name> -c <code>'.",
    "--env":
        "--env was removed in 3.0.0. Pass values as script args (-- arg1 arg2) or, for notebooks, with --widget KEY=VALUE.",
};
/* eslint-enable @typescript-eslint/naming-convention */

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

function parseSession(argv: string[]): SessionArgs {
    const [action, ...rest] = argv;
    if (!SESSION_ACTIONS.includes(action as SessionAction)) {
        throw new UsageError(
            `Unknown session action '${
                action ?? ""
            }'. Expected one of: ${SESSION_ACTIONS.join(", ")}.`
        );
    }
    const args: SessionArgs = {
        ...defaultCommon(),
        command: "session",
        action: action as SessionAction,
        name: "default",
        force: false,
        stdin: false,
        sync: false,
    };
    const only = (flag: string, allowed: SessionAction) => {
        if (args.action !== allowed) {
            throw new UsageError(
                `${flag} is only supported by 'session ${allowed}'.`
            );
        }
    };

    walk(rest, args, (a, next) => {
        switch (a) {
            case "-s":
            case "--session":
                args.name = next();
                return true;
            case "--force":
                only(a, "create");
                args.force = true;
                return true;
            case "-c":
            case "--code":
                only(a, "exec");
                args.code = next();
                return true;
            case "-":
                only("'-' (read code from stdin)", "exec");
                args.stdin = true;
                return true;
            case "--sync":
                only(a, "exec");
                args.sync = true;
                return true;
            case "--serverless":
                throw new UsageError(
                    "Sessions need a classic cluster: the Command Execution API doesn't run on serverless. Use 'run --serverless' instead."
                );
        }
        return false;
    });

    if (!isValidSessionName(args.name)) {
        throw new UsageError(
            `Invalid session name '${args.name}' (letters, digits, '.', '_' and '-'; up to 64 characters).`
        );
    }
    if (args.action === "exec") {
        if (args.code !== undefined && args.stdin) {
            throw new UsageError("Pass code with either -c or '-', not both.");
        }
        if (args.code === undefined && !args.stdin) {
            throw new UsageError(
                "Missing code: pass -c <code>, or '-' to read it from stdin."
            );
        }
    }
    return args;
}

export function parseCliArgs(argv: string[]): ParsedArgs {
    const delimiterIndex = argv.indexOf("--");
    const ownArgs =
        delimiterIndex === -1 ? argv : argv.slice(0, delimiterIndex);
    if (
        ownArgs.length === 0 ||
        ownArgs.includes("--help") ||
        ownArgs.includes("-h") ||
        ownArgs[0] === "help"
    ) {
        return {command: "help"};
    }

    const [first, ...rest] = argv;
    if (first === "run") {
        return parseRun(rest);
    }
    if (first === "session") {
        return parseSession(rest);
    }
    // `databricks-execute <file> ...` is kept as an alias for `run`.
    return parseRun(argv);
}

export const HELP_TEXT = [
    "Usage:",
    "  databricks-execute run <file> [options] [-- script args...]",
    "  databricks-execute <file> [options] [-- script args...]   (alias for run)",
    "  databricks-execute session create [-s <name>] [--force] [options]",
    "  databricks-execute session exec   [-s <name>] (-c <code> | -) [--sync] [options]",
    "  databricks-execute session status [-s <name>] [options]",
    "  databricks-execute session stop   [-s <name>] [options]",
    "  databricks-execute session list   [options]",
    "  databricks-execute init [--host <url>] [--cluster <id>] [--target <name>]",
    "",
    "run: execute a file as a one-off Jobs run.",
    "  .ipynb and 'Databricks notebook source' files run as notebook tasks;",
    "  plain .py files run as Python file tasks. Other file types are rejected.",
    "  Slower (~20s minimum) but isolated; use it for real work.",
    "",
    "session: a named, long-lived Python context on a classic cluster.",
    "  'exec' sends a snippet as-is and keeps variables between calls; use it",
    "  for quick checks. 'create' syncs the bundle and adds its remote root to",
    "  sys.path. Sessions are lost when the cluster restarts.",
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
    "Options (session):",
    "  -s, --session <name>   Session name (default: default)",
    "  --force                create: replace an existing session",
    "  -c, --code <code>      exec: code to run",
    "  -                      exec: read code from stdin",
    "  --sync                 exec: run 'bundle sync' and reload bundle modules first",
    "",
    "Exit codes:",
    "  0 success, 1 run failed / snippet raised / other error, 2 usage error,",
    "  3 session not found or lost, 124 timeout, 130 cancelled",
].join("\n");
