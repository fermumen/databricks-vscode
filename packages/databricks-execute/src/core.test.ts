import assert from "node:assert/strict";
import test from "node:test";

import {
    coalesce,
    compileBootstrapCommand,
    detectNotebookType,
    ensureValidEnvVars,
    extractNotebookTextOutputFromExportedHtml,
    htmlToPlainText,
    isLikelyClusterId,
    localPathToRemoteWorkspacePath,
    normalizeHost,
    normalizeWorkspacePath,
    remoteWorkspacePathToLocalPath,
    workspacePrefixedPath,
} from "./core";

test("coalesce returns first non-empty value", () => {
    assert.equal(coalesce(undefined, "", "a", "b"), "a");
});

test("normalizeHost prefixes https:// when missing", () => {
    assert.equal(
        normalizeHost("adb-123.cloud.databricks.com"),
        "https://adb-123.cloud.databricks.com"
    );
    assert.equal(normalizeHost("https://example.com"), "https://example.com");
});

test("workspace path helpers normalize and (un)prefix /Workspace", () => {
    assert.equal(normalizeWorkspacePath("/Workspace/Users/me"), "/Users/me");
    assert.equal(workspacePrefixedPath("/Users/me"), "/Workspace/Users/me");
    assert.equal(
        workspacePrefixedPath("/Workspace/Users/me"),
        "/Workspace/Users/me"
    );
});

test("local/remote path mapping stays within bundle root", () => {
    const localRoot = "/repo";
    const remoteRoot = "/Users/me/project";
    const file = "/repo/src/main.py";

    assert.equal(
        localPathToRemoteWorkspacePath(file, localRoot, remoteRoot),
        "/Workspace/Users/me/project/src/main.py"
    );

    assert.throws(
        () =>
            localPathToRemoteWorkspacePath(
                "/other/x.py",
                localRoot,
                remoteRoot
            ),
        /File is not within bundle root/
    );
});

test("remoteWorkspacePathToLocalPath maps /Workspace paths to local paths", () => {
    const localRoot = "/repo";
    const remoteRoot = "/Users/me/project";

    assert.equal(
        remoteWorkspacePathToLocalPath(
            "/Workspace/Users/me/project/a/b.py",
            localRoot,
            remoteRoot
        ),
        "/repo/a/b.py"
    );
    assert.equal(
        remoteWorkspacePathToLocalPath(
            "/Workspace/Users/other/x.py",
            localRoot,
            remoteRoot
        ),
        undefined
    );
});

test("ensureValidEnvVars enforces shell-like KEY names", () => {
    // eslint-disable-next-line @typescript-eslint/naming-convention
    ensureValidEnvVars({FOO: "1", BAR_BAZ1: "2", _OK: "3"});
    assert.throws(
        // eslint-disable-next-line @typescript-eslint/naming-convention
        () => ensureValidEnvVars({"1NO": "x"}),
        /Invalid environment variable/
    );
    assert.throws(
        // eslint-disable-next-line @typescript-eslint/naming-convention
        () => ensureValidEnvVars({"BAD-NAME": "x"}),
        /Invalid environment variable/
    );
});

test("compileBootstrapCommand injects argv and env", () => {
    const template = `python_file = "PYTHON_FILE"\nrepo_path = "REPO_PATH"\nargs = []\nenv = {}\n`;
    const out = compileBootstrapCommand(template, {
        remotePythonFile: "/Workspace/Users/me/project/a.py",
        remoteRepoRoot: "/Workspace/Users/me/project",
        argv: ["/Workspace/Users/me/project/a.py", "x", "y"],
        // eslint-disable-next-line @typescript-eslint/naming-convention
        envVars: {HELLO: "world"},
    });
    assert.match(out, /python_file = "\/Workspace\/Users\/me\/project\/a\.py"/);
    assert.match(out, /repo_path = "\/Workspace\/Users\/me\/project"/);
    assert.match(
        out,
        /args = \['\/Workspace\/Users\/me\/project\/a\.py', 'x', 'y'\];/
    );
    assert.match(out, /env = \{"HELLO":"world"\}/);
});

test("isLikelyClusterId matches common cluster id format", () => {
    assert.equal(isLikelyClusterId("0123-456789-abcde123"), true);
    assert.equal(isLikelyClusterId("My Cluster"), false);
});

test("detectNotebookType detects ipynb and Databricks source notebooks", () => {
    assert.equal(detectNotebookType("ipynb", undefined), "IPYNB");
    assert.equal(detectNotebookType(".ipynb", undefined), "IPYNB");
    assert.equal(
        detectNotebookType("py", "# Databricks notebook source"),
        "PY_DBNB"
    );
    assert.equal(
        detectNotebookType("sql", "-- Databricks notebook source"),
        "OTHER_DBNB"
    );
    assert.equal(detectNotebookType("py", "print('x')"), undefined);
    assert.equal(
        detectNotebookType("py", "\uFEFF# Databricks notebook source"),
        "PY_DBNB"
    );
});

test("htmlToPlainText strips tags and decodes entities", () => {
    assert.equal(
        htmlToPlainText(
            "<div>Hello&nbsp;<b>world</b><br/>Line2 &lt;tag&gt;</div>"
        ),
        "Hello world\nLine2 <tag>"
    );
    assert.equal(htmlToPlainText("A&#10;B"), "A\nB");
});

test("extractNotebookTextOutputFromExportedHtml extracts stdout/stderr/error", () => {
    const model = {
        version: "NotebookV1",
        commands: [
            {
                results: {
                    data: [
                        {type: "ansi", name: "stdout", data: "hello\n"},
                        {type: "ansi", name: "stderr", data: "warn\n"},
                    ],
                },
            },
            {error: "Traceback...\n"},
        ],
    };
    const encoded = Buffer.from(
        encodeURIComponent(JSON.stringify(model)),
        "utf8"
    ).toString("base64");
    const html = `<script>var __DATABRICKS_NOTEBOOK_MODEL = '${encoded}';</script>`;

    const out = extractNotebookTextOutputFromExportedHtml(html);
    assert.ok(out);
    assert.equal(out.stdout, "hello");
    assert.equal(out.stderr, "warn");
    assert.equal(out.error, "Traceback...");
});

test("extractNotebookTextOutputFromExportedHtml includes mimeBundle text/plain results", () => {
    const model = {
        version: "NotebookV1",
        commands: [
            {
                results: {
                    /* eslint-disable @typescript-eslint/naming-convention */
                    data: [{type: "mimeBundle", data: {"text/plain": "2"}}],
                    /* eslint-enable @typescript-eslint/naming-convention */
                },
            },
        ],
    };
    const encoded = Buffer.from(
        encodeURIComponent(JSON.stringify(model)),
        "utf8"
    ).toString("base64");
    const html = `<script>var __DATABRICKS_NOTEBOOK_MODEL = '${encoded}';</script>`;

    const out = extractNotebookTextOutputFromExportedHtml(html);
    assert.ok(out);
    assert.equal(out.stdout, "2");
});
