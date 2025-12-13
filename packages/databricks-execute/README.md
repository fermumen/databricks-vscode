# `databricks-execute`

Runs a local Python file on a Databricks cluster, mimicking the Databricks VS Code extension “Upload and Run File” flow:

1. `databricks bundle sync` (uploads bundle assets)
2. Executes the file on the configured cluster via the Command Execution API
3. Parses remote stack traces and rewrites `/Workspace/...` paths back to local paths

## Install / build (repo-local)

```bash
node .yarn/releases/yarn-3.2.1.cjs install
node .yarn/releases/yarn-3.2.1.cjs workspace @databricks/databricks-execute build
```

## Install the command

### Local (recommended for this repo)

This exposes `databricks-execute` on your PATH via `node_modules/.bin`:

```bash
node .yarn/releases/yarn-3.2.1.cjs workspace @databricks/databricks-execute add -D file:packages/databricks-execute
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
