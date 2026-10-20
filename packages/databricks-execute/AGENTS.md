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
- The cluster must allow jobs workloads (notebook and `--widget` runs go through the Jobs API).
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
node packages/databricks-execute/dist/cli.js exec-example/widget_params_example.py --target dev --widget greeting=hello --widget name=smoke

# 6. Complete the merge
git commit
```

### What to watch for

- **`yarn.lock`** — always conflicts; resolve with `git checkout --theirs` then `yarn install`.
- **SDK changes** — `cli.ts` imports from `@databricks/sdk-experimental` and from `packages/databricks-vscode/src/sdk-extensions`. If upstream changes those APIs (exports, method signatures), update `cli.ts` and, if needed, bump the public npm dependency in `packages/databricks-execute/package.json` followed by a root `node .yarn/releases/yarn-3.2.1.cjs install`.
- **`bootstrap.py` / `ErrorParser.ts`** — also imported by `cli.ts`. Check if upstream modified them. Compare with upstream's `compileCommandString` and result handling in `packages/databricks-vscode/src/run/DatabricksRuntime.ts`: every placeholder it substitutes must also be substituted in `compileBootstrapCommand` (`src/core.ts`), and `persistContextState` rewrites the `runpy.run_path(...)` line, so watch for changes around it. The `bootstrap.py` tests in `src/core.test.ts` run the real template with `python3`.
- **`bin` metadata** — `yarn install` may rewrite `"bin"` in `packages/databricks-execute/package.json` to a string; restore the `{"databricks-execute": "dist/cli.js"}` object form before committing.
- **Quick check**: `git log upstream/main --since="<last-merge-date>" -- packages/databricks-vscode/src/sdk-extensions packages/databricks-vscode/src/run/ErrorParser.ts packages/databricks-vscode/resources/python/bootstrap.py` to see if our imported files changed.

## Design choices / constraints

- Configuration comes from `databricks.yml` (resolved via `databricks bundle validate`); CLI flags and env vars override bundle values. Use `databricks-execute init` to scaffold or update a `databricks.yml` with a `dbexec` target.
- Auth is always resolved via the Databricks CLI auth chain (`databricks auth env`). No tokens are stored in config files.
- Execution mirrors the VS Code extension behavior: `bundle sync` then run via the Command Execution API using the same `bootstrap.py` and error parsing.
- Core pure helpers live in `src/core.ts`; add tests in `src/core.test.ts` using Node’s built-in `node:test` runner.
- Node version: tests use `node:test` (Node 18+).
- Uses `@databricks/sdk-experimental` (public npm package), bundled into `dist/cli.js` at build time by esbuild. Keep runtime externals from `scripts/build.js` in `dependencies`; build/test-only packages belong in `devDependencies`.
