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
