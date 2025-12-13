/* eslint-disable no-console */
const esbuild = require("esbuild");
const fs = require("node:fs/promises");
const path = require("node:path");

const args = process.argv.slice(2);
const watch = args.includes("--watch");

const projectRoot = path.resolve(__dirname, "..");
const entryPoint = path.join(projectRoot, "src", "cli.ts");
const outfile = path.join(projectRoot, "dist", "cli.js");

const banner = `#!/usr/bin/env node
const __buffer = require("buffer");
if (!("SlowBuffer" in __buffer)) __buffer.SlowBuffer = __buffer.Buffer;
`;

async function build() {
    await fs.mkdir(path.dirname(outfile), {recursive: true});

    const buildOptions = {
        entryPoints: [entryPoint],
        outfile,
        bundle: true,
        platform: "node",
        format: "cjs",
        target: ["es2022"],
        sourcemap: true,
        banner: {js: banner},
        loader: {".py": "text"},
        external: ["@databricks/databricks-sdk"],
        plugins: watch
            ? [
                  {
                      name: "rebuild-log",
                      setup(build) {
                          build.onEnd((result) => {
                              if (result.errors.length > 0) {
                                  console.error("Rebuild failed");
                              } else {
                                  console.log("Rebuilt");
                              }
                          });
                      },
                  },
              ]
            : [],
    };

    if (watch) {
        const ctx = await esbuild.context(buildOptions);
        await ctx.watch();
        return;
    }

    await esbuild.build(buildOptions);

    if (!watch) {
        await fs.chmod(outfile, 0o755);
    }
}

build().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
