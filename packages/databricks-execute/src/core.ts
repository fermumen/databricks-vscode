import path from "node:path";

export function parseDotConfig(contents: string): Record<string, string> {
    const out: Record<string, string> = {};

    for (const rawLine of contents.split(/\r?\n/u)) {
        const line = rawLine.trim();
        if (line.length === 0 || line.startsWith("#")) {
            continue;
        }

        const idx = line.indexOf("=");
        if (idx <= 0) {
            continue;
        }

        const key = line.slice(0, idx).trim();
        let value = line.slice(idx + 1).trim();
        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        }
        out[key] = value;
    }

    return out;
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
