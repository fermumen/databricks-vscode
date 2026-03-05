/* eslint-disable no-console */
const esbuild = require("esbuild");
const path = require("node:path");
const {spawnSync} = require("node:child_process");

async function main() {
    const projectRoot = path.resolve(__dirname, "..");
    const outdir = path.join(projectRoot, "dist-test");

    await esbuild.build({
        entryPoints: [
            path.join(projectRoot, "src", "core.ts"),
            path.join(projectRoot, "src", "core.test.ts"),
            path.join(projectRoot, "src", "init.test.ts"),
        ],
        outdir,
        bundle: false,
        platform: "node",
        format: "cjs",
        target: ["es2022"],
        sourcemap: "inline",
    });

    const result = spawnSync(
        process.execPath,
        ["--test", path.join(outdir, "core.test.js"), path.join(outdir, "init.test.js")],
        {stdio: "inherit", cwd: projectRoot}
    );
    process.exitCode = result.status ?? 1;
}

main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
