# `databricks-execute`

Runs a local Python file on a Databricks cluster, mimicking the Databricks VS Code extension “Upload and Run File” flow:

1. `databricks bundle sync` (uploads bundle assets)
2. Executes the file on the configured cluster via the Command Execution API
3. Parses remote stack traces and rewrites `/Workspace/...` paths back to local paths

For notebooks (`.ipynb` or “Databricks notebook source” files like `example.py`), it runs them as a workflow (Jobs API notebook task) to match the VS Code “Run File as Workflow” behavior.

## Install / build (repo-local)

```bash
node .yarn/releases/yarn-3.2.1.cjs install
node .yarn/releases/yarn-3.2.1.cjs workspace @fermumen/databricks-execute build
```

## Build a standalone binary with Bun

If you want a single executable instead of a Node.js script, install Bun and run:

```bash
node .yarn/releases/yarn-3.2.1.cjs workspace @fermumen/databricks-execute build:binary
```

This builds `packages/databricks-execute/dist/databricks-execute` for the local platform.
You can also target a different platform, for example:

```bash
node .yarn/releases/yarn-3.2.1.cjs workspace @fermumen/databricks-execute build:binary --target bun-linux-x64
```

For older Linux x64 CPUs without AVX2 support, use Bun's baseline target instead:

```bash
node .yarn/releases/yarn-3.2.1.cjs workspace @fermumen/databricks-execute build:binary --target bun-linux-x64-baseline
```

The compiled binary is standalone with respect to Node.js/npm, but it still requires the Databricks CLI (`databricks`) on your `PATH` at runtime.
The binary build uses Bun's production-oriented compile flags (`--minify --sourcemap --bytecode`) and disables Bun's automatic `.env` / `bunfig.toml` loading so runtime behavior stays closer to the Node.js CLI.

## Install the command

### From npm (one-line install)

```bash
npm install -g @fermumen/databricks-execute@latest
```

Then run:

```bash
databricks-execute path/to/local/file.py -- arg1 arg2
```

Upgrade to latest:

```bash
npm install -g @fermumen/databricks-execute@latest
```

### Local (recommended for this repo)

This exposes `databricks-execute` on your PATH via `node_modules/.bin`:

```bash
node .yarn/releases/yarn-3.2.1.cjs workspace @fermumen/databricks-execute add -D file:packages/databricks-execute
```

Then run it with:

```bash
node .yarn/releases/yarn-3.2.1.cjs databricks-execute path/to/local/file.py -- arg1 arg2
```

### Global

Install the local build from this repo root:

```bash
npm install -g ./packages/databricks-execute
```

## Usage

```bash
databricks-execute path/to/local/file.py -- arg1 arg2
```

This CLI shells out to the Databricks CLI (`databricks`), so make sure it’s installed and on your `PATH`.

### Notebook mode

If the input file is:

-   an `.ipynb`, or
-   a `*.py`/`*.sql`/`*.scala`/`*.r` file whose first line is `Databricks notebook source`

then `databricks-execute` runs it as a **workflow notebook task** instead of using the Command Execution API.

Notes:

-   Positional args (`-- arg1 arg2`) and `--env KEY=VALUE` are only supported in Command Execution mode (plain `.py` files).
-   Notebook output is printed by extracting text stdout/stderr (and tracebacks) from the exported run. For rich outputs (tables/plots/HTML), open the run URL in a browser.
-   Long-running executions are supported. The CLI waits for completion and prints periodic heartbeat status lines while the run is active.
-   In plain `.py` mode (Command Execution API), client-side wait timeout is set to 240 hours.
-   In notebook workflow mode (Jobs API), one-off run timeout is explicitly set to `0` (no timeout).

All configuration is read from `databricks.yml` (via `databricks bundle validate`): `workspace.host`, workspace file path, and `cluster_id`.

If the configured cluster is stopped, it is started automatically. Pass `--no-start-cluster` to disable this.

## Quick start with `init`

To create or update a `databricks.yml` with a target for `databricks-execute`:

```bash
databricks-execute init --host https://adb-123.azuredatabricks.net --cluster 0123-456789-abcde123
```

This creates a `databricks.yml` in the current directory with a `dbexec` target. If a `databricks.yml` already exists, it adds the target to it.

Options: `--host <url>`, `--cluster <id>`, `--target <name>` (default: `dbexec`), `--name <bundle-name>` (default: directory name). If flags are omitted, you will be prompted interactively.

## Authentication

Authentication is resolved from the Databricks CLI auth chain. Preferred flows:

1. **PAT token in `~/.databrickscfg`** — run `databricks auth login --host <url>` to set up.
2. **Azure CLI** — if using Azure AD, the Databricks CLI delegates to `az login`.
3. **`DATABRICKS_TOKEN` env var** — for CI/CD or scripted usage.
4. **`--token` flag** — explicit override.

The CLI runs `databricks auth env --host <host>` to resolve the token at runtime. No tokens are stored in `databricks.yml`.

## Configuration priority

1. CLI flags (`--host`, `--token`, `--cluster`, `--target`)
2. Environment variables (`DATABRICKS_HOST`, `DATABRICKS_TOKEN`, `DATABRICKS_BUNDLE_TARGET`)
3. Bundle validate output (`workspace.host`, `bundle.compute_id` / `cluster_id`)
4. Databricks CLI auth chain (for token resolution)

Run `databricks-execute --help` for the full set of options.
