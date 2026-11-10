import process from "node:process";

import type {CancellationToken} from "@databricks/sdk-experimental";

import {HELP_TEXT, ParsedArgs, parseCliArgs} from "./args";
import {interruptDatabricksCli} from "./bundle";
import {EXIT_CANCELLED, EXIT_OK, Output, exitCodeForError} from "./output";
import {runCommand} from "./run";
import {sessionCommand} from "./session";

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

function installSigintHandler(cts: SimpleCancellationTokenSource, out: Output) {
    let sigintCount = 0;
    let forceExitTimer: NodeJS.Timeout | undefined;
    process.on("SIGINT", () => {
        sigintCount += 1;
        if (cts.token.isCancellationRequested) {
            if (sigintCount >= 2) {
                process.exit(EXIT_CANCELLED);
            }
            return;
        }
        out.status("Cancellation requested. Attempting to stop execution...");
        interruptDatabricksCli();
        cts.cancel();
        forceExitTimer =
            forceExitTimer ??
            setTimeout(() => process.exit(EXIT_CANCELLED), 5000);
        forceExitTimer.unref();
    });
}

async function main() {
    const argv = process.argv.slice(2);
    if (argv[0] === "init") {
        const {runInit} = await import("./init");
        await runInit(argv.slice(1));
        return;
    }

    const out = new Output(argv.includes("--json"));
    let parsed: ParsedArgs | undefined;
    try {
        parsed = parseCliArgs(argv);
        if (parsed.command === "help") {
            // eslint-disable-next-line no-console
            console.log(HELP_TEXT);
            process.exitCode = EXIT_OK;
            return;
        }

        const cts = new SimpleCancellationTokenSource();
        installSigintHandler(cts, out);
        process.exitCode =
            parsed.command === "session"
                ? await sessionCommand(parsed, cts, out)
                : await runCommand(parsed, cts, out);
    } catch (e) {
        const exitCode = exitCodeForError(e);
        const context: Record<string, unknown> =
            parsed?.command === "session"
                ? {
                      mode: "session",
                      action: parsed.action,
                      session:
                          parsed.action === "list" ? undefined : parsed.name,
                  }
                : {mode: "run"};
        out.error(e, context, exitCode);
        process.exitCode = exitCode;
    }
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises
main();
