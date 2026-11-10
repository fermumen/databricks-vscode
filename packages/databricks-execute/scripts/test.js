/* eslint-disable no-console */
const esbuild = require("esbuild");
const path = require("node:path");
const {spawnSync} = require("node:child_process");

async function main() {
    const projectRoot = path.resolve(__dirname, "..");
    const outdir = path.join(projectRoot, "dist-test");

    await esbuild.build({
        entryPoints: [
            "core",
            "core.test",
            "init.test",
            "output",
            "args",
            "args.test",
            "sessionCache",
            "sessionCache.test",
        ].map((name) => path.join(projectRoot, "src", `${name}.ts`)),
        outdir,
        bundle: false,
        platform: "node",
        format: "cjs",
        target: ["es2022"],
        sourcemap: "inline",
    });

    const result = spawnSync(
        process.execPath,
        [
            "--test",
            ...["core", "init", "args", "sessionCache"].map((name) =>
                path.join(outdir, `${name}.test.js`)
            ),
        ],
        {stdio: "inherit", cwd: projectRoot}
    );
    process.exitCode = result.status ?? 1;
}

main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
