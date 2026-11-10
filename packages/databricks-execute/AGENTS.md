# Agent notes: `packages/databricks-execute`

This folder is a standalone Yarn workspace package that builds the `databricks-execute` CLI.

## How to work here

- Prefer repo-local Yarn: use `node .yarn/releases/yarn-3.2.1.cjs ...` (don’t assume `yarn` is on PATH).
- This CLI **requires the Databricks CLI** (`databricks`) on PATH at runtime.
- Auth: prefer Databricks CLI auth (for example `databricks auth login`), or set `DATABRICKS_TOKEN`. Avoid committing PATs to bundle files.

## Common commands (run from repo root)

- Install deps: `node .yarn/releases/yarn-3.2.1.cjs install`
- Build: `node .yarn/releases/yarn-3.2.1.cjs workspace @fermumen/databricks-execute build`
- Build standalone binary: `node .yarn/releases/yarn-3.2.1.cjs workspace @fermumen/databricks-execute build:binary`
- Watch build: `node .yarn/releases/yarn-3.2.1.cjs workspace @fermumen/databricks-execute watch`
- Lint/format check: `node .yarn/releases/yarn-3.2.1.cjs workspace @fermumen/databricks-execute test:lint`
- Unit tests: `node .yarn/releases/yarn-3.2.1.cjs workspace @fermumen/databricks-execute test:unit`
- Integration tests (real workspace/cluster, opt-in): `DATABRICKS_EXECUTE_INTEG=1 DATABRICKS_EXECUTE_CLUSTER_ID=<cluster-id> [DATABRICKS_EXECUTE_INTEG_START_CLUSTER=1] node .yarn/releases/yarn-3.2.1.cjs workspace @fermumen/databricks-execute test:integ`

### Integration test example

```bash
DATABRICKS_CONFIG_PROFILE=<profile> \
  DATABRICKS_HOST=<workspace-host> \
  DATABRICKS_EXECUTE_INTEG=1 \
  DATABRICKS_EXECUTE_CLUSTER_ID=<cluster-id> \
  node .yarn/releases/yarn-3.2.1.cjs workspace @fermumen/databricks-execute test:integ
```

- Set `DATABRICKS_HOST` explicitly when using a named profile: the test resolves the host via `databricks auth env`, which ignores `DATABRICKS_CONFIG_PROFILE` and falls back to `DEFAULT`.
- The cluster must allow jobs workloads (every `run` goes through the Jobs API) and interactive workloads (sessions use the Command Execution API).
- The test isolates the session name cache with its own `TMPDIR`. Lines starting with `#` in its output (`t.diagnostic`) record the v3 spike findings: session latencies, `%sql`/`%pip` behaviour, stale-context handling.
- Don't commit workspace hosts or cluster IDs; this repo is public.

## Merging upstream changes

This repo is a fork of [databricks/databricks-vscode](https://github.com/databricks/databricks-vscode). The `packages/databricks-execute` package is our addition; everything else is upstream.

### One-time setup (already done)

```bash
git remote add upstream https://github.com/databricks/databricks-vscode.git
```

### Merge workflow

```bash
# 1. Fetch upstream
git fetch upstream

# 2. Merge into main
git merge upstream/main --no-edit

# 3. Resolve yarn.lock conflict (almost always the only conflict)
git checkout --theirs yarn.lock
node .yarn/releases/yarn-3.2.1.cjs install
git add yarn.lock

# 4. Build and test databricks-execute
node .yarn/releases/yarn-3.2.1.cjs workspace @fermumen/databricks-execute build
node .yarn/releases/yarn-3.2.1.cjs workspace @fermumen/databricks-execute test

# 5. Smoke test against exec-example/
node packages/databricks-execute/dist/cli.js run exec-example/widget_params_example.py --target dev --widget greeting=hello --widget name=smoke

# 6. Complete the merge
git commit
```

### What to watch for

- **`yarn.lock`** — always conflicts; resolve with `git checkout --theirs` then `yarn install`.
- **SDK changes** — `src/run.ts`, `src/session.ts` and `src/bundle.ts` import from `@databricks/sdk-experimental` and from `packages/databricks-vscode/src/sdk-extensions` (`WorkflowRun`, `Cluster`, `ExecutionContext`, `WorkspaceFsEntity`). If upstream changes those APIs (exports, method signatures), update our callers and, if needed, bump the public npm dependency in `packages/databricks-execute/package.json` followed by a root `node .yarn/releases/yarn-3.2.1.cjs install`.
- **`file.workflow-wrapper.py` / `WorkspaceFsWorkflowWrapper.ts`** — `src/run.ts` uploads upstream's `resources/python/file.workflow-wrapper.py` next to a plain `.py` file, mirroring `WorkspaceFsWorkflowWrapper.createFile` and `getWrapperPath` (copied into `src/core.ts` as `workflowWrapperPath` / `renderWorkflowWrapper`, because that class imports `vscode`). On every merge, check whether upstream changed the wrapper's placeholders, the wrapper file name, or `createFile`. The wrapper tests in `src/core.test.ts` run the real template with `python3`.
- **`ErrorParser.ts`** — `parseErrorResult` formats session tracebacks. Check for changes to its frame format.
- **`bin` metadata** — `yarn install` may rewrite `"bin"` in `packages/databricks-execute/package.json` to a string; restore the `{"databricks-execute": "dist/cli.js"}` object form before committing.
- **Quick check**: `git log upstream/main --since="<last-merge-date>" -- packages/databricks-vscode/src/sdk-extensions packages/databricks-vscode/src/run/ErrorParser.ts packages/databricks-vscode/src/workspace-fs/WorkspaceFsWorkflowWrapper.ts packages/databricks-vscode/resources/python/file.workflow-wrapper.py` to see if our imported or mirrored files changed.

## Design choices / constraints

- Configuration comes from `databricks.yml` (resolved via `databricks bundle validate`); CLI flags and env vars override bundle values. Use `databricks-execute init` to scaffold or update a `databricks.yml` with a `dbexec` target.
- Auth is always resolved via the Databricks CLI auth chain (`databricks auth env`). No tokens are stored in config files.
- `run` mirrors the VS Code extension's "Run File as Workflow": `bundle sync`, then a one-off Jobs run (notebook task, or Python file task through upstream's workflow wrapper).
- `session` keeps a named Command Execution context alive on a classic cluster and sends snippets as-is (no bootstrap). Session names live in `$TMPDIR/databricks-execute/sessions.json` and are always checked with the API before use; a lost session exits 3 and is never re-created silently.
- Output contract: status lines on stderr, program output on stdout, tracebacks on stderr; `--json` prints one result object. Exit codes are defined in `src/output.ts`.
- Domain terms (Bundle, Run, Session, Snippet, Lost session) are defined in `CONTEXT.md`.
- Core pure helpers live in `src/core.ts`; add tests next to the module (`src/*.test.ts`) using Node’s built-in `node:test` runner, and list new test entry points in `scripts/test.js`.
- Node version: tests use `node:test` (Node 18+).
- Uses `@databricks/sdk-experimental` (public npm package), bundled into `dist/cli.js` at build time by esbuild. Keep runtime externals from `scripts/build.js` in `dependencies`; build/test-only packages belong in `devDependencies`.
