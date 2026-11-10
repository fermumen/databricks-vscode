# Release: v3.0.0

## packages/databricks-execute

## (2026-11-10)

Breaking: v3 replaces the file-type-driven split with two explicit modes. See "Upgrading from 2.x" in the README.

-   Add `run`: every file runs as a one-off Jobs run. Plain `.py` files now run as Python file tasks through upstream's workflow wrapper, with script args passed as task parameters. `databricks-execute <file>` remains an alias.
-   Add `session create/exec/status/stop/list`: named, long-lived Python contexts on a classic cluster for quick checks. `exec --sync` re-syncs the bundle and reloads edited bundle modules.
-   Add `--json` (one result object on stdout), `run --timeout <seconds>`, and defined exit codes (2 usage error, 3 session missing or lost, 124 timeout, 130 cancelled).
-   Status lines and tracebacks now go to stderr; program output stays on stdout. ANSI colours are stripped when stderr isn't a terminal.
-   Reject files that are neither notebooks nor plain `.py`.
-   Plain `.py` files can now run on `--serverless`; serverless notebook runs use the same environment spec as upstream.
-   Remove `--keep-context`, `--context-id` and `--env`, and stop using `bootstrap.py`.

# Release: v2.15.6

## packages/databricks-execute

## (2026-10-20)

-   Align with the upstream VS Code extension v2.21.0.
-   Print captured output and the remapped traceback when a script fails after printing, and exit 1.
-   Keep `--keep-context` and `--context-id` working with the updated bootstrap wrapper.
-   Restore the trailing newline the Command Execution API strips from output.

# Release: v2.15.4

## packages/databricks-execute

## (2026-07-30)

-   Reduce polling noise by printing state changes immediately and unchanged-state heartbeats once per minute.

# Release: v2.15.3

## packages/databricks-execute

## (2026-07-30)

-   Surface Databricks API logs, errors, and traces for failed workflow runs.
-   Propagate the workspace ID from bundle validation.
-   Update serverless environment configuration and package dependencies.
-   Preserve the `databricks-execute` command when publishing with current npm versions.
