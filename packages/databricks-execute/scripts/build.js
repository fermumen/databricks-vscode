/* eslint-disable no-console */
const esbuild = require("esbuild");
const fs = require("node:fs/promises");
const path = require("node:path");
const {spawnSync} = require("node:child_process");

const args = process.argv.slice(2);
const watch = args.includes("--watch");

const projectRoot = path.resolve(__dirname, "..");
const entryPoint = path.join(projectRoot, "src", "cli.ts");
const outfile = path.join(projectRoot, "dist", "cli.js");

const banner = `#!/usr/bin/env node
const __buffer = require("buffer");
if (!("SlowBuffer" in __buffer)) __buffer.SlowBuffer = __buffer.Buffer;
`;

// The Databricks SDK used by this repo is vendored (not available on npm as @databricks/databricks-sdk).
// We inline it into the final CLI bundle at build time, so npm installs don’t rely on a local tarball.
const vendoredSdkTgz = path.resolve(
    projectRoot,
    "..",
    "..",
    "vendor",
    "databricks-sdk.tgz"
);
const vendoredSdkExtractDir = path.join(
    projectRoot,
    "dist-vendor",
    "databricks-sdk"
);

async function ensureVendoredSdkExtracted() {
    try {
        await fs.access(path.join(vendoredSdkExtractDir, "dist", "index.js"));
        return;
    } catch {}

    await fs.rm(vendoredSdkExtractDir, {recursive: true, force: true});
    await fs.mkdir(vendoredSdkExtractDir, {recursive: true});

    const res = spawnSync(
        "tar",
        [
            "-xzf",
            vendoredSdkTgz,
            "-C",
            vendoredSdkExtractDir,
            "--strip-components=1",
        ],
        {stdio: "inherit"}
    );
    if ((res.status ?? 1) !== 0) {
        throw new Error(
            `Failed to extract vendored Databricks SDK from ${vendoredSdkTgz}`
        );
    }
}

async function build() {
    await fs.mkdir(path.dirname(outfile), {recursive: true});
    await ensureVendoredSdkExtracted();

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
        // Keep these as runtime deps (the vendored SDK requires them).
        external: ["reflect-metadata", "ini", "semver", "google-auth-library"],
        plugins: [
            {
                name: "vendored-databricks-sdk",
                setup(build) {
                    build.onResolve(
                        {filter: /^@databricks\/databricks-sdk(\/.*)?$/},
                        async (args) => {
                            const subpath = args.path.replace(
                                /^@databricks\/databricks-sdk\/?/,
                                ""
                            );
                            let resolved =
                                subpath.length === 0
                                    ? path.join(
                                          vendoredSdkExtractDir,
                                          "dist",
                                          "index.js"
                                      )
                                    : path.join(vendoredSdkExtractDir, subpath);

                            try {
                                const st = await fs.stat(resolved);
                                if (st.isDirectory()) {
                                    resolved = path.join(resolved, "index.js");
                                }
                            } catch {}

                            return {path: resolved};
                        }
                    );
                },
            },
            ...(watch
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
                : []),
        ],
    };

    if (watch) {
        const ctx = await esbuild.context(buildOptions);
        await ctx.watch();
        return;
    }

    await esbuild.build(buildOptions);
    await fs.chmod(outfile, 0o755);
}

build().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});

