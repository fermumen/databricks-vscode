# `databricks-execute` — upstream update plan

This doc describes how to keep `packages/databricks-execute/` aligned with upstream changes from `https://github.com/databricks/databricks-vscode`, while preserving the standalone CLI’s packaging and behavior.

## Goals

- Keep `databricks-execute` behavior in sync with the VS Code extension’s “run file” and “run as workflow” logic.
- Reuse upstream code where it’s **pure** (no `vscode` imports) and keep our CLI-specific glue minimal.
- Ensure npm installs work on a clean machine (no local `file:` dependencies).
- Maintain a small set of unit + opt-in integration tests to catch regressions.

## What we vendor vs what we reuse

### Reuse directly (preferred)

Reuse upstream TypeScript modules **only if they have no VS Code runtime dependency** (no `import "vscode"` and no `ExtensionContext`, webviews, etc.).

Current examples:
- `packages/databricks-vscode/src/sdk-extensions/*` (e.g. `WorkflowRun`, `Cluster`, `ExecutionContext`)
- `packages/databricks-vscode/src/run/ErrorParser.ts`
- `packages/databricks-vscode/resources/python/bootstrap.py` (loaded as text)

### Do not reuse directly (reference only)

Modules tied to VS Code runtime should be treated as reference implementations:
- `packages/databricks-vscode/src/run/WorkflowRunner.ts` (uses webviews)
- `packages/databricks-vscode/src/utils/fileUtils.ts` (uses `vscode.workspace.fs`)

We re-implement equivalent logic in `packages/databricks-execute/src/core.ts` when needed (e.g. notebook detection).

## Release strategy (high level)

1. **Update upstream repo code** (your fork branch or merged upstream changes into your main branch).
2. **Rebuild** the CLI and rerun tests.
3. **Validate behavior against a real bundle** (`exec-example/` or the integration test).
4. **Publish a new npm version** (never overwrite a published version).

## Step-by-step: pulling upstream changes safely

### 1) Sync upstream changes into your fork

Recommended approach:

- Add upstream remote:
  - `git remote add upstream https://github.com/databricks/databricks-vscode.git`
- Fetch:
  - `git fetch upstream`
- Merge or rebase onto upstream main:
  - `git merge upstream/main` (safer for shared branches)
  - or `git rebase upstream/main` (cleaner history for personal branches)

### 2) Identify potential break points for `databricks-execute`

Upstream changes are most likely to affect the CLI when they touch:
- `packages/databricks-vscode/src/sdk-extensions/**`
- `packages/databricks-vscode/src/run/ErrorParser.ts`
- `packages/databricks-vscode/resources/python/bootstrap.py`

Actions:
- Run `git diff --name-only <old>..<new>` and focus on the files above.
- If `sdk-extensions` changes, confirm public APIs used by the CLI still exist:
  - `Cluster.fromClusterId/fromClusterName`, `Cluster.createExecutionContext`
  - `WorkflowRun.submitRun`, `WorkflowRun.wait`, `WorkflowRun.export`, `WorkflowRun.getOutput`
  - `ExecutionContext.execute`

### 3) Update the vendored Databricks SDK (if needed)

The CLI bundles the vendored Node SDK from `vendor/databricks-sdk.tgz` at build time.

If upstream updates that tarball or the SDK shape changes:
- Replace/update `vendor/databricks-sdk.tgz` at repo root.
- Ensure `packages/databricks-execute/scripts/build.js` can still extract and resolve it.
- Rebuild the CLI and run unit tests.

### 4) Run tests (minimum bar)

From repo root:
- Lint + unit:
  - `node .yarn/releases/yarn-3.2.1.cjs workspace @fermumen/databricks-execute test`
- Build:
  - `node .yarn/releases/yarn-3.2.1.cjs workspace @fermumen/databricks-execute build`

### 5) Run integration checks (recommended before publishing)

Opt-in integration test (real cluster/workspace, creates a temp bundle and validates output):

```bash
DATABRICKS_EXECUTE_INTEG=1 \
  DATABRICKS_EXECUTE_CLUSTER_ID=<cluster-id> \
  node .yarn/releases/yarn-3.2.1.cjs workspace @fermumen/databricks-execute test:integ
```

Manual smoke commands (using a real bundle in the repo):
- Notebook:
  - `databricks-execute exec-example/test.ipynb --target dev`
- Plain python:
  - `databricks-execute exec-example/example_dbs.py --target dev`

### 6) Versioning + publish

- Always bump version (npm forbids republishing an existing version).
- Publish from `packages/databricks-execute/`:
  - `npm publish --access public`

## How to handle upstream behavior changes

### Notebook output changes

We currently print notebook results by extracting text-like outputs from the exported run HTML:
- ANSI stdout/stderr
- `mimeBundle` values (e.g. `text/plain` for `1+1`)

If upstream changes the exported HTML structure:
- Update parsing in `packages/databricks-execute/src/core.ts` (extractor functions).
- Add a unit test that captures the new structure.

### Error parsing changes

If upstream `ErrorParser.ts` changes:
- Keep importing it (preferred).
- If it becomes VSCode-dependent, fork a copy into `packages/databricks-execute/src/` and add unit tests around stacktrace rewriting.

## Compatibility rules

- Prefer **backward-compatible** updates for the CLI interface.
- If a change is breaking, bump major/minor appropriately and update `README.md`.
- Keep notebook-vs-script behavior consistent:
  - `.ipynb` and “Databricks notebook source” => workflow notebook task
  - plain `.py` => command execution

