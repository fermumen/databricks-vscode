import * as fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import type {CancellationToken, jobs} from "@databricks/sdk-experimental";
import {ApiError} from "@databricks/sdk-experimental";

import fileWrapperTemplate from "../../databricks-vscode/resources/python/file.workflow-wrapper.py";
import {
    WorkflowRun,
    WorkspaceFsEntity,
    WorkspaceFsUtils,
} from "../../databricks-vscode/src/sdk-extensions";
import type {RunArgs} from "./args";
import {
    BundleWorkspace,
    WAIT_HEARTBEAT_MS,
    ensureClusterRunning,
    resolveBundleWorkspace,
    resolveCluster,
    syncBundle,
} from "./bundle";
import {
    NotebookType,
    createProgressReporter,
    detectNotebookType,
    extractNotebookTextOutputFromExportedHtml,
    htmlToPlainText,
    localPathToRemoteWorkspacePath,
    normalizeWorkspacePath,
    remapRemotePaths,
    renderWorkflowWrapper,
    summarizePythonError,
    workflowWrapperPath,
    workspacePrefixedPath,
} from "./core";
import {
    EXIT_CANCELLED,
    EXIT_FAILED,
    EXIT_OK,
    EXIT_TIMEOUT,
    Output,
    UsageError,
} from "./output";

export type CancellationSource = {
    readonly token: CancellationToken;
    cancel(): void;
};

type RunOutcome = {
    run?: WorkflowRun;
    error?: {type: string; message: string; traceback?: string};
    truncated: boolean;
};

async function readFirstLine(filePath: string): Promise<string | undefined> {
    const fh = await fs.open(filePath, "r");
    try {
        const buf = Buffer.alloc(4096);
        const {bytesRead} = await fh.read(buf, 0, buf.length, 0);
        if (bytesRead <= 0) {
            return undefined;
        }
        return buf.toString("utf8", 0, bytesRead).split(/\r?\n/u, 1)[0];
    } finally {
        await fh.close();
    }
}

function apiErrorBody(e: unknown): Record<string, any> | undefined {
    if (!(e instanceof ApiError)) {
        return undefined;
    }
    const response = e.response;
    if (typeof response === "string") {
        try {
            return JSON.parse(response);
        } catch {
            return undefined;
        }
    }
    return response && typeof response === "object"
        ? (response as Record<string, any>)
        : undefined;
}

function reportRunHandle(run: WorkflowRun, out: Output) {
    if (run.runPageUrl) {
        out.status(`Run URL: ${run.runPageUrl}`);
    } else if (run.details.run_id !== undefined) {
        out.status(`Run ID: ${run.details.run_id}`);
    }
}

/** Print a failed run's error and trace, and describe it for `--json`. */
function reportRunError(
    output: {error?: string; error_trace?: string},
    ws: BundleWorkspace,
    out: Output
): RunOutcome["error"] {
    if (!output.error && !output.error_trace) {
        return undefined;
    }
    const traceback = output.error_trace
        ? remapRemotePaths(output.error_trace, ws.bundleRoot, ws.remoteRootPath)
        : undefined;
    if (traceback) {
        out.programStderr(traceback);
    } else if (output.error) {
        out.programStderr(output.error);
    }
    const summary = summarizePythonError(undefined, traceback);
    return {
        type: summary.type,
        message: output.error ?? summary.message,
        traceback,
    };
}

async function runNotebook(
    args: RunArgs,
    ws: BundleWorkspace,
    remoteFile: string,
    clusterId: string | undefined,
    token: CancellationToken,
    out: Output
): Promise<RunOutcome> {
    const notebookPath = normalizeWorkspacePath(remoteFile).replace(
        /\.(py|ipynb|scala|r|sql)$/iu,
        ""
    );

    /* eslint-disable @typescript-eslint/naming-convention */
    const task: jobs.SubmitTask = {
        task_key: "databricks_execute_notebook",
        notebook_task: {
            notebook_path: notebookPath,
            base_parameters: args.widgets,
        },
        timeout_seconds: 0,
    };
    const submitRequest: jobs.SubmitRun = {timeout_seconds: 0, tasks: [task]};
    if (clusterId) {
        task.existing_cluster_id = clusterId;
    } else {
        // Same serverless environment as upstream's runPythonAndWait.
        task.environment_key = "databricks_execute_serverless";
        submitRequest.environments = [
            {
                environment_key: "databricks_execute_serverless",
                spec: {environment_version: "5"},
            },
        ];
    }
    /* eslint-enable @typescript-eslint/naming-convention */

    let run: WorkflowRun;
    try {
        run = await WorkflowRun.submitRun(ws.apiClient, submitRequest);
    } catch (e) {
        const body = apiErrorBody(e);
        if (body) {
            out.programStdout(body.logs ?? "");
            reportRunError(body, ws, out);
        }
        throw e;
    }
    reportRunHandle(run, out);

    await run.wait(
        createProgressReporter(
            (state) => out.status(`Run state: ${state}`),
            WAIT_HEARTBEAT_MS
        ),
        token
    );

    let printedOutput = false;
    let printedError = false;
    let error: RunOutcome["error"];
    try {
        const exported = await run.export();
        const view = (exported.views ?? []).find((v) => v?.content);
        if (view?.content) {
            const extracted = extractNotebookTextOutputFromExportedHtml(
                view.content
            );
            if (extracted) {
                out.programStdout(extracted.stdout);
                out.programStderr(extracted.stderr);
                out.programStderr(extracted.error);
                printedOutput = Boolean(
                    extracted.stdout || extracted.stderr || extracted.error
                );
                printedError = Boolean(extracted.stderr || extracted.error);
                if (extracted.error) {
                    error = {
                        ...summarizePythonError(undefined, extracted.error),
                        traceback: extracted.error,
                    };
                }
            } else {
                const text = htmlToPlainText(view.content);
                out.programStdout(text);
                printedOutput = Boolean(text);
            }
        }
    } catch (e) {
        const body = apiErrorBody(e);
        if (body) {
            error = reportRunError(body, ws, out) ?? error;
            printedError = true;
        }
    }

    let truncated = false;
    try {
        const output = await run.getOutput();
        const notebookResult = output.notebook_output?.result;
        truncated = Boolean(output.notebook_output?.truncated);
        if (!printedOutput && notebookResult) {
            out.programStdout(notebookResult);
        }
        if (truncated) {
            out.status("Notebook output truncated by the Jobs API.");
        }
        if (!printedError) {
            error = reportRunError(output, ws, out) ?? error;
        } else if (!error && output.error) {
            error = {type: "Error", message: output.error};
        }
    } catch (e) {
        const body = apiErrorBody(e);
        if (body && !printedError) {
            error = reportRunError(body, ws, out) ?? error;
        }
    }

    return {run, error, truncated};
}

async function runPythonFile(
    args: RunArgs,
    ws: BundleWorkspace,
    remoteFile: string,
    clusterId: string | undefined,
    token: CancellationToken,
    out: Output
): Promise<RunOutcome> {
    // Upload upstream's workflow wrapper next to the file, as the VS Code
    // extension does (WorkspaceFsWorkflowWrapper.createPythonFileWrapper).
    // It sets cwd and sys.path and provides spark/dbutils globals.
    const remoteFileNoPrefix = normalizeWorkspacePath(remoteFile);
    const wrapperPath = workflowWrapperPath(remoteFileNoPrefix);
    const dir = await WorkspaceFsEntity.fromPath(
        ws.wsClient,
        path.posix.dirname(wrapperPath)
    );
    if (!WorkspaceFsUtils.isDirectory(dir)) {
        throw new Error(
            `${path.posix.dirname(wrapperPath)} is not a directory`
        );
    }
    const wrapper = await dir.createFile(
        wrapperPath,
        renderWorkflowWrapper(fileWrapperTemplate, {
            sourceFile: workspacePrefixedPath(remoteFileNoPrefix),
            projectRoot: workspacePrefixedPath(ws.remoteRootPath),
        }),
        true
    );
    if (!WorkspaceFsUtils.isFile(wrapper)) {
        throw new Error(
            `Cannot create workflow wrapper for ${remoteFileNoPrefix}`
        );
    }

    let run: WorkflowRun | undefined;
    const reportState = createProgressReporter(
        (state: string) => out.status(`Run state: ${state}`),
        WAIT_HEARTBEAT_MS
    );
    let output: jobs.RunOutput;
    try {
        output = await WorkflowRun.runPythonAndWait({
            client: ws.apiClient,
            clusterId,
            path: wrapper.path,
            args: args.scriptArgs,
            onProgress: (state, r) => {
                if (!run) {
                    run = r;
                    reportRunHandle(r, out);
                }
                reportState(state);
            },
            token,
        });
    } catch (e) {
        const body = apiErrorBody(e);
        if (!body) {
            throw e;
        }
        output = body as jobs.RunOutput;
    }

    out.programStdout(output.logs ?? "");
    if (output.logs_truncated) {
        out.status("Run logs truncated by the Jobs API.");
    }
    const error = reportRunError(output, ws, out);
    return {run, error, truncated: Boolean(output.logs_truncated)};
}

export async function runCommand(
    args: RunArgs,
    cts: CancellationSource,
    out: Output
): Promise<number> {
    const startedAt = Date.now();
    const absoluteFilePath = path.resolve(args.file!);
    const stat = await fs.stat(absoluteFilePath).catch(() => undefined);
    if (!stat) {
        throw new UsageError(`File not found: ${absoluteFilePath}`);
    }
    if (!stat.isFile()) {
        throw new UsageError(`Not a file: ${absoluteFilePath}`);
    }

    const fileExt = path.extname(absoluteFilePath).replace(/^\./u, "");
    const lowerExt = fileExt.toLowerCase();
    const firstLine = ["py", "scala", "sql", "r"].includes(lowerExt)
        ? await readFirstLine(absoluteFilePath)
        : undefined;
    const notebookType: NotebookType | undefined = detectNotebookType(
        fileExt,
        firstLine
    );
    if (!notebookType && lowerExt !== "py") {
        throw new UsageError(
            `Unsupported file type '${path.basename(
                absoluteFilePath
            )}'. 'run' supports .ipynb, 'Databricks notebook source' files (.py/.sql/.scala/.r) and plain .py files.`
        );
    }
    if (!notebookType && Object.keys(args.widgets).length > 0) {
        throw new UsageError(
            "--widget is only supported for notebooks (.ipynb or 'Databricks notebook source' files). Pass script args after -- instead."
        );
    }
    if (notebookType && args.scriptArgs.length > 0) {
        throw new UsageError(
            "Notebooks don't take positional args. Use --widget KEY=VALUE instead."
        );
    }

    const ws = await resolveBundleWorkspace(
        [path.dirname(absoluteFilePath), process.cwd()],
        args,
        out
    );
    const remoteFile = localPathToRemoteWorkspacePath(
        absoluteFilePath,
        ws.bundleRoot,
        ws.remoteRootPath
    );
    await syncBundle(ws, out);

    let clusterId: string | undefined;
    if (!args.serverless) {
        const cluster = await resolveCluster(
            ws,
            args.cluster,
            ", or use --serverless"
        );
        await ensureClusterRunning(cluster, args.startCluster, cts.token, out);
        clusterId = cluster.id;
    }

    const relativeFile = path.relative(ws.bundleRoot, absoluteFilePath);
    out.status(
        `Running ${relativeFile} as a ${
            notebookType ? `notebook (${notebookType})` : "Python file"
        } job on ${clusterId ? `cluster ${clusterId}` : "serverless"}...`
    );

    let timedOut = false;
    const timer =
        args.timeoutSeconds !== undefined
            ? setTimeout(() => {
                  timedOut = true;
                  out.status(
                      `Timeout of ${args.timeoutSeconds}s reached. Cancelling the run...`
                  );
                  cts.cancel();
              }, args.timeoutSeconds * 1000)
            : undefined;

    let outcome: RunOutcome;
    try {
        outcome = notebookType
            ? await runNotebook(args, ws, remoteFile, clusterId, cts.token, out)
            : await runPythonFile(
                  args,
                  ws,
                  remoteFile,
                  clusterId,
                  cts.token,
                  out
              );
    } finally {
        if (timer) {
            clearTimeout(timer);
        }
    }

    const resultState = outcome.run?.state?.result_state;
    if (resultState) {
        out.status(`Run result: ${resultState}`);
    }
    if (outcome.run?.state?.state_message) {
        out.status(`Run message: ${outcome.run.state.state_message}`);
    }

    let exitCode: number;
    let status: string;
    if (cts.token.isCancellationRequested) {
        exitCode = timedOut ? EXIT_TIMEOUT : EXIT_CANCELLED;
        status = timedOut ? "timeout" : "cancelled";
    } else if (resultState === "SUCCESS") {
        exitCode = EXIT_OK;
        status = "ok";
    } else {
        exitCode = EXIT_FAILED;
        status = "error";
    }

    const durationMs = Date.now() - startedAt;
    out.status(`Done (took ${durationMs}ms)`);
    out.result({
        mode: "run",
        file: relativeFile,
        runId: outcome.run?.details.run_id,
        runUrl: outcome.run?.runPageUrl || undefined,
        resultState,
        clusterId,
        status,
        exitCode,
        stdout: out.captured.stdout,
        stderr: out.captured.stderr,
        error:
            outcome.error ??
            (exitCode === EXIT_FAILED
                ? {
                      type: "RunFailed",
                      message:
                          outcome.run?.state?.state_message ??
                          `Run finished with result ${
                              resultState ?? "unknown"
                          }`,
                  }
                : undefined),
        truncated: outcome.truncated,
        durationMs,
    });
    return exitCode;
}
