/* eslint-disable no-console */
const esbuild = require("esbuild");
const path = require("node:path");
const {spawnSync} = require("node:child_process");

async function main() {
    const projectRoot = path.resolve(__dirname, "..");
    const outdir = path.join(projectRoot, "dist-test");

    await esbuild.build({
        entryPoints: [path.join(projectRoot, "src", "cli.integ.test.ts")],
        outdir,
        bundle: false,
        platform: "node",
        format: "cjs",
        target: ["es2022"],
        sourcemap: "inline",
    });

    const result = spawnSync(
        process.execPath,
        ["--test", path.join(outdir, "cli.integ.test.js")],
        {
            stdio: "inherit",
        }
    );
    process.exitCode = result.status ?? 1;
}

main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});

