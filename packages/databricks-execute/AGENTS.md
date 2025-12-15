# Agent notes: `packages/databricks-execute`

This folder is a standalone Yarn workspace package that builds the `databricks-execute` CLI.

## How to work here

- Prefer repo-local Yarn: use `node .yarn/releases/yarn-3.2.1.cjs ...` (don’t assume `yarn` is on PATH).
- This CLI **requires the Databricks CLI** (`databricks`) on PATH at runtime.
- Auth: prefer Databricks CLI auth (for example `databricks auth login`), or set `DATABRICKS_TOKEN`. Avoid committing PATs to bundle files.

## Common commands (run from repo root)

- Install deps: `node .yarn/releases/yarn-3.2.1.cjs install`
- Build: `node .yarn/releases/yarn-3.2.1.cjs workspace @databricks/databricks-execute build`
- Watch build: `node .yarn/releases/yarn-3.2.1.cjs workspace @databricks/databricks-execute watch`
- Lint/format check: `node .yarn/releases/yarn-3.2.1.cjs workspace @databricks/databricks-execute test:lint`
- Unit tests: `node .yarn/releases/yarn-3.2.1.cjs workspace @databricks/databricks-execute test:unit`
- Integration tests (real workspace/cluster, opt-in): `DATABRICKS_EXECUTE_INTEG=1 DATABRICKS_EXECUTE_CLUSTER_ID=<cluster-id> [DATABRICKS_EXECUTE_INTEG_START_CLUSTER=1] node .yarn/releases/yarn-3.2.1.cjs workspace @databricks/databricks-execute test:integ`

### Integration test example (current dev setup)

```bash
DATABRICKS_EXECUTE_INTEG=1 \
  DATABRICKS_EXECUTE_CLUSTER_ID=0702-165645-5f7ehvtu \
  DATABRICKS_HOST=https://adb-4430213680693954.14.azuredatabricks.net \
  node .yarn/releases/yarn-3.2.1.cjs workspace @databricks/databricks-execute test:integ
```

## Design choices / constraints

- Configuration comes from `databricks bundle validate` (bundle files) plus optional `.config` overrides; CLI flags/env vars override everything.
- Execution mirrors the VS Code extension behavior: `bundle sync` then run via the Command Execution API using the same `bootstrap.py` and error parsing.
- Core pure helpers live in `src/core.ts`; add tests in `src/core.test.ts` using Node’s built-in `node:test` runner.
- Node version: tests use `node:test` (Node 18+).
