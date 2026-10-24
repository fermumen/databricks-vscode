# `databricks-execute` v3 — plan

v3 replaces today's file-type-driven split (notebooks as jobs, plain `.py` via the
Command Execution API) with two explicit modes built for agents:

- **`run`**: every file runs as a one-off Jobs run.
- **`session`**: a long-lived Python execution context on a cluster that takes code
  snippets, REPL-style.

The guiding rule is **reuse upstream code as-is**. Infrastructure behavior changes
upstream, and anything we patch or re-implement drifts. Our own code should be
argument parsing, output formatting, and the session name cache.

## Why

- Command mode is underspecified for agents: tracebacks go to stdout mixed with log
  lines, a script's `sys.exit(n)` code is lost, non-text results are dumped as raw
  JSON, plain `.sql`/`.scala` files fall through to the Python bootstrap, and the
  remote runtime (cwd, globals, buffered output) is undocumented.
- `--keep-context` / `--context-id` are hard for agents to use: the context id is
  buried in a log line, there is no way to list or stop contexts, and imported
  bundle modules stay cached across runs.
- Keeping a context alive depends on a regex patch over upstream's `bootstrap.py`
  (`persistContextState` in `src/core.ts`), which breaks if upstream edits that line.
- A job run costs ~20s minimum, which is too slow for quick checks. A live context
  only pays a command round-trip.

## Command surface

```sh
# Job mode: notebooks and plain .py files, always the Jobs API
databricks-execute run <file> [--target ..] [--cluster ..|--serverless] [--widget K=V]... [-- args...]
databricks-execute <file> ...            # alias for `run`, kept for compatibility

# Session mode: Command Execution API, code only
databricks-execute session create [-s <name>] [--target ..] [--cluster ..]
databricks-execute session exec   [-s <name>] (-c <code> | -) [--sync]
databricks-execute session status [-s <name>]
databricks-execute session stop   [-s <name>]
databricks-execute session list

# Every command
--json                                   # one result object on stdout; logs on stderr
```

`-s` defaults to `default`. `init` is unchanged.

## Job mode (`run`)

| File | Upstream code | Task |
|---|---|---|
| `.ipynb`, `Databricks notebook source` | `WorkflowRun.submitRun` / `wait` / `export` / `getOutput` (as today) | `notebook_task` |
| plain `.py` | `WorkflowRun.runPythonAndWait` + `resources/python/file.workflow-wrapper.py` | `spark_python_task` |
| anything else | — | rejected with a clear error |

- **Python files:** load `file.workflow-wrapper.py` as text (like `bootstrap.py` is
  loaded today) and upload it next to the synced file. Mirror
  `WorkspaceFsWorkflowWrapper.createFile` + `getWrapperPath` (`src/workspace-fs/`):
  substitute `{{DATABRICKS_SOURCE_FILE}}` / `{{DATABRICKS_PROJECT_ROOT}}`, and upload
  with `WorkspaceFsEntity.fromPath(...).createFile(...)` from `sdk-extensions`. We
  can't import the class itself because it imports `vscode`, so this ~20 lines of
  glue is the only copied logic. Check upstream's `createFile` on every merge.
- **Args:** `-- arg1 arg2` → `spark_python_task.parameters`. `--widget` is for
  notebooks only.
- **Output:** for Python files, print `RunOutput.logs` (with a notice when
  `logs_truncated` is set), then `error` / `error_trace`. Remap `/Workspace/...`
  paths in the trace to local paths with `remoteWorkspacePathToLocalPath`.
- **Run handle:** print the run URL from the first `onProgress` callback, as the
  notebook path does today.
- **Serverless:** `runPythonAndWait` already does it (`environment_version: "5"`).
  Align the notebook path's hard-coded `spec: {client: "1"}` to match.
- **Exit codes** (same for both file types): `0` success, `1` run failed, `130`
  cancelled.

## Session mode (`session`)

| Step | Upstream code |
|---|---|
| create | `Cluster.fromClusterId` / `fromClusterName`, `cluster.start`, `Cluster.createExecutionContext("python")` |
| exec | `ExecutionContext.fromId(...).execute(code, ...)` → `Command`; errors via `parseErrorResult` |
| status | SDK `compute.CommandExecutionService` context status |
| stop | `ExecutionContext.destroy` |

- **No bootstrap.** `bootstrap.py` exists to run a *file* (argv, env, cwd,
  `sys.path`). `exec` sends the snippet as-is. This deletes `compileBootstrapCommand`,
  the `persistContextState` regex, and the `STDOUT_ERROR_BOUNDARY` handling from the
  CLI.
  - Known cost: the 1.2 API returns only the traceback for a failed command, so
    output printed before an error is lost. Document it; agents can print in
    smaller chunks or catch the exception.
- **Bundle imports:** `create` runs a one-off setup command that inserts the bundle's
  remote root into `sys.path`. `exec --sync` runs `bundle sync` first, then unloads
  `sys.modules` entries whose `__file__` is under that root, so edited modules
  reload. Without `--sync` there is no sync.
- **Name cache:** `$TMPDIR/databricks-execute/sessions.json`, keyed by
  `host + cluster id + name` → `{contextId, createdAt}`. Written atomically (temp
  file + rename). Nothing is written into the bundle.
  - It's a cache: every `exec` / `status` checks the context with the API first. A
    dead context (cluster restarted or terminated) is pruned. The command then fails
    with a dedicated exit code and `session '<name>' was lost (cluster restarted);
    run 'session create'`. It never re-creates the session silently, because state
    would be gone.
  - `create` on a name that already has a live context: print it and exit 0
    (idempotent). `--force` destroys it and creates a new one.
  - `list` prints live entries for the resolved host.
- **Cluster:** a classic cluster is required (the Command Execution API doesn't run
  on serverless). `create` auto-starts a stopped cluster unless `--no-start-cluster`
  is passed. `exec` does not start clusters: a stopped cluster means the session is
  lost.
- **Exit codes:** `0` ok, `1` the snippet raised, `2` usage error, `3` session not
  found or lost.

## Output contract

- Human mode: status lines → stderr, program output → stdout, tracebacks → stderr.
  No ANSI colour when stderr isn't a TTY.
- `--json`: one object on stdout, e.g.

```json
{
  "mode": "session",
  "session": "default",
  "clusterId": "...",
  "status": "error",
  "exitCode": 1,
  "stdout": "...",
  "result": "...",
  "error": {"type": "...", "message": "...", "traceback": "..."},
  "truncated": false,
  "durationMs": 1234
}
```

`run` adds `runId`, `runUrl` and `resultState`.

## Removed (breaking → 3.0.0)

- `--keep-context`, `--context-id`: replaced by `session`.
- `--env`: no equivalent for `spark_python_task` on an existing cluster. Use args or
  widgets.
- Running plain `.py` through the Command Execution API: plain `.py` files now run
  as jobs (slower, ~20s; use `session exec` for quick checks).
- `bootstrap.py` is no longer used by the CLI.

## Spike first (real cluster)

Measure and confirm before building the session layer:

1. `session create` latency, and the `exec` round-trip for a trivial snippet.
2. Whether a bare last expression (`1 + 1`, `df.count()`) comes back as a text
   result, the way a notebook cell shows it.
3. Whether `%pip` and `%sql` work in a 1.2 context. If not, sessions are plain
   Python and magics stay in job mode.
4. Whether `spark` / `dbutils` / `display` resolve in `spark_python_task` through
   upstream's `file.workflow-wrapper.py`, on a cluster and on serverless.
5. What the API returns for a stale context id after a cluster restart, so the
   lost-session error can be reliable.

## Work order

1. Spike (above). Record findings in this file.
2. `run` for plain `.py` via `runPythonAndWait` + wrapper upload. Reject unsupported
   file types. Align the serverless spec.
3. Output contract: log lines to stderr, `--json`, exit codes for `run`.
4. `session create/exec/status/stop/list` with the name cache.
5. `exec --sync` + module unloading.
6. Remove `--keep-context`, `--context-id`, `--env`, and the bootstrap code paths
   from `src/cli.ts` / `src/core.ts`.
7. Tests: unit tests for the name cache, wrapper path/substitution, and output
   formatting (`src/core.test.ts`, `node:test`). Update `src/cli.integ.test.ts`:
   replace the `--keep-context` case with session create → exec → exec (state
   kept) → stop, plus a `.py` job run.
8. Docs: README, `--help`, `example_usage.md` (agent guidance: `session exec` for
   quick checks, `run` for real work), AGENTS.md "what to watch" list (drop
   `bootstrap.py`, add `file.workflow-wrapper.py` and `WorkspaceFsWorkflowWrapper`),
   CHANGELOG, version `3.0.0`.

## Open questions

- Should notebook runs also go through upstream's `createNotebookWrapper` (sets
  cwd/`sys.path`, hoists `%pip install`) to match VS Code? It changes notebook
  behavior, so decide separately from v3.
- Does `run` need a `--timeout`? Jobs runs have no timeout today.
