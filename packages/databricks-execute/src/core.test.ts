import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
    coalesce,
    createProgressReporter,
    detectNotebookType,
    extractNotebookTextOutputFromExportedHtml,
    formatTableResult,
    htmlToPlainText,
    isLikelyClusterId,
    isValidSessionName,
    localPathToRemoteWorkspacePath,
    moduleUnloadCommand,
    normalizeHost,
    normalizeWorkspacePath,
    parseKeyValueOption,
    parseTimeoutSeconds,
    remapRemotePaths,
    remoteWorkspacePathToLocalPath,
    renderWorkflowWrapper,
    sessionSetupCommand,
    stripAnsi,
    summarizePythonError,
    workflowWrapperPath,
    workspacePrefixedPath,
} from "./core";

const hasPython =
    spawnSync("python3", ["--version"], {stdio: "ignore"}).status === 0;

function withTmpDir<T>(fn: (dir: string) => T): T {
    const dir = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), "dbexec-core-"))
    );
    try {
        return fn(dir);
    } finally {
        fs.rmSync(dir, {recursive: true, force: true});
    }
}

test("createProgressReporter reports changes immediately and unchanged heartbeats", () => {
    const reports: string[] = [];
    let currentTime = 1_000;
    const report = createProgressReporter(
        (state: string) => reports.push(state),
        60_000,
        () => currentTime
    );

    report("PENDING");
    currentTime += 10_000;
    report("PENDING");
    currentTime += 50_000;
    report("PENDING");
    currentTime += 1_000;
    report("RUNNING");
    currentTime += 59_999;
    report("RUNNING");
    currentTime += 1;
    report("RUNNING");

    assert.deepEqual(reports, ["PENDING", "PENDING", "RUNNING", "RUNNING"]);
});

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

test("parseKeyValueOption splits KEY=VALUE pairs", () => {
    assert.deepEqual(parseKeyValueOption("name=databricks", "--widget"), {
        key: "name",
        value: "databricks",
    });
    assert.deepEqual(parseKeyValueOption("empty=", "--widget"), {
        key: "empty",
        value: "",
    });
    assert.deepEqual(parseKeyValueOption("a=b=c", "--widget"), {
        key: "a",
        value: "b=c",
    });
    assert.throws(
        () => parseKeyValueOption("missing", "--widget"),
        /Invalid --widget value/
    );
    assert.throws(
        () => parseKeyValueOption("=missing-key", "--widget"),
        /Invalid --widget value/
    );
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

test("workflowWrapperPath mirrors upstream's getWrapperPath", () => {
    assert.equal(
        workflowWrapperPath("/Users/me/p/src/job.py"),
        "/Users/me/p/src/job.databricks.file.workflow-wrapper.py"
    );
    assert.equal(
        workflowWrapperPath("/Users/me/p/a.b.py"),
        "/Users/me/p/a.b.databricks.file.workflow-wrapper.py"
    );
});

const wrapperTemplatePath = path.resolve(
    __dirname,
    "../../databricks-vscode/resources/python/file.workflow-wrapper.py"
);

test("renderWorkflowWrapper fills every placeholder in upstream's template", () => {
    const out = renderWorkflowWrapper(
        fs.readFileSync(wrapperTemplatePath, "utf8"),
        {
            sourceFile: "/Workspace/Users/me/p/src/job.py",
            projectRoot: "/Workspace/Users/me/p",
        }
    );
    assert.doesNotMatch(out, /\{\{DATABRICKS_/u);
    assert.match(
        out,
        /python_file = '\/Workspace\/Users\/me\/p\/src\/job\.py'/u
    );
    assert.match(out, /project_root = '\/Workspace\/Users\/me\/p'/u);
});

test(
    "rendered workflow wrapper runs the file with cwd and sys.path set",
    {skip: !hasPython && "python3 not available"},
    () =>
        withTmpDir((dir) => {
            fs.mkdirSync(path.join(dir, "src"));
            const source = path.join(dir, "src", "job.py");
            fs.writeFileSync(
                source,
                "import os, sys\nprint(__name__, os.getcwd(), sys.path[0], sys.argv[1:])\n"
            );
            const stubs =
                "display = displayHTML = dbutils = table = sql = udf = None\n" +
                "getArgument = sc = spark = sqlContext = None\n";
            const wrapper = path.join(dir, "wrapper.py");
            fs.writeFileSync(
                wrapper,
                stubs +
                    renderWorkflowWrapper(
                        fs.readFileSync(wrapperTemplatePath, "utf8"),
                        {sourceFile: source, projectRoot: dir}
                    )
            );
            const result = spawnSync("python3", [wrapper, "a", "b"], {
                encoding: "utf8",
            });
            assert.equal(result.status, 0, result.stderr);
            assert.equal(
                result.stdout.trim(),
                `__main__ ${path.join(dir, "src")} ${dir} ['a', 'b']`
            );
        })
);

test("remapRemotePaths maps bundle paths to local paths", () => {
    const localRoot = path.join(path.sep, "home", "me", "proj");
    const remoteRoot = "/Workspace/Users/me/.bundle/proj/dev/files";
    const trace = [
        'File "/Workspace/Users/me/.bundle/proj/dev/files/src/a.py", line 3, in <module>',
        "File /Users/me/.bundle/proj/dev/files/src/b.py:4",
        'File "/Workspace/Users/me/.bundle/proj/dev/files/src/a.databricks.file.workflow-wrapper.py", line 9',
        'File "/databricks/python/lib/runpy.py", line 1',
    ].join("\n");
    const out = remapRemotePaths(trace, localRoot, remoteRoot).split("\n");
    assert.equal(
        out[0],
        `File "${path.join(localRoot, "src", "a.py")}", line 3, in <module>`
    );
    assert.equal(out[1], `File ${path.join(localRoot, "src", "b.py")}:4`);
    assert.equal(out[2], trace.split("\n")[2]);
    assert.equal(out[3], trace.split("\n")[3]);
});

test("summarizePythonError prefers the API summary, then the traceback", () => {
    assert.deepEqual(
        summarizePythonError(
            "<span class='ansi-red-fg'>ValueError</span>: boom",
            undefined
        ),
        {type: "ValueError", message: "boom"}
    );
    assert.deepEqual(
        summarizePythonError(
            undefined,
            "Traceback (most recent call last):\n  File \"/x.py\", line 1\n\u001b[0;31mKeyError\u001b[0m: 'k'\n"
        ),
        {type: "KeyError", message: "'k'"}
    );
    assert.deepEqual(summarizePythonError(undefined, "something odd"), {
        type: "Error",
        message: "something odd",
    });
});

test("stripAnsi removes colour codes", () => {
    assert.equal(stripAnsi("\u001b[0;31mred\u001b[0m plain"), "red plain");
});

test("formatTableResult renders a header and tab-separated rows", () => {
    assert.equal(
        formatTableResult(
            [
                [1, "a", null],
                [2, "b", {x: 1}],
            ],
            [{name: "id"}, {name: "name"}, {name: "extra"}]
        ),
        'id\tname\textra\n1\ta\tnull\n2\tb\t{"x":1}'
    );
    assert.equal(formatTableResult(undefined, undefined), "");
});

test(
    "session snippets add the bundle to sys.path and reload edited modules",
    {skip: !hasPython && "python3 not available"},
    () =>
        withTmpDir((dir) => {
            const root = path.join(dir, "bundle");
            fs.mkdirSync(root);
            fs.writeFileSync(path.join(root, "mod.py"), "VALUE = 1\n");
            const script = path.join(dir, "session.py");
            fs.writeFileSync(
                script,
                [
                    "import json, os, sys",
                    "ns = {}",
                    "exec(sys.argv[1], ns)",
                    "exec('import mod', ns)",
                    "first = ns['mod'].VALUE",
                    `open(os.path.join(${JSON.stringify(
                        root
                    )}, 'mod.py'), 'w').write('VALUE = 22\\n')`,
                    "exec('import mod', ns)",
                    "cached = ns['mod'].VALUE",
                    "exec(sys.argv[2], ns)",
                    "exec('import mod', ns)",
                    "print(json.dumps({'first': first, 'cached': cached, 'reloaded': ns['mod'].VALUE,",
                    "  'cwd': os.getcwd(), 'leftovers': sorted(k for k in ns if k.startswith('_databricks'))}))",
                ].join("\n")
            );
            const result = spawnSync(
                "python3",
                [
                    "-B",
                    script,
                    sessionSetupCommand(root),
                    moduleUnloadCommand(root),
                ],
                {encoding: "utf8", cwd: dir}
            );
            assert.equal(result.status, 0, result.stderr);
            assert.deepEqual(JSON.parse(result.stdout), {
                first: 1,
                cached: 1,
                reloaded: 22,
                cwd: root,
                leftovers: [],
            });
        })
);

test("parseTimeoutSeconds accepts positive whole seconds", () => {
    assert.equal(parseTimeoutSeconds("90"), 90);
    assert.throws(() => parseTimeoutSeconds("0"), /Invalid --timeout/u);
    assert.throws(() => parseTimeoutSeconds("1.5"), /Invalid --timeout/u);
    assert.throws(() => parseTimeoutSeconds("10m"), /Invalid --timeout/u);
});

test("isValidSessionName allows short identifier-like names", () => {
    assert.equal(isValidSessionName("default"), true);
    assert.equal(isValidSessionName("etl-2.run_1"), true);
    assert.equal(isValidSessionName(""), false);
    assert.equal(isValidSessionName("-x"), false);
    assert.equal(isValidSessionName("a b"), false);
    assert.equal(isValidSessionName("x".repeat(65)), false);
});
