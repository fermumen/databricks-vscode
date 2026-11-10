import path from "node:path";

export type NotebookType = "IPYNB" | "PY_DBNB" | "OTHER_DBNB";

export function createProgressReporter<T>(
    report: (value: T) => void,
    heartbeatMs: number,
    now: () => number = Date.now
): (value: T) => void {
    let hasReported = false;
    let lastValue: T;
    let lastReportedAt = 0;

    return (value: T) => {
        const currentTime = now();
        if (
            !hasReported ||
            value !== lastValue ||
            currentTime - lastReportedAt >= heartbeatMs
        ) {
            hasReported = true;
            lastValue = value;
            lastReportedAt = currentTime;
            report(value);
        }
    };
}

export function coalesce(
    ...values: Array<string | undefined>
): string | undefined {
    for (const v of values) {
        if (v !== undefined && v !== "") {
            return v;
        }
    }
    return undefined;
}

export function normalizeHost(host: string): string {
    if (!/^https?:\/\//iu.test(host)) {
        return `https://${host}`;
    }
    return host;
}

export function parseKeyValueOption(
    raw: string,
    flagName: string
): {key: string; value: string} {
    const eq = raw.indexOf("=");
    if (eq <= 0) {
        throw new Error(`Invalid ${flagName} value (expected KEY=VALUE)`);
    }

    return {
        key: raw.slice(0, eq),
        value: raw.slice(eq + 1),
    };
}

export function normalizeWorkspacePath(p: string): string {
    let normalized = p.replace(/\\/gu, "/");
    normalized = path.posix.normalize(normalized);
    if (normalized.startsWith("/Workspace/")) {
        normalized = normalized.slice("/Workspace".length);
        normalized = path.posix.normalize(normalized);
    }
    return normalized;
}

export function workspacePrefixedPath(p: string): string {
    return path.posix.join("/Workspace", normalizeWorkspacePath(p));
}

export function localPathToRemoteWorkspacePath(
    localFilePath: string,
    localRoot: string,
    remoteRootPath: string
): string {
    const relative = path.relative(localRoot, localFilePath);
    // On Windows, if paths are on different drives, `relative` can be an absolute
    // path. Either way, we only support running files within the bundle root.
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error(
            `File is not within bundle root. File: ${localFilePath}, bundle root: ${localRoot}`
        );
    }

    const relativePosix = relative.split(path.sep).join(path.posix.sep);
    const remoteRootWorkspace = workspacePrefixedPath(remoteRootPath);
    return path.posix.join(remoteRootWorkspace, relativePosix);
}

export function remoteWorkspacePathToLocalPath(
    remoteWorkspaceFilePath: string,
    localRoot: string,
    remoteRootPath: string
): string | undefined {
    const remoteNoWorkspace = normalizeWorkspacePath(remoteWorkspaceFilePath);
    const rootNoWorkspace = normalizeWorkspacePath(remoteRootPath);

    const rel = path.posix.relative(rootNoWorkspace, remoteNoWorkspace);
    if (rel.startsWith("..")) {
        return undefined;
    }

    return path.join(localRoot, ...rel.split("/"));
}

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001b\[[0-9;]*[A-Za-z]/gu;

export function stripAnsi(text: string): string {
    return text.replace(ANSI_PATTERN, "");
}

export function withTrailingNewline(text: string): string {
    return text.endsWith("\n") ? text : `${text}\n`;
}

/**
 * Remote path of the workflow wrapper uploaded next to a plain `.py` file.
 * Mirrors `getWrapperPath` in upstream's `WorkspaceFsWorkflowWrapper.ts`.
 */
export function workflowWrapperPath(remoteFilePath: string): string {
    const posixPath = path.posix;
    const base = posixPath.basename(remoteFilePath);
    return posixPath.format({
        dir: posixPath.dirname(remoteFilePath),
        name: base
            .split(".")
            .slice(0, -1)
            .concat(["databricks", "file", "workflow-wrapper"])
            .join("."),
        ext: posixPath.extname(remoteFilePath),
    });
}

/**
 * Fill in upstream's `file.workflow-wrapper.py` placeholders. Mirrors
 * `WorkspaceFsWorkflowWrapper.createFile`; both paths are /Workspace-prefixed.
 */
export function renderWorkflowWrapper(
    template: string,
    opts: {sourceFile: string; projectRoot: string}
): string {
    return template
        .split("{{DATABRICKS_SOURCE_FILE}}")
        .join(opts.sourceFile)
        .split("{{DATABRICKS_PROJECT_ROOT}}")
        .join(opts.projectRoot);
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Rewrite remote bundle paths (with or without the /Workspace prefix) in a
 * traceback to the matching local paths. Generated workflow wrappers have no
 * local counterpart and are left as-is.
 */
export function remapRemotePaths(
    text: string,
    localRoot: string,
    remoteRootPath: string
): string {
    const root = normalizeWorkspacePath(remoteRootPath).replace(/\/+$/u, "");
    if (!root || root === "/") {
        return text;
    }
    const pattern = new RegExp(
        `(?:/Workspace)?${escapeRegExp(root)}/[^\\s"':,()]+`,
        "gu"
    );
    return text.replace(pattern, (remote) => {
        if (remote.includes(".databricks.file.workflow-wrapper.")) {
            return remote;
        }
        return (
            remoteWorkspacePathToLocalPath(remote, localRoot, root) ?? remote
        );
    });
}

/**
 * Best-effort `{type, message}` for a Python error, from the API's HTML
 * summary (e.g. `<span class='ansi-red-fg'>ValueError</span>: boom`) or
 * the last `Type: message` line of the traceback.
 */
export function summarizePythonError(
    summary: string | undefined,
    traceback: string | undefined
): {type: string; message: string} {
    const candidates = [
        htmlToPlainText(stripAnsi(summary ?? "")),
        ...stripAnsi(traceback ?? "")
            .split(/\r?\n/u)
            .map((l) => l.trim())
            .filter(Boolean)
            .reverse(),
    ];
    for (const line of candidates) {
        const match = line.match(/^([A-Za-z_][\w.]*):\s?(.*)$/u);
        if (match && !line.startsWith("File ")) {
            return {type: match[1], message: match[2]};
        }
    }
    const fallback = candidates.find(Boolean) ?? "";
    return {type: "Error", message: fallback};
}

/** JSON string literals are valid Python string literals. */
function pythonString(value: string): string {
    return JSON.stringify(value);
}

/**
 * Snippet run once when a session is created: makes bundle modules
 * importable and starts in the bundle's remote root.
 */
export function sessionSetupCommand(remoteRoot: string): string {
    return [
        "def _databricks_execute_setup(root):",
        "    import os, sys",
        "    if root not in sys.path:",
        "        sys.path.insert(0, root)",
        "    os.chdir(root)",
        `_databricks_execute_setup(${pythonString(remoteRoot)})`,
        "del _databricks_execute_setup",
    ].join("\n");
}

/**
 * Snippet run after `exec --sync`: drops cached bundle modules so the next
 * import picks up the synced files.
 */
export function moduleUnloadCommand(remoteRoot: string): string {
    return [
        "def _databricks_execute_unload(root):",
        "    import importlib, sys",
        '    prefix = root.rstrip("/") + "/"',
        "    for name, module in list(sys.modules.items()):",
        '        if (getattr(module, "__file__", None) or "").startswith(prefix):',
        "            del sys.modules[name]",
        "    importlib.invalidate_caches()",
        `_databricks_execute_unload(${pythonString(remoteRoot)})`,
        "del _databricks_execute_unload",
    ].join("\n");
}

/** Render a Command Execution API `table` result as tab-separated text. */
export function formatTableResult(
    data: unknown,
    schema: Array<Record<string, any>> | undefined
): string {
    const cell = (v: unknown) =>
        v === null || v === undefined
            ? "null"
            : typeof v === "object"
              ? JSON.stringify(v)
              : String(v);
    const lines: string[] = [];
    if (schema?.length) {
        lines.push(schema.map((c) => String(c.name ?? "")).join("\t"));
    }
    for (const row of Array.isArray(data) ? data : []) {
        lines.push((Array.isArray(row) ? row : [row]).map(cell).join("\t"));
    }
    return lines.join("\n");
}

export function isValidSessionName(name: string): boolean {
    return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u.test(name);
}

export function parseTimeoutSeconds(raw: string): number {
    if (!/^\d+$/u.test(raw) || Number(raw) <= 0) {
        throw new Error(
            `Invalid --timeout value '${raw}' (expected a positive number of seconds).`
        );
    }
    return Number(raw);
}

export function isLikelyClusterId(value: string): boolean {
    // Common format: 0123-456789-abcde123
    return /^\d{4}-\d{6}-[a-zA-Z0-9]+$/u.test(value);
}

export function detectNotebookType(
    ext: string | undefined,
    firstLine: string | undefined
): NotebookType | undefined {
    if (!ext) {
        return;
    }

    const normalizedExt = ext.replace(/^\./u, "").toLowerCase();
    if (normalizedExt === "ipynb") {
        return "IPYNB";
    }

    const commentPrefixes = {
        py: "#",
        scala: "//",
        sql: "--",
        r: "#",
    } as const;
    const commentPrefix =
        commentPrefixes[normalizedExt as keyof typeof commentPrefixes];
    if (!commentPrefix) {
        return;
    }

    const line = (firstLine ?? "").replace(/^\uFEFF/u, "");
    if (!line.startsWith(`${commentPrefix} Databricks notebook source`)) {
        return;
    }

    if (normalizedExt === "py") {
        return "PY_DBNB";
    }
    return "OTHER_DBNB";
}

function decodeHtmlEntities(input: string): string {
    const named: Record<string, string> = {
        amp: "&",
        lt: "<",
        gt: ">",
        quot: '"',
        apos: "'",
        nbsp: " ",
    };

    return input.replace(
        /&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/gu,
        (match, entity) => {
            if (entity.startsWith("#x") || entity.startsWith("#X")) {
                const cp = Number.parseInt(entity.slice(2), 16);
                if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) {
                    return match;
                }
                try {
                    return String.fromCodePoint(cp);
                } catch {
                    return match;
                }
            }

            if (entity.startsWith("#")) {
                const cp = Number.parseInt(entity.slice(1), 10);
                if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) {
                    return match;
                }
                try {
                    return String.fromCodePoint(cp);
                } catch {
                    return match;
                }
            }

            return named[entity] ?? match;
        }
    );
}

export function htmlToPlainText(html: string): string {
    let out = html.replace(/\r\n?/gu, "\n");

    out = out.replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, "");
    out = out.replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, "");

    out = out.replace(/<br\s*\/?>/giu, "\n");
    out = out.replace(/<\/(p|div|tr|li|ul|ol|table|h[1-6])\s*>/giu, "\n");
    out = out.replace(/<\/?pre\b[^>]*>/giu, "\n");

    out = out.replace(/<[^>]+>/gu, "");

    out = decodeHtmlEntities(out).replace(/\u00a0/gu, " ");

    out = out.replace(/[ \t]+\n/gu, "\n");
    out = out.replace(/\n{3,}/gu, "\n\n");

    return out.trim();
}

export function extractDatabricksNotebookModelFromExportedHtml(
    html: string
): any | undefined {
    const match = html.match(/__DATABRICKS_NOTEBOOK_MODEL\s*=\s*'([^']+)'/u);
    if (!match) {
        return;
    }

    const encoded = match[1];
    try {
        const urlEncodedJson = Buffer.from(encoded, "base64").toString("utf8");
        const json = decodeURIComponent(urlEncodedJson);
        return JSON.parse(json);
    } catch {
        return;
    }
}

export function extractNotebookTextOutputFromExportedHtml(
    html: string
): {stdout: string; stderr: string; error: string} | undefined {
    const model = extractDatabricksNotebookModelFromExportedHtml(html);
    if (!model) {
        return;
    }

    const commands: any[] = Array.isArray(model.commands) ? model.commands : [];

    let stdout = "";
    let stderr = "";
    let error = "";

    for (const cmd of commands) {
        if (!cmd || typeof cmd !== "object") {
            continue;
        }

        const results = (cmd as any).results;
        const dataItems: any[] = Array.isArray(results?.data)
            ? results.data
            : [];
        for (const item of dataItems) {
            if (!item || typeof item !== "object") {
                continue;
            }
            if (item.type === "ansi") {
                const name = item.name;
                const chunk = typeof item.data === "string" ? item.data : "";
                if (!chunk) {
                    continue;
                }

                if (name === "stdout") {
                    stdout += chunk;
                } else if (name === "stderr" || name === "error") {
                    stderr += chunk;
                }
                continue;
            }

            if (item.type === "mimeBundle") {
                const bundle = item.data as Record<string, unknown>;
                const plain = bundle?.["text/plain"];
                if (typeof plain === "string" && plain) {
                    stdout += plain.endsWith("\n") ? plain : `${plain}\n`;
                    continue;
                }

                const htmlData = bundle?.["text/html"];
                if (typeof htmlData === "string" && htmlData) {
                    const text = htmlToPlainText(htmlData);
                    if (text) {
                        stdout += text.endsWith("\n") ? text : `${text}\n`;
                    }
                    continue;
                }

                const jsonData = bundle?.["application/json"];
                if (typeof jsonData === "string" && jsonData) {
                    stdout += jsonData.endsWith("\n")
                        ? jsonData
                        : `${jsonData}\n`;
                    continue;
                }
                if (jsonData !== undefined) {
                    try {
                        stdout += `${JSON.stringify(jsonData)}\n`;
                    } catch {}
                    continue;
                }
            }
        }

        if (typeof (cmd as any).error === "string" && (cmd as any).error) {
            error += (cmd as any).error;
            if (!error.endsWith("\n")) {
                error += "\n";
            }
        }
    }

    return {
        stdout: stdout.trimEnd(),
        stderr: stderr.trimEnd(),
        error: error.trimEnd(),
    };
}
