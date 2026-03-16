/* eslint-disable no-console */
const fs = require("node:fs/promises");
const path = require("node:path");
const {spawnSync} = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");
const buildScriptPath = path.join(projectRoot, "scripts", "build.js");
const entryPoint = path.join(projectRoot, "dist", "cli.js");
const defaultBunBuildArgs = [
    "--minify",
    "--sourcemap",
    "--bytecode",
    "--no-compile-autoload-dotenv",
    "--no-compile-autoload-bunfig",
];

function printHelp() {
    console.log(
        [
            "Usage:",
            "  node scripts/build-binary.js [--target <bun-target>] [--outfile <path>] [bun build args...]",
            "",
            "Defaults:",
            `  ${defaultBunBuildArgs.join(" ")}`,
            "",
            "Examples:",
            "  node scripts/build-binary.js",
            "  node scripts/build-binary.js --target bun-linux-x64",
            "  node scripts/build-binary.js --target bun-linux-x64-baseline",
            "  node scripts/build-binary.js --target bun-windows-x64 --outfile dist/databricks-execute.exe",
        ].join("\n")
    );
}

function inferOutfile(target) {
    const isWindows =
        target !== undefined
            ? target.includes("windows")
            : process.platform === "win32";
    const targetSuffix =
        target === undefined
            ? ""
            : `-${target.replace(/^bun-/u, "").replace(/[^a-z0-9.-]/giu, "-")}`;
    return path.join(
        projectRoot,
        "dist",
        `databricks-execute${targetSuffix}${isWindows ? ".exe" : ""}`
    );
}

function run(command, args, errorMessage) {
    const result = spawnSync(command, args, {
        cwd: projectRoot,
        stdio: "inherit",
    });

    if (result.error) {
        if (result.error.code === "ENOENT") {
            throw new Error(errorMessage);
        }
        throw result.error;
    }

    if (result.status !== 0) {
        process.exit(result.status ?? 1);
    }
}

async function main() {
    const args = process.argv.slice(2);
    let target;
    let outfile;
    const bunArgs = [];

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg === "--help" || arg === "-h") {
            printHelp();
            return;
        }

        if (arg === "--target") {
            const value = args[i + 1];
            if (!value) {
                throw new Error("Missing value for --target");
            }
            target = value;
            i++;
            continue;
        }

        if (arg.startsWith("--target=")) {
            target = arg.slice("--target=".length);
            continue;
        }

        if (arg === "--outfile") {
            const value = args[i + 1];
            if (!value) {
                throw new Error("Missing value for --outfile");
            }
            outfile = path.resolve(projectRoot, value);
            i++;
            continue;
        }

        if (arg.startsWith("--outfile=")) {
            outfile = path.resolve(projectRoot, arg.slice("--outfile=".length));
            continue;
        }

        bunArgs.push(arg);
    }

    const resolvedOutfile = outfile ?? inferOutfile(target);

    await fs.mkdir(path.dirname(resolvedOutfile), {recursive: true});

    run(
        process.execPath,
        [buildScriptPath],
        "Node.js is required to build databricks-execute."
    );

    const compileArgs = [
        "build",
        "--compile",
        entryPoint,
        "--outfile",
        resolvedOutfile,
        ...defaultBunBuildArgs,
    ];
    if (target) {
        compileArgs.push("--target", target);
    }
    compileArgs.push(...bunArgs);

    run(
        "bun",
        compileArgs,
        "Bun is required to compile a standalone binary. Install Bun and ensure 'bun' is on PATH."
    );

    if (!resolvedOutfile.endsWith(".exe")) {
        await fs.chmod(resolvedOutfile, 0o755);
    }

    console.log(`Built standalone binary: ${path.relative(projectRoot, resolvedOutfile)}`);
}

main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
});
