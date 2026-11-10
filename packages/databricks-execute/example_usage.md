# Prereqs (one-time)

- Databricks CLI v0.2+ is installed and authenticated:
  - `databricks auth login` (preferred), or set `DATABRICKS_HOST` / `DATABRICKS_TOKEN`.
- The repo is a Databricks Bundle (has `databricks.yml` or `bundle.yml`) with:
  - `targets.<target>.mode: development`
  - `targets.<target>.cluster_id: <cluster-id>`
  - `targets.<target>.workspace.host: <workspace-host>`
  - `targets.<target>.workspace.root_path: /Workspace/Users/<user>/.bundle/<bundle-name>`

- if databricks.yml is not ready prompt the user for these details
- if databricks cli is not installed prompt user to install it and log in
- assume prereqs are set up if databricks.yml is installed.

`databricks-execute` has two modes:
- **`run`**: syncs the bundle (`databricks bundle sync`), then runs one file as a one-off Jobs run. Notebooks run as notebook tasks and plain `.py` files as Python file tasks. Expect about 20s minimum per run.
- **`session`**: a named, long-lived Python context on the cluster. `session exec` sends a snippet and only pays a command round-trip; variables persist between calls.

## Working in this repo

### Real work: `run`

Use `run` for anything that should behave like a normal Databricks run: notebooks, `%pip` installs, `%sql`/`%md` magics, `dbutils.*`, scripts with arguments.

- `databricks-execute run path/to/notebook.ipynb --target dev`
- `databricks-execute run path/to/notebook_source.py --target dev --widget greeting=hello --widget name=databricks` (first line is `# Databricks notebook source`)
- `databricks-execute run path/to/script.py --target dev -- arg1 arg2`

Notes:
- Script args (`-- arg1 arg2`) work only for plain `.py` files; notebooks take repeatable `--widget KEY=VALUE` instead.
- Plain `.py` files get `spark`, `dbutils` and `display` as globals, the bundle root on `sys.path`, and their own directory as the working directory.
- `--timeout <seconds>` cancels a run that takes too long (exit 124).
- Only notebooks and plain `.py` files can be run; other file types are rejected.

### Quick checks: `session`

Use a session to inspect data, try an expression, or iterate on a function without paying for a job run each time.

```bash
databricks-execute session create --target dev       # once; syncs the bundle
databricks-execute session exec -c 'df = spark.table("main.default.trips")'
databricks-execute session exec -c 'print(df.count())'
databricks-execute session exec --sync -c 'import mymod; print(mymod.f())'   # after editing mymod.py
databricks-execute session stop                       # when done
```

Notes:
- Snippets run as-is: no `sys.argv`, no env changes. The working directory is the bundle's remote root, which is also on `sys.path`.
- Pass `--sync` after editing bundle files; it re-syncs and reloads bundle modules. Without it, nothing is synced.
- When a snippet raises, output printed before the error is lost. Print in smaller snippets, or catch the exception and print it.
- Exit code 3 means the session is gone (for example, the cluster restarted). Run `session create` again; earlier variables are lost.
- Use `-s <name>` to keep several independent sessions.

### Reading results

- Status lines go to stderr; program output to stdout; tracebacks to stderr.
- Add `--json` to get one JSON object on stdout (`status`, `exitCode`, `stdout`, `error.type`, `error.message`, `error.traceback`, ...).
- Exit codes: 0 ok, 1 run failed / snippet raised, 2 usage error, 3 session not found or lost, 124 timeout, 130 cancelled.

## Databricks notebook source:
When creating new files prefer this format.

* dbutils is already loaded
* a spark session object is always available as `spark`

refernece:
```py
# Databricks notebook source

# COMMAND ----------
# DBTITLE 1,Setup dependencies
# MAGIC %pip install -q <pkgs...>

# COMMAND ----------
# we restart by default
dbutils.library.restartPython()

# COMMAND ----------
# DBTITLE 1,Shell setup (optional)
# MAGIC %sh -e
# MAGIC echo "hello"

# COMMAND ----------
import os

# COMMAND ----------
# DBTITLE 1,Main logic (optional title)
print("Hello")

```

## Installing dependencies in notebooks (%pip)

Put dependency installs near the top of the notebook:

```python
%pip install -U pandas pyarrow
```

If you install or upgrade packages during a run, Databricks may require a Python restart to pick them up:

```python
dbutils.library.restartPython()
```

Guidance for agents:
- Prefer **minimal** dependencies.
- Prefer pinning versions when reproducibility matters.
- Prefer cluster libraries. The cluster has most packages needed for data science work (pyspark, pandas, numpy, ...)

## Rules for the agent

- Do not run code via local Python, VS Code commands, or custom SSH; run code **only** via `databricks-execute`.
- Use `session exec` for quick checks and `run` for real work (notebooks, scripts with args, anything that should be reproducible).
- Always run from the repo root or ensure a bundle root is discoverable (a parent directory contains `databricks.yml` / `bundle.yml`).
- Stop sessions you created when you are done (`session stop`).

## Common commands

- Run notebook: `databricks-execute run path/to/notebook.ipynb --target dev`
- Run notebook with widget parameters: `databricks-execute run path/to/notebook_source.py --target dev --widget greeting=hello --widget name=databricks`
- Run plain Python as a job: `databricks-execute run path/to/script.py --target dev -- arg1 arg2`
- Run with a time limit: `databricks-execute run path/to/script.py --target dev --timeout 600`
- Start a session: `databricks-execute session create --target dev`
- Run a snippet: `databricks-execute session exec --target dev -c 'print(spark.range(5).count())'`
- Run a snippet from stdin: `databricks-execute session exec --target dev - < snippet.py`
- List / stop sessions: `databricks-execute session list --target dev`, `databricks-execute session stop --target dev`
- Use a specific cluster by name/id: add `--cluster <cluster-name-or-id>`
- Stopped clusters are started automatically by `run` and `session create`; to disable: add `--no-start-cluster`
