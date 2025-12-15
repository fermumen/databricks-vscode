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

## Install the command

### From npm (one-line install)

```bash
npm install -g @fermumen/databricks-execute
```

Then run:

```bash
databricks-execute path/to/local/file.py -- arg1 arg2
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

From this repo root:

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

By default it uses `bundle.yml` / `databricks.yml` (via `databricks bundle validate`) for `workspace.host`, workspace file path, and cluster id.

## Authentication / `.config` (optional)

For authentication, prefer the standard Databricks CLI auth flow (for example `databricks auth login`) or set `DATABRICKS_TOKEN`.

If you still want a repo-local override file, you can use `.config` in the bundle root with plain `key=value` lines (comments with `#` are allowed):

```ini
host=https://adb-1234567890123456.7.azuredatabricks.net
token=dapiXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
cluster=My Cluster Name
target=dev
```

CLI flags override `.config`, and environment variables can also be used (`DATABRICKS_HOST`, `DATABRICKS_TOKEN`).

Run `databricks-execute --help` for the full set of options.
