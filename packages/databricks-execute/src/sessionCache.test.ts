import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import test from "node:test";

import {SessionCache, normalizeHostKey} from "./sessionCache";

async function withCache(
    fn: (cache: SessionCache, dir: string) => Promise<void>
) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dbexec-sessions-"));
    try {
        await fn(
            new SessionCache(path.join(dir, "nested", "sessions.json")),
            dir
        );
    } finally {
        await fs.rm(dir, {recursive: true, force: true});
    }
}

const entry = {
    host: "https://adb-1.azuredatabricks.net",
    clusterId: "0123-456789-abcdef",
    bundleRoot: "/Workspace/Users/me/.bundle/a/dev/files",
    name: "default",
    contextId: "ctx-1",
    createdAt: "2026-01-01T00:00:00.000Z",
};

test("normalizeHostKey ignores scheme, case and trailing slashes", () => {
    assert.equal(
        normalizeHostKey("ADB-1.azuredatabricks.net/"),
        "https://adb-1.azuredatabricks.net"
    );
});

test("SessionCache stores entries by host, cluster, bundle and name", async () => {
    await withCache(async (cache) => {
        assert.equal(await cache.get(entry), undefined);

        await cache.set(entry);
        await cache.set({...entry, name: "other", contextId: "ctx-2"});
        await cache.set({
            ...entry,
            clusterId: "9999-999999-zzzzzz",
            contextId: "ctx-3",
        });
        await cache.set({
            ...entry,
            host: "https://another.cloud.databricks.com",
            contextId: "ctx-4",
        });
        await cache.set({
            ...entry,
            bundleRoot: "/Workspace/Users/me/.bundle/b/dev/files",
            contextId: "ctx-6",
        });
        assert.equal(
            (
                await cache.get({
                    ...entry,
                    bundleRoot: "/Workspace/Users/me/.bundle/b/dev/files",
                })
            )?.contextId,
            "ctx-6"
        );

        assert.equal(
            (await cache.get({...entry, host: "adb-1.azuredatabricks.net/"}))
                ?.contextId,
            "ctx-1"
        );
        assert.equal(
            (await cache.get({...entry, name: "other"}))?.contextId,
            "ctx-2"
        );
        assert.deepEqual(
            (await cache.listForBundle(entry.host, entry.bundleRoot))
                .map((e) => e.contextId)
                .sort(),
            ["ctx-1", "ctx-2", "ctx-3"]
        );

        await cache.set({...entry, contextId: "ctx-5"});
        assert.equal((await cache.get(entry))?.contextId, "ctx-5");

        await cache.delete(entry);
        assert.equal(await cache.get(entry), undefined);
        assert.equal(
            (await cache.listForBundle(entry.host, entry.bundleRoot)).length,
            2
        );
    });
});

test("SessionCache writes atomically and survives a corrupt file", async () => {
    await withCache(async (cache) => {
        await cache.set(entry);
        const files = await fs.readdir(path.dirname(cache.filePath));
        assert.deepEqual(files, ["sessions.json"]);

        await fs.writeFile(cache.filePath, "{not json", "utf8");
        assert.equal(await cache.get(entry), undefined);
        await cache.set(entry);
        assert.equal((await cache.get(entry))?.contextId, "ctx-1");
    });
});
