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

`databricks-execute` will:
1) run `databricks bundle sync` to upload repo files, then
2) execute either as:
   - **Notebook job run** (Jobs API) for notebooks, or
   - **Command Execution** for plain `.py` files.

## Working in this repo

### Default: notebooks for “real” work

Use notebooks for anything that is “standard Databricks work”:
- `%pip` installs
- `%sql`, `%md`, and other notebook magics
- `dbutils.*`
- anything that should behave like a normal Databricks notebook run

Run:
- `databricks-execute path/to/notebook.ipynb --target dev`
- `databricks-execute path/to/notebook_source.py --target dev` (first line is `# Databricks notebook source`)

### Quick iterations: plain `.py` files

Use plain `.py` files for fast, simple iterations (pure Python, minimal dependencies).

Run:
- `databricks-execute path/to/script.py --target dev -- arg1 arg2`

Notes:
- Script args (`-- arg1 arg2`) and `--env KEY=VALUE` work only for **plain** `.py` files.
- Notebook runs currently don’t accept positional args or `--env` (use widgets / `base_parameters` patterns inside the notebook instead).
- Long-running runs are supported. `databricks-execute` waits for completion and prints heartbeat status logs while waiting.

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
- Use **notebooks** for most tasks; use **plain `.py`** only for small, fast iterations.
- Always run from the repo root or ensure a bundle root is discoverable (a parent directory contains `databricks.yml` / `bundle.yml`).

## Common commands

- Run notebook: `databricks-execute path/to/notebook.ipynb --target dev`
- Run plain Python: `databricks-execute path/to/script.py --target dev -- arg1 arg2`
- Use a specific cluster by name/id: `databricks-execute path/to/script.py --target dev --cluster <cluster-name-or-id>`
- Start a stopped cluster: `databricks-execute path/to/script.py --target dev --start-cluster`
