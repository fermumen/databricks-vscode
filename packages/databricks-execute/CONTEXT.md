# databricks-execute

A CLI that lets agents and people run local bundle code on Databricks, either as
one-off job runs or as snippets in a long-lived interactive session.

## Language

**Bundle**:
The local project rooted at a `databricks.yml`. It decides which workspace, target
and cluster a command uses. Every command needs one.
_Avoid_: project, repo

**Run**:
One execution of a single local file (notebook or plain `.py`) as a one-off Jobs run.
_Avoid_: job, execution

**Session**:
A named, long-lived Python execution context on a classic cluster that keeps its
state between snippets.
_Avoid_: context (except when talking about the underlying API), REPL, kernel

**Session name**:
The short label (default `default`) that identifies a session within one bundle and
cluster.
_Avoid_: context id, session id

**Snippet**:
A piece of Python code sent to a session as-is, with no file semantics (no argv, cwd
or env setup).
_Avoid_: command, cell, script

**Lost session**:
A session whose execution context no longer exists on the cluster, usually because
the cluster restarted or terminated. It is never recreated silently.
_Avoid_: expired session, stale session
