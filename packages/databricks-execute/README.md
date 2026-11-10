# `databricks-execute`

Runs local bundle code on Databricks, in one of two modes:

-   **`run`**: syncs the bundle with `databricks bundle sync`, then runs one file as a one-off Jobs run. Notebooks (`.ipynb` or "Databricks notebook source" files) run as notebook tasks. Plain `.py` files run as Python file tasks through the same workflow wrapper the VS Code extension uses for "Run File as Workflow".
-   **`session`**: a named, long-lived Python execution context on a classic cluster. You send it code snippets, REPL-style, and variables persist between calls.

A job run takes about 20 seconds at minimum. A session `exec` only pays a command round-trip, so use sessions for quick checks and `run` for real work.

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
databricks-execute run path/to/local/file.py -- arg1 arg2
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
node .yarn/releases/yarn-3.2.1.cjs databricks-execute run path/to/local/file.py -- arg1 arg2
```

### Global

Install the local build from this repo root:

```bash
npm install -g ./packages/databricks-execute
```

## Usage

This CLI shells out to the Databricks CLI (`databricks`), so make sure it's installed and on your `PATH`. Every command needs a bundle: a `databricks.yml` in the current directory or a parent (see [`init`](#quick-start-with-init)).

### `run`: a file as a job

```bash
databricks-execute run path/to/script.py --target dev -- arg1 arg2
databricks-execute run path/to/notebook.ipynb --target dev --widget greeting=hello
databricks-execute path/to/script.py --target dev   # `run` is the default command
```

| File                                                                                     | Runs as                                                     | Parameters                        |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------- |
| `.ipynb`, or `.py`/`.sql`/`.scala`/`.r` whose first line is `Databricks notebook source` | notebook task                                               | `--widget KEY=VALUE` (repeatable) |
| plain `.py`                                                                              | Python file task, via upstream's `file.workflow-wrapper.py` | `-- arg1 arg2` (`sys.argv`)       |
| anything else                                                                            | rejected                                                    |                                   |

-   Plain `.py` files run with the bundle root on `sys.path`, the file's directory as the working directory, and `spark`, `dbutils` and `display` available as globals.
-   `--serverless` runs on serverless compute instead of a cluster.
-   `--timeout <seconds>` cancels the run when time is up and exits 124. Without it, runs have no timeout.
-   The run URL is printed as soon as the run starts. The CLI prints state changes immediately and an unchanged-state heartbeat at most once a minute.
-   For Python files, the run's logs are printed, followed by the error and traceback if it failed. `/Workspace/...` paths in the traceback are rewritten to local paths. For notebooks, text output and tracebacks are taken from the exported run; open the run URL to see rich output such as tables and plots.

### `session`: snippets in a live context

```bash
databricks-execute session create --target dev
databricks-execute session exec -c 'df = spark.range(10)'
databricks-execute session exec -c 'print(df.count())'   # prints 10
cat snippet.py | databricks-execute session exec -        # read code from stdin
databricks-execute session exec --sync -c 'import mymod; mymod.main()'
databricks-execute session status
databricks-execute session stop
databricks-execute session list
```

-   `-s <name>` picks a session; the default name is `default`. A session is identified by the workspace host, the cluster and its name.
-   `create` starts a stopped cluster (unless you pass `--no-start-cluster`), syncs the bundle, and creates the context with the bundle's remote root on `sys.path` and as the working directory. If the session already exists, `create` prints it and exits 0; `--force` replaces it.
-   `exec` sends the snippet as-is. There is no file setup: no `sys.argv` or environment changes. Printed output comes back on stdout. `exec` never starts a cluster.
-   `exec --sync` runs `bundle sync` first and unloads cached bundle modules, so edited modules are re-imported. Without `--sync`, nothing is synced.
-   When a snippet raises, the 1.2 API returns only the traceback, so output printed before the error is lost. To keep it, print in smaller snippets or catch the exception.
-   Sessions need a classic cluster: the Command Execution API doesn't run on serverless.
-   Session names are cached in `$TMPDIR/databricks-execute/sessions.json`, and nothing is written into the bundle. Every command checks the context with the API first. If the cluster restarted or terminated, the session is reported as lost (exit 3) and removed from the cache. It is never re-created silently, because its state is gone; run `session create` again.

### Output and exit codes

-   Status lines go to stderr. Program output goes to stdout and tracebacks to stderr. ANSI colours are stripped when stderr isn't a terminal.
-   `--json` prints one result object on stdout (logs still go to stderr):

```json
{
    "mode": "session",
    "action": "exec",
    "session": "default",
    "clusterId": "...",
    "contextId": "...",
    "status": "error",
    "exitCode": 1,
    "stdout": "",
    "error": {"type": "ValueError", "message": "boom", "traceback": "..."},
    "truncated": false,
    "durationMs": 1234
}
```

`run` results also include `runId`, `runUrl`, `resultState` and `stderr`.

| Exit code | Meaning                                              |
| --------- | ---------------------------------------------------- |
| 0         | success                                              |
| 1         | the run failed, the snippet raised, or another error |
| 2         | usage error (bad arguments, unsupported file type)   |
| 3         | the session wasn't found or was lost                 |
| 124       | `run --timeout` reached                              |
| 130       | cancelled with Ctrl+C                                |

### Upgrading from 2.x

| 2.x                                                    | 3.0                                                                                     |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `databricks-execute script.py` (Command Execution API) | still works, but runs as a job (about 20s minimum); use `session exec` for quick checks |
| `--keep-context` / `--context-id <id>`                 | `session create`, then `session exec -s <name>`                                         |
| `--env KEY=VALUE`                                      | script args (`-- arg1 arg2`) or `--widget` for notebooks                                |
| `.sql` / `.scala` files without the notebook header    | rejected; add the `Databricks notebook source` header                                   |
| tracebacks on stdout                                   | tracebacks on stderr                                                                    |

### Configuration

All configuration is read from `databricks.yml` (via `databricks bundle validate`): `workspace.host`, the workspace file path, and `cluster_id`. The bundle target must use `mode: development`.

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

## Publishing a release

Releases are not triggered by commits or Git tags. To publish a new version:

1. Bump `version` in `packages/databricks-execute/package.json` and merge the change into `main`.
2. Open the **Publish databricks-execute to npm** workflow in GitHub Actions.
3. Select **Run workflow** from `main` and enter the exact version from `package.json`.

The GitHub-hosted runner verifies the version, installs dependencies, runs the package tests, builds the package, and publishes it to npm through OIDC trusted publishing. After npm publishing succeeds, the workflow creates a `databricks-execute-v<version>` Git tag pointing to the published `main` commit.
