import {spawn} from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";
import * as readline from "node:readline/promises";

import * as YAML from "yaml";

import {normalizeHost} from "./core";

type InitOptions = {
    host?: string;
    cluster?: string;
    target?: string;
    name?: string;
};

function parseInitArgs(argv: string[]): InitOptions {
    const options: InitOptions = {};

    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];

        if (a === "--help" || a === "-h") {
            printInitHelp();
            process.exit(0);
        }

        const next = () => {
            const v = argv[i + 1];
            if (v === undefined) {
                throw new Error(`Missing value for ${a}`);
            }
            i++;
            return v;
        };

        switch (a) {
            case "--host":
                options.host = next();
                break;
            case "--cluster":
                options.cluster = next();
                break;
            case "--target":
                options.target = next();
                break;
            case "--name":
                options.name = next();
                break;
            default:
                throw new Error(`Unknown init argument: ${a}`);
        }
    }

    return options;
}

function printInitHelp() {
    // eslint-disable-next-line no-console
    console.log(
        [
            "Usage:",
            "  databricks-execute init [options]",
            "",
            "Creates or updates databricks.yml with a target for databricks-execute.",
            "",
            "Options:",
            "  --host <url>       Databricks workspace host",
            "  --cluster <id>     Cluster ID",
            "  --target <name>    Target name (default: dbexec)",
            "  --name <name>      Bundle name (default: directory name)",
            "  --help             Show help",
        ].join("\n")
    );
}

async function prompt(
    rl: readline.Interface,
    question: string,
    defaultValue?: string
): Promise<string> {
    const suffix = defaultValue ? ` [${defaultValue}]` : "";
    const answer = await rl.question(`${question}${suffix}: `);
    return answer.trim() || defaultValue || "";
}

async function runCommand(
    cmd: string,
    args: string[]
): Promise<{stdout: string; stderr: string; code: number}> {
    return await new Promise((resolve, reject) => {
        const child = spawn(cmd, args, {stdio: "pipe"});
        const stdout: string[] = [];
        const stderr: string[] = [];

        child.on("error", reject);
        if (child.stdout) {
            child.stdout.on("data", (d) => stdout.push(d.toString()));
        }
        if (child.stderr) {
            child.stderr.on("data", (d) => stderr.push(d.toString()));
        }
        child.on("close", (code) => {
            resolve({
                stdout: stdout.join(""),
                stderr: stderr.join(""),
                code: code ?? 0,
            });
        });
    });
}

export async function runInit(argv: string[]): Promise<void> {
    const options = parseInitArgs(argv);

    const targetName = options.target || "dbexec";
    const bundleName = options.name || path.basename(process.cwd());
    const bundlePath = path.join(process.cwd(), "databricks.yml");

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    try {
        let host = options.host;
        if (!host) {
            host = await prompt(rl, "Databricks workspace host");
            if (!host) {
                throw new Error(
                    "Host is required. Provide --host or enter it when prompted."
                );
            }
        }
        host = normalizeHost(host);

        let clusterId = options.cluster;
        if (!clusterId) {
            clusterId = await prompt(rl, "Cluster ID");
            if (!clusterId) {
                throw new Error(
                    "Cluster ID is required. Provide --cluster or enter it when prompted."
                );
            }
        }

        let existing: any = undefined;
        let existingRaw: string | undefined;
        try {
            existingRaw = await fs.readFile(bundlePath, "utf8");
            existing = YAML.parse(existingRaw);
        } catch {
            // No existing file, will create new.
        }

        if (existing && typeof existing === "object") {
            if (!existing.targets) {
                existing.targets = {};
            }
            if (existing.targets[targetName]) {
                // eslint-disable-next-line no-console
                console.log(
                    `Warning: target '${targetName}' already exists in databricks.yml and will be overwritten.`
                );
            }
            /* eslint-disable @typescript-eslint/naming-convention */
            existing.targets[targetName] = {
                mode: "development",
                default: true,
                cluster_id: clusterId,
                workspace: {host},
            };
            /* eslint-enable @typescript-eslint/naming-convention */

            await fs.writeFile(bundlePath, YAML.stringify(existing), "utf8");
            // eslint-disable-next-line no-console
            console.log(
                `Updated databricks.yml: added target '${targetName}'.`
            );
        } else {
            /* eslint-disable @typescript-eslint/naming-convention */
            const doc = {
                bundle: {name: bundleName},
                targets: {
                    [targetName]: {
                        mode: "development",
                        default: true,
                        cluster_id: clusterId,
                        workspace: {host},
                    },
                },
            };
            /* eslint-enable @typescript-eslint/naming-convention */

            await fs.writeFile(bundlePath, YAML.stringify(doc), "utf8");
            // eslint-disable-next-line no-console
            console.log(`Created databricks.yml with target '${targetName}'.`);
        }

        // Verify auth works with the configured host.
        // eslint-disable-next-line no-console
        console.log(`\nVerifying authentication for ${host} ...`);
        try {
            const authResult = await runCommand("databricks", [
                "auth",
                "env",
                "--host",
                host,
                "-o",
                "json",
            ]);
            if (authResult.code === 0) {
                const authJson = JSON.parse(authResult.stdout);
                if (authJson?.env?.DATABRICKS_TOKEN) {
                    // eslint-disable-next-line no-console
                    console.log("Authentication OK.");
                } else {
                    // eslint-disable-next-line no-console
                    console.log(
                        `No token resolved. Run: databricks auth login --host ${host}`
                    );
                }
            } else {
                // eslint-disable-next-line no-console
                console.log(
                    `Auth check failed. Run: databricks auth login --host ${host}`
                );
            }
        } catch {
            // eslint-disable-next-line no-console
            console.log(
                "Could not verify auth (is the Databricks CLI installed?)."
            );
        }
    } finally {
        rl.close();
    }
}
