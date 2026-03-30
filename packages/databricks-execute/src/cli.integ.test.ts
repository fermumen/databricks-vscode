import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

function run(
    command: string,
    args: string[],
    opts?: {cwd?: string; env?: Record<string, string>}
): {code: number; stdout: string; stderr: string} {
    const result = spawnSync(command, args, {
        cwd: opts?.cwd,
        env: opts?.env ? {...process.env, ...opts.env} : process.env,
        encoding: "utf8",
    });
    return {
        code: result.status ?? 1,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
    };
}

function getDatabricksHost(): string | undefined {
    if (process.env.DATABRICKS_HOST) {
        return process.env.DATABRICKS_HOST;
    }

    const res = run("databricks", ["auth", "env", "-o", "json"]);
    if (res.code !== 0) {
        return;
    }

    try {
        const parsed = JSON.parse(res.stdout) as {
            env?: Record<string, string>;
        };
        return parsed.env?.DATABRICKS_HOST;
    } catch {
        return;
    }
}

function getCurrentUserName(): string | undefined {
    const res = run("databricks", ["current-user", "me", "-o", "json"]);
    if (res.code !== 0) {
        return;
    }

    try {
        const parsed = JSON.parse(res.stdout) as {userName?: string};
        return parsed.userName;
    } catch {
        return;
    }
}

test(
    "databricks-execute notebook mode prints expression results",
    {
        timeout: 30 * 60 * 1000,
        skip: process.env.DATABRICKS_EXECUTE_INTEG !== "1",
    },
    async () => {
        const clusterId = process.env.DATABRICKS_EXECUTE_CLUSTER_ID;
        if (!clusterId) {
            throw new Error(
                "Missing DATABRICKS_EXECUTE_CLUSTER_ID (cluster id to run integration tests on)."
            );
        }

        const host = getDatabricksHost();
        if (!host) {
            throw new Error(
                "Could not determine DATABRICKS_HOST. Set it explicitly or ensure `databricks auth login` is configured."
            );
        }

        // Validate CLI exists.
        const version = run("databricks", ["--version"]);
        assert.equal(
            version.code,
            0,
            `databricks CLI not available: ${version.stderr || version.stdout}`
        );

        const userName = getCurrentUserName();
        if (!userName) {
            throw new Error(
                "Could not determine current user (databricks current-user me)."
            );
        }

        const bundleName = `databricks-execute-integ-${Date.now()}`;
        const rootPath = `/Workspace/Users/${userName}/.bundle/${bundleName}`;

        const tmp = await fs.mkdtemp(
            path.join(os.tmpdir(), "databricks-execute-integ-")
        );

        const bundleYml = [
            "bundle:",
            `  name: ${bundleName}`,
            "",
            "targets:",
            "  dev:",
            "    mode: development",
            "    default: true",
            `    cluster_id: "${clusterId}"`,
            "    workspace:",
            `      host: "${host}"`,
            `      root_path: "${rootPath}"`,
            "",
        ].join("\n");

        await fs.writeFile(path.join(tmp, "databricks.yml"), bundleYml, "utf8");

        /* eslint-disable @typescript-eslint/naming-convention */
        const nb = {
            cells: [
                {
                    cell_type: "code",
                    execution_count: null,
                    metadata: {},
                    outputs: [],
                    source: ["1+1\n"],
                },
            ],
            metadata: {language_info: {name: "python"}},
            nbformat: 4,
            nbformat_minor: 5,
        };
        /* eslint-enable @typescript-eslint/naming-convention */
        await fs.writeFile(
            path.join(tmp, "expr.ipynb"),
            JSON.stringify(nb, null, 2),
            "utf8"
        );

        await fs.writeFile(
            path.join(tmp, "plain.py"),
            'print("hello from plain")\n',
            "utf8"
        );

        await fs.writeFile(
            path.join(tmp, "repl_init.py"),
            "counter = 41\nprint(counter)\n",
            "utf8"
        );

        await fs.writeFile(
            path.join(tmp, "repl_next.py"),
            "counter += 1\nprint(counter)\n",
            "utf8"
        );

        await fs.writeFile(
            path.join(tmp, "widgets.py"),
            [
                "# Databricks notebook source",
                "",
                "# COMMAND ----------",
                'dbutils.widgets.text("greeting", "hello")',
                'dbutils.widgets.text("subject", "world")',
                "",
                "# COMMAND ----------",
                "import json",
                "",
                'print(json.dumps({"greeting": dbutils.widgets.get("greeting"), "subject": dbutils.widgets.get("subject")}, sort_keys=True))',
                "",
            ].join("\n"),
            "utf8"
        );

        const cliPath = path.resolve(__dirname, "..", "dist", "cli.js");
        const maybeStartCluster =
            process.env.DATABRICKS_EXECUTE_INTEG_START_CLUSTER === "1"
                ? ["--start-cluster"]
                : [];

        const notebookRun = run(process.execPath, [
            cliPath,
            path.join(tmp, "expr.ipynb"),
            "--target",
            "dev",
            ...maybeStartCluster,
        ]);
        assert.equal(
            notebookRun.code,
            0,
            `notebook run failed:\n${notebookRun.stdout}\n${notebookRun.stderr}`
        );
        assert.match(
            notebookRun.stdout,
            /(^|\n)2(\n|$)/u,
            `expected expression output '2' in stdout:\n${notebookRun.stdout}`
        );

        const widgetRun = run(process.execPath, [
            cliPath,
            path.join(tmp, "widgets.py"),
            "--target",
            "dev",
            "--widget",
            "greeting=hello",
            "--widget",
            "subject=widgets",
            ...maybeStartCluster,
        ]);
        assert.equal(
            widgetRun.code,
            0,
            `widget notebook run failed:\n${widgetRun.stdout}\n${widgetRun.stderr}`
        );
        assert.match(
            widgetRun.stdout,
            /\{"greeting": "hello", "subject": "widgets"\}/u,
            `expected widget output in stdout:\n${widgetRun.stdout}`
        );

        const plainRun = run(process.execPath, [
            cliPath,
            path.join(tmp, "plain.py"),
            "--target",
            "dev",
            ...maybeStartCluster,
        ]);
        assert.equal(
            plainRun.code,
            0,
            `plain python run failed:\n${plainRun.stdout}\n${plainRun.stderr}`
        );
        assert.match(
            plainRun.stdout,
            /hello from plain/u,
            `expected 'hello from plain' in stdout:\n${plainRun.stdout}`
        );

        const replInitRun = run(process.execPath, [
            cliPath,
            path.join(tmp, "repl_init.py"),
            "--target",
            "dev",
            "--keep-context",
            ...maybeStartCluster,
        ]);
        assert.equal(
            replInitRun.code,
            0,
            `repl init run failed:\n${replInitRun.stdout}\n${replInitRun.stderr}`
        );
        assert.match(
            replInitRun.stdout,
            /(^|\n)41(\n|$)/u,
            `expected '41' in stdout:\n${replInitRun.stdout}`
        );

        const contextIdMatch = replInitRun.stdout.match(
            /Execution context ID: (\S+)/u
        );
        assert.ok(
            contextIdMatch,
            `expected execution context id in stdout:\n${replInitRun.stdout}`
        );

        const replNextRun = run(process.execPath, [
            cliPath,
            path.join(tmp, "repl_next.py"),
            "--target",
            "dev",
            "--context-id",
            contextIdMatch[1],
            ...maybeStartCluster,
        ]);
        assert.equal(
            replNextRun.code,
            0,
            `repl follow-up run failed:\n${replNextRun.stdout}\n${replNextRun.stderr}`
        );
        assert.match(
            replNextRun.stdout,
            /(^|\n)42(\n|$)/u,
            `expected '42' in stdout:\n${replNextRun.stdout}`
        );
    }
);
