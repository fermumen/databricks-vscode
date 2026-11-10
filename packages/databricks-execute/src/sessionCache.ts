import {randomBytes} from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import {normalizeHost} from "./core";

export type SessionKey = {host: string; clusterId: string; name: string};

export type SessionEntry = SessionKey & {
    contextId: string;
    createdAt: string;
};

type CacheFile = {version: 1; sessions: Record<string, SessionEntry>};

export function normalizeHostKey(host: string): string {
    return normalizeHost(host.trim()).replace(/\/+$/u, "").toLowerCase();
}

function keyOf(key: SessionKey): string {
    return [normalizeHostKey(key.host), key.clusterId, key.name].join(" ");
}

/**
 * Maps session names to execution context ids. It is only a cache: callers
 * must check a context with the API before trusting an entry.
 */
export class SessionCache {
    constructor(readonly filePath: string) {}

    static defaultPath(): string {
        return path.join(os.tmpdir(), "databricks-execute", "sessions.json");
    }

    private async read(): Promise<CacheFile> {
        try {
            const parsed = JSON.parse(await fs.readFile(this.filePath, "utf8"));
            if (
                parsed?.version === 1 &&
                parsed.sessions &&
                typeof parsed.sessions === "object"
            ) {
                return parsed as CacheFile;
            }
        } catch {
            // Missing or corrupt: start empty.
        }
        return {version: 1, sessions: {}};
    }

    /** Write via temp file + rename so readers never see a partial file. */
    private async write(data: CacheFile) {
        await fs.mkdir(path.dirname(this.filePath), {recursive: true});
        const tmp = `${this.filePath}.${process.pid}.${randomBytes(4).toString(
            "hex"
        )}.tmp`;
        await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
        await fs.rename(tmp, this.filePath);
    }

    async get(key: SessionKey): Promise<SessionEntry | undefined> {
        return (await this.read()).sessions[keyOf(key)];
    }

    async set(entry: SessionEntry) {
        const data = await this.read();
        data.sessions[keyOf(entry)] = {
            ...entry,
            host: normalizeHostKey(entry.host),
        };
        await this.write(data);
    }

    async delete(key: SessionKey) {
        const data = await this.read();
        if (data.sessions[keyOf(key)]) {
            delete data.sessions[keyOf(key)];
            await this.write(data);
        }
    }

    async listForHost(host: string): Promise<SessionEntry[]> {
        const hostKey = normalizeHostKey(host);
        return Object.values((await this.read()).sessions).filter(
            (e) => e.host === hostKey
        );
    }
}
