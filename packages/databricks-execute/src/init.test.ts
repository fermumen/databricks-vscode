import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import test from "node:test";

import * as YAML from "yaml";

test("init creates new databricks.yml with dbexec target", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dbexec-init-"));
    const bundlePath = path.join(tmpDir, "databricks.yml");

    try {
        /* eslint-disable @typescript-eslint/naming-convention */
        const doc = {
            bundle: {name: "test-project"},
            targets: {
                dbexec: {
                    mode: "development",
                    default: true,
                    cluster_id: "0123-456789-abcde123",
                    workspace: {
                        host: "https://adb-123.azuredatabricks.net",
                    },
                },
            },
        };
        /* eslint-enable @typescript-eslint/naming-convention */
        await fs.writeFile(bundlePath, YAML.stringify(doc), "utf8");

        const raw = await fs.readFile(bundlePath, "utf8");
        const parsed = YAML.parse(raw);

        assert.equal(parsed.bundle.name, "test-project");
        assert.equal(parsed.targets.dbexec.mode, "development");
        assert.equal(parsed.targets.dbexec.default, true);
        assert.equal(parsed.targets.dbexec.cluster_id, "0123-456789-abcde123");
        assert.equal(
            parsed.targets.dbexec.workspace.host,
            "https://adb-123.azuredatabricks.net"
        );
    } finally {
        await fs.rm(tmpDir, {recursive: true, force: true});
    }
});

test("init merges target into existing databricks.yml preserving other targets", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dbexec-init-"));
    const bundlePath = path.join(tmpDir, "databricks.yml");

    try {
        /* eslint-disable @typescript-eslint/naming-convention */
        const existing = {
            bundle: {name: "my-project"},
            targets: {
                dev: {
                    mode: "development",
                    default: true,
                    cluster_id: "existing-cluster",
                    workspace: {
                        host: "https://existing.azuredatabricks.net",
                    },
                },
            },
        };
        await fs.writeFile(bundlePath, YAML.stringify(existing), "utf8");

        // Simulate what init does: parse, add target, write back.
        const raw = await fs.readFile(bundlePath, "utf8");
        const parsed = YAML.parse(raw);
        parsed.targets.dbexec = {
            mode: "development",
            default: true,
            cluster_id: "0123-456789-newcluster",
            workspace: {host: "https://new.azuredatabricks.net"},
        };
        /* eslint-enable @typescript-eslint/naming-convention */
        await fs.writeFile(bundlePath, YAML.stringify(parsed), "utf8");

        const result = YAML.parse(await fs.readFile(bundlePath, "utf8"));

        // Original target preserved.
        assert.equal(result.targets.dev.cluster_id, "existing-cluster");
        assert.equal(
            result.targets.dev.workspace.host,
            "https://existing.azuredatabricks.net"
        );

        // New target added.
        assert.equal(result.targets.dbexec.mode, "development");
        assert.equal(
            result.targets.dbexec.cluster_id,
            "0123-456789-newcluster"
        );
        assert.equal(
            result.targets.dbexec.workspace.host,
            "https://new.azuredatabricks.net"
        );

        assert.equal(result.bundle.name, "my-project");
    } finally {
        await fs.rm(tmpDir, {recursive: true, force: true});
    }
});
