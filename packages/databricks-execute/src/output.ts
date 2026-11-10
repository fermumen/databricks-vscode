import process from "node:process";

import {stripAnsi, withTrailingNewline} from "./core";

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;
export const EXIT_SESSION_MISSING = 3;
export const EXIT_TIMEOUT = 124;
export const EXIT_CANCELLED = 130;

/** Bad arguments or unsupported input; exits with {@link EXIT_USAGE}. */
export class UsageError extends Error {
    override name = "UsageError";
}

/** The named session doesn't exist or was lost; exits with {@link EXIT_SESSION_MISSING}. */
export class SessionMissingError extends Error {
    override name = "SessionMissingError";
}

export function exitCodeForError(e: unknown): number {
    if (e instanceof UsageError) {
        return EXIT_USAGE;
    }
    if (e instanceof SessionMissingError) {
        return EXIT_SESSION_MISSING;
    }
    return EXIT_FAILED;
}

/**
 * The output contract: status lines go to stderr, program output to stdout,
 * tracebacks to stderr. With `--json`, program output is captured and printed
 * as a single result object on stdout instead.
 */
export class Output {
    readonly captured = {stdout: "", stderr: ""};

    constructor(
        public json: boolean,
        private readonly stderrIsTty: boolean = Boolean(process.stderr.isTTY)
    ) {}

    status(message: string) {
        process.stderr.write(`${new Date().toLocaleString()} - ${message}\n`);
    }

    programStdout(text: string) {
        if (!text) {
            return;
        }
        if (this.json) {
            this.captured.stdout += withTrailingNewline(text);
            return;
        }
        process.stdout.write(withTrailingNewline(text));
    }

    programStderr(text: string) {
        if (!text) {
            return;
        }
        if (this.json) {
            this.captured.stderr += withTrailingNewline(stripAnsi(text));
            return;
        }
        process.stderr.write(
            withTrailingNewline(this.stderrIsTty ? text : stripAnsi(text))
        );
    }

    /** Human mode: print `text` to stdout. JSON mode: no-op. */
    human(text: string) {
        if (!this.json) {
            process.stdout.write(withTrailingNewline(text));
        }
    }

    /** JSON mode: print the result object. Human mode: no-op. */
    result(obj: Record<string, unknown>) {
        if (this.json) {
            process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
        }
    }

    error(e: unknown, context: Record<string, unknown>, exitCode: number) {
        const message =
            e instanceof Error ? e.message : String(e ?? "Unknown error");
        if (this.json) {
            this.result({
                ...context,
                status: "error",
                exitCode,
                error: {
                    type: e instanceof Error ? e.name : "Error",
                    message: stripAnsi(message),
                },
            });
            return;
        }
        process.stderr.write(
            withTrailingNewline(this.stderrIsTty ? message : stripAnsi(message))
        );
    }
}
