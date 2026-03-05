import path from "node:path";

export type NotebookType = "IPYNB" | "PY_DBNB" | "OTHER_DBNB";

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

export function ensureValidEnvVars(envVars: Record<string, string>) {
    for (const key of Object.keys(envVars)) {
        if (!/^[a-zA-Z_]{1,}[a-zA-Z0-9_]*$/u.test(key)) {
            throw new Error(
                `Invalid environment variable ${key}: Only letters, digits and '_' are allowed.`
            );
        }
    }
}

export function escapePythonString(str: string): string {
    return str.replace(/\\/gu, "\\\\").replace(/'/gu, "\\'");
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

export function compileBootstrapCommand(
    bootstrapTemplate: string,
    opts: {
        remotePythonFile: string;
        remoteRepoRoot: string;
        argv: string[];
        envVars: Record<string, string>;
    }
): string {
    ensureValidEnvVars(opts.envVars);

    let bootstrap = bootstrapTemplate;

    bootstrap = bootstrap.replace(
        '"PYTHON_FILE"',
        `"${opts.remotePythonFile}"`
    );
    bootstrap = bootstrap.replace('"REPO_PATH"', `"${opts.remoteRepoRoot}"`);
    bootstrap = bootstrap.replace(
        "args = []",
        `args = ['${opts.argv.map(escapePythonString).join("', '")}'];`
    );
    bootstrap = bootstrap.replace(
        "env = {}",
        `env = ${JSON.stringify(opts.envVars)}`
    );

    return bootstrap;
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
