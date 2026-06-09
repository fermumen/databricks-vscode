# `databricks-execute` smoke examples

This folder is a minimal Databricks Asset Bundle used to smoke-test the local
`@fermumen/databricks-execute` CLI from the repository root.

## Prerequisites

- Databricks CLI installed and authenticated for the workspace in
  `databricks.yml`.
- The local CLI has been built:
  `node .yarn/releases/yarn-3.2.1.cjs workspace @fermumen/databricks-execute build`
- Run commands from the repository root so the local built CLI can be used.

## Plain Python on a cluster

Runs through the Command Execution API on the `dev` target's configured cluster.

```bash
node packages/databricks-execute/dist/cli.js exec-example/example_dbs.py --target dev
```

Expected output includes:

```text
hello
```

## Databricks notebook-source file on a cluster

Runs through the Jobs API as a notebook workflow task and passes widget/base
parameters.

```bash
node packages/databricks-execute/dist/cli.js \
  exec-example/widget_params_example.py \
  --target dev \
  --widget greeting=hello \
  --widget name=smoke
```

Expected output includes JSON similar to:

```json
{"greeting":"hello","name":"smoke"}
```

## Databricks notebook-source file on serverless

Runs the same notebook workflow task without using the target cluster. This is
the preferred smoke test for serverless Jobs API compatibility.

```bash
node packages/databricks-execute/dist/cli.js \
  exec-example/widget_params_example.py \
  --target dev \
  --serverless \
  --widget greeting=hello \
  --widget name=serverless-smoke
```

Expected output includes JSON similar to:

```json
{"greeting":"hello","name":"serverless-smoke"}
```

## Notes

- Plain `.py` files such as `example_dbs.py` require a cluster.
- `.ipynb` files and Databricks notebook-source files, such as
  `widget_params_example.py`, run as workflow notebook tasks and support
  `--serverless`.
- Notebook runs do not support positional script args or `--env`; use
  `--widget KEY=VALUE` for parameters.
