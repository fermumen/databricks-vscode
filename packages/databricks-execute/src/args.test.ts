import assert from "node:assert/strict";
import test from "node:test";

import {parseCliArgs} from "./args";
import {UsageError} from "./output";

test("a bare file is an alias for run", () => {
    const parsed = parseCliArgs(["job.py", "--target", "dev", "--json"]);
    assert.equal(parsed.command, "run");
    assert.deepEqual(
        parsed.command === "run" && {
            file: parsed.file,
            target: parsed.target,
            json: parsed.json,
        },
        {file: "job.py", target: "dev", json: true}
    );
});

test("run parses widgets, timeout, serverless and script args", () => {
    const parsed = parseCliArgs([
        "run",
        "nb.ipynb",
        "--widget",
        "a=1",
        "--widget",
        "b=x=y",
        "--timeout",
        "60",
        "--serverless",
        "--",
        "--help",
        "-h",
    ]);
    assert.ok(parsed.command === "run");
    assert.deepEqual(parsed.widgets, {a: "1", b: "x=y"});
    assert.equal(parsed.timeoutSeconds, 60);
    assert.equal(parsed.serverless, true);
    assert.deepEqual(parsed.scriptArgs, ["--help", "-h"]);

    const scriptJson = parseCliArgs(["job.py", "--", "--json"]);
    assert.ok(scriptJson.command === "run");
    assert.equal(scriptJson.json, false);
    assert.deepEqual(scriptJson.scriptArgs, ["--json"]);
});

test("help is only detected before --", () => {
    assert.equal(parseCliArgs([]).command, "help");
    assert.equal(parseCliArgs(["run", "--help"]).command, "help");
    assert.equal(parseCliArgs(["session", "exec", "-h"]).command, "help");
    assert.equal(parseCliArgs(["job.py", "--", "-h"]).command, "run");
});

test("removed and invalid flags are usage errors", () => {
    for (const argv of [
        ["job.py", "--keep-context"],
        ["job.py", "--context-id", "123"],
        ["job.py", "--env", "A=1"],
        ["job.py", "--bogus"],
        ["job.py", "--widget", "novalue"],
        ["job.py", "--serverless", "--cluster", "c"],
        ["run"],
    ]) {
        assert.throws(() => parseCliArgs(argv), UsageError, argv.join(" "));
    }
    assert.throws(
        () => parseCliArgs(["job.py", "--keep-context"]),
        /session create/u
    );
});

test("session exec takes code from -c or stdin", () => {
    const parsed = parseCliArgs([
        "session",
        "exec",
        "-s",
        "etl",
        "-c",
        "1 + 1",
        "--sync",
        "--cluster",
        "c1",
    ]);
    assert.ok(parsed.command === "session");
    assert.equal(parsed.action, "exec");
    assert.equal(parsed.name, "etl");
    assert.equal(parsed.code, "1 + 1");
    assert.equal(parsed.sync, true);
    assert.equal(parsed.cluster, "c1");

    const fromStdin = parseCliArgs(["session", "exec", "-"]);
    assert.ok(fromStdin.command === "session");
    assert.equal(fromStdin.stdin, true);
    assert.equal(fromStdin.name, "default");
});

test("session arguments are validated per action", () => {
    for (const argv of [
        ["session"],
        ["session", "nope"],
        ["session", "exec"],
        ["session", "exec", "-c", "1", "-"],
        ["session", "exec", "-c", "1", "--force"],
        ["session", "create", "-c", "1"],
        ["session", "status", "--sync"],
        ["session", "create", "--serverless"],
        ["session", "create", "-s", "bad name"],
    ]) {
        assert.throws(() => parseCliArgs(argv), UsageError, argv.join(" "));
    }
    const create = parseCliArgs(["session", "create", "--force"]);
    assert.ok(create.command === "session" && create.force);
});
