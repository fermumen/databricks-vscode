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

### Integration test example (current dev setup)

```bash
DATABRICKS_EXECUTE_INTEG=1 \
  DATABRICKS_EXECUTE_CLUSTER_ID=0702-165645-5f7ehvtu \
  DATABRICKS_HOST=https://adb-4430213680693954.14.azuredatabricks.net \
  node .yarn/releases/yarn-3.2.1.cjs workspace @fermumen/databricks-execute test:integ
```

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
node packages/databricks-execute/dist/cli.js exec-example/example_dbs.py --target dev --no-sync

# 6. Complete the merge
git commit
```

### What to watch for

- **`yarn.lock`** — always conflicts; resolve with `git checkout --theirs` then `yarn install`.
- **SDK changes** — `cli.ts` imports from `@databricks/sdk-experimental` and from `packages/databricks-vscode/src/sdk-extensions`. If upstream changes those APIs (exports, method signatures), update `cli.ts` accordingly.
- **`bootstrap.py` / `ErrorParser.ts`** — also imported by `cli.ts`. Check if upstream modified them.
- **Quick check**: `git log upstream/main --since="<last-merge-date>" -- packages/databricks-vscode/src/sdk-extensions packages/databricks-vscode/src/run/ErrorParser.ts packages/databricks-vscode/resources/python/bootstrap.py` to see if our imported files changed.

## Design choices / constraints

- Configuration comes from `databricks.yml` (resolved via `databricks bundle validate`); CLI flags and env vars override bundle values. Use `databricks-execute init` to scaffold or update a `databricks.yml` with a `dbexec` target.
- Auth is always resolved via the Databricks CLI auth chain (`databricks auth env`). No tokens are stored in config files.
- Execution mirrors the VS Code extension behavior: `bundle sync` then run via the Command Execution API using the same `bootstrap.py` and error parsing.
- Core pure helpers live in `src/core.ts`; add tests in `src/core.test.ts` using Node’s built-in `node:test` runner.
- Node version: tests use `node:test` (Node 18+).
- Uses `@databricks/sdk-experimental` (public npm package), bundled into `dist/cli.js` at build time by esbuild.
