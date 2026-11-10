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
    opts?: {cwd?: string; env?: Record<string, string>; input?: string}
): {code: number; stdout: string; stderr: string} {
    const result = spawnSync(command, args, {
        cwd: opts?.cwd,
        env: opts?.env ? {...process.env, ...opts.env} : process.env,
        input: opts?.input,
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

function parseJson(res: {stdout: string; stderr: string}): any {
    try {
        return JSON.parse(res.stdout);
    } catch {
        throw new Error(
            `expected one JSON object on stdout:\n${res.stdout}\n${res.stderr}`
        );
    }
}

test(
    "databricks-execute runs files as jobs and snippets in sessions",
    {
        timeout: 45 * 60 * 1000,
        skip: process.env.DATABRICKS_EXECUTE_INTEG !== "1",
    },
    async (t) => {
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
            'import sys\nprint("hello from plain", sys.argv[1:])\n',
            "utf8"
        );

        await fs.writeFile(
            path.join(tmp, "failing.py"),
            'print("before failure")\nraise ValueError("boom")\n',
            "utf8"
        );

        await fs.writeFile(
            path.join(tmp, "globals_check.py"),
            "print(type(spark).__name__, type(dbutils).__name__, spark.range(3).count())\n",
            "utf8"
        );

        await fs.writeFile(
            path.join(tmp, "slow.py"),
            "import time\ntime.sleep(900)\n",
            "utf8"
        );

        await fs.writeFile(
            path.join(tmp, "helper_mod.py"),
            "VALUE = 1\n",
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
        // Keep the session name cache away from the user's real one.
        const sessionTmp = await fs.mkdtemp(
            path.join(os.tmpdir(), "databricks-execute-integ-sessions-")
        );
        const cli = (args: string[], input?: string) =>
            run(process.execPath, [cliPath, ...args], {
                cwd: tmp,
                // eslint-disable-next-line @typescript-eslint/naming-convention
                env: {TMPDIR: sessionTmp},
                input,
            });
        const common = ["--target", "dev"];

        await t.test("notebook run prints expression results", () => {
            const res = cli([
                path.join(tmp, "expr.ipynb"),
                ...common,
                ...maybeStartCluster,
            ]);
            assert.equal(res.code, 0, `${res.stdout}\n${res.stderr}`);
            assert.match(res.stdout, /(^|\n)2(\n|$)/u, res.stdout);
        });

        await t.test("notebook run passes widgets", () => {
            const res = cli([
                "run",
                path.join(tmp, "widgets.py"),
                ...common,
                "--widget",
                "greeting=hello",
                "--widget",
                "subject=widgets",
                ...maybeStartCluster,
            ]);
            assert.equal(res.code, 0, `${res.stdout}\n${res.stderr}`);
            assert.match(
                res.stdout,
                /\{"greeting": "hello", "subject": "widgets"\}/u,
                res.stdout
            );
        });

        await t.test("plain .py runs as a job with script args", () => {
            const res = cli([
                "run",
                path.join(tmp, "plain.py"),
                ...common,
                "--json",
                ...maybeStartCluster,
                "--",
                "a",
                "b",
            ]);
            const json = parseJson(res);
            assert.equal(res.code, 0, `${res.stdout}\n${res.stderr}`);
            assert.equal(json.status, "ok");
            assert.equal(json.resultState, "SUCCESS");
            assert.ok(json.runId, "expected a runId");
            assert.match(json.stdout, /hello from plain \['a', 'b'\]/u);
        });

        await t.test("failing .py exits 1 with the traceback on stderr", () => {
            const res = cli([
                path.join(tmp, "failing.py"),
                ...common,
                ...maybeStartCluster,
            ]);
            assert.equal(res.code, 1, `${res.stdout}\n${res.stderr}`);
            assert.match(res.stdout, /before failure/u, res.stdout);
            assert.match(res.stderr, /ValueError/u, res.stderr);
            assert.match(res.stderr, /boom/u, res.stderr);
            t.diagnostic(
                `failing.py traceback mapped to local path: ${res.stderr.includes(
                    path.join(tmp, "failing.py")
                )}`
            );
        });

        // Spike 4: spark/dbutils through upstream's file.workflow-wrapper.py.
        await t.test("spark and dbutils resolve in a .py job", () => {
            const res = cli([
                path.join(tmp, "globals_check.py"),
                ...common,
                ...maybeStartCluster,
            ]);
            assert.equal(res.code, 0, `${res.stdout}\n${res.stderr}`);
            assert.match(res.stdout, /SparkSession \S+ 3/u, res.stdout);
        });

        await t.test("--timeout cancels the run and exits 124", () => {
            const res = cli([
                path.join(tmp, "slow.py"),
                ...common,
                "--timeout",
                "60",
                "--json",
                ...maybeStartCluster,
            ]);
            assert.equal(res.code, 124, `${res.stdout}\n${res.stderr}`);
            assert.equal(parseJson(res).status, "timeout");
        });

        await t.test("sessions keep state between snippets", () => {
            // Spike 1: create latency and exec round-trip.
            let started = Date.now();
            const create = cli([
                "session",
                "create",
                ...common,
                "--json",
                ...maybeStartCluster,
            ]);
            assert.equal(create.code, 0, `${create.stdout}\n${create.stderr}`);
            assert.equal(parseJson(create).status, "created");
            t.diagnostic(`session create took ${Date.now() - started}ms`);

            const again = cli(["session", "create", ...common, "--json"]);
            assert.equal(again.code, 0, `${again.stdout}\n${again.stderr}`);
            assert.equal(parseJson(again).status, "existing");

            started = Date.now();
            const first = cli([
                "session",
                "exec",
                ...common,
                "-c",
                "counter = 41\nprint(counter)",
            ]);
            assert.equal(first.code, 0, `${first.stdout}\n${first.stderr}`);
            assert.match(first.stdout, /(^|\n)41(\n|$)/u, first.stdout);
            t.diagnostic(`trivial session exec took ${Date.now() - started}ms`);

            // Spike 2: a bare last expression comes back as a text result.
            const second = cli(
                ["session", "exec", ...common, "--json", "-"],
                "counter += 1\ncounter\n"
            );
            const secondJson = parseJson(second);
            assert.equal(second.code, 0, `${second.stdout}\n${second.stderr}`);
            assert.match(secondJson.stdout, /42/u, second.stdout);

            const imported = cli([
                "session",
                "exec",
                ...common,
                "-c",
                "import helper_mod\nprint(helper_mod.VALUE)",
            ]);
            assert.equal(
                imported.code,
                0,
                `${imported.stdout}\n${imported.stderr}`
            );
            assert.match(imported.stdout, /(^|\n)1(\n|$)/u, imported.stdout);
        });

        await t.test("exec --sync reloads edited bundle modules", async () => {
            await fs.writeFile(
                path.join(tmp, "helper_mod.py"),
                "VALUE = 22\n",
                "utf8"
            );
            const res = cli([
                "session",
                "exec",
                ...common,
                "--sync",
                "-c",
                "import helper_mod\nprint(helper_mod.VALUE)",
            ]);
            assert.equal(res.code, 0, `${res.stdout}\n${res.stderr}`);
            assert.match(res.stdout, /(^|\n)22(\n|$)/u, res.stdout);
        });

        await t.test("a snippet that raises exits 1", () => {
            const res = cli([
                "session",
                "exec",
                ...common,
                "--json",
                "-c",
                'raise ValueError("boom")',
            ]);
            const json = parseJson(res);
            assert.equal(res.code, 1, `${res.stdout}\n${res.stderr}`);
            assert.equal(json.status, "error");
            assert.equal(json.error?.type, "ValueError");
            assert.match(json.error?.message ?? "", /boom/u);
        });

        // Spike 3: magics in a 1.2 context. Recorded, not asserted.
        await t.test("spike: %sql and %pip in a session", () => {
            for (const code of ["%sql SELECT 1 AS one", "%pip --version"]) {
                const res = cli([
                    "session",
                    "exec",
                    ...common,
                    "--json",
                    "-c",
                    code,
                ]);
                t.diagnostic(
                    `${code} -> exit ${res.code}: ${res.stdout.slice(0, 500)}`
                );
            }
        });

        await t.test("status, list and stop", () => {
            const status = cli(["session", "status", ...common]);
            assert.equal(status.code, 0, `${status.stdout}\n${status.stderr}`);
            assert.match(status.stdout, /running/u, status.stdout);

            const list = cli(["session", "list", ...common, "--json"]);
            assert.equal(list.code, 0, `${list.stdout}\n${list.stderr}`);
            assert.deepEqual(
                parseJson(list).sessions.map((s: any) => s.session),
                ["default"]
            );

            const stop = cli(["session", "stop", ...common]);
            assert.equal(stop.code, 0, `${stop.stdout}\n${stop.stderr}`);

            const after = cli(["session", "exec", ...common, "-c", "1"]);
            assert.equal(after.code, 3, `${after.stdout}\n${after.stderr}`);
        });

        // Spike 5: what the API returns for a context id that no longer
        // exists. The CLI must report it as lost (exit 3) and prune it.
        await t.test("a stale context id is reported as lost", async () => {
            const cacheFile = path.join(
                sessionTmp,
                "databricks-execute",
                "sessions.json"
            );
            const hostKey = (
                /^https?:\/\//iu.test(host) ? host : `https://${host}`
            )
                .replace(/\/+$/u, "")
                .toLowerCase();
            await fs.mkdir(path.dirname(cacheFile), {recursive: true});
            await fs.writeFile(
                cacheFile,
                JSON.stringify({
                    version: 1,
                    sessions: {
                        [`${hostKey} ${clusterId} stale`]: {
                            host: hostKey,
                            clusterId,
                            name: "stale",
                            contextId: "1234567890123456789",
                            createdAt: new Date().toISOString(),
                        },
                    },
                }),
                "utf8"
            );
            const res = cli([
                "session",
                "exec",
                ...common,
                "-s",
                "stale",
                "-c",
                "1",
            ]);
            t.diagnostic(`stale context -> exit ${res.code}: ${res.stderr}`);
            assert.equal(res.code, 3, `${res.stdout}\n${res.stderr}`);
            assert.match(res.stderr, /was lost/u, res.stderr);
            const status = cli(["session", "status", ...common, "-s", "stale"]);
            assert.equal(status.code, 3, `${status.stdout}\n${status.stderr}`);
        });
    }
);
