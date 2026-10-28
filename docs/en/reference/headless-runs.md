# Headless runs

`kimi exec` runs an observable task with automatic permission review and cumulative budgets. Enable the [Auto Review capability](../guides/auto-review.md) first. `kimi -p` remains available for single prompts with its existing output protocol.

## Start and query a task

```sh
kimi exec --prompt "Fix the failing tests in this workspace" --max-steps 30 --timeout 15m --detach
kimi runs status <run-id> --json
kimi runs events <run-id> --after 0 --limit 100
kimi runs stop <run-id>
```

`--detach` returns a run ID immediately. Without it, the command follows JSONL events until the attempt ends. `runs status`, `events`, `list`, `stop`, and `schema` do not start a model. Stop acknowledges a cancellation request; poll status until cleanup finishes.

Querying an unknown run with `runs status` returns `run_not_found` without creating a task record. `runs list` keeps readable tasks available when another record is incomplete or corrupt. Its optional `warnings` array identifies skipped records with `run_id`, `code`, and `message`; check these warnings before assuming the list is complete.

Use `--cwd <path>` to grant another workspace, `--prompt-file <path>` for a UTF-8 input file, and `--model <alias>` to select a model for a new task. Place task options after `exec`. `--idempotency-key <key>` makes identical submission retries return the same run; a changed request with the same key is rejected.

## Budgets

| Option | Default | Counts |
| --- | --- | --- |
| `--max-steps` | 30 | Main and subagent loop steps |
| `--max-requests` | 120 | Model requests, including reviews and retries |
| `--max-tools` | 100 | Tool attempts |
| `--max-tokens` | 200000 | Reported input and output tokens |
| `--timeout` | `15m` | Cumulative active runtime |

All caps are positive integers. Time accepts `ms`, `s`, `m`, or `h`. Token usage is reported after a request, so one request may exceed the cap; missing provider usage cannot be estimated precisely. Steps, requests, tools, and time provide independent limits.

## Resume work

```sh
kimi exec --resume <run-id>
kimi exec --resume <run-id> --prompt "Continue after the requested clarification" --max-steps 60
```

Resume retains the native session context, workspace restrictions, accumulated usage, and previous limits, and reactivates a paused or blocked goal before submitting the next instruction. An exhausted cap requires an explicit increase; restarting an attempt never resets usage. `--session <session-id>` starts a new run in an existing session and cannot be combined with `--resume`.

A live run cannot be resumed by another worker. After an unexpected worker exit, inspect any uncertain tool effects before passing `--accept-uncertain-effects`. Cancellation cleans up owned tools and background work before a run becomes resumable. If cleanup fails, it is reported as a failure rather than a clean stop.

## Permissions and input

Every run uses `review`, including when it resumes a session previously using Never Ask. Switching away stops the run. Side-effect tools are reviewed even if a normal interactive allow rule would have approved them directly; explicit deny rules remain authoritative.

`--read-only` limits workspace operations to the supported read-only tool set and permits internal goal bookkeeping. Goals start automatically and retain Auto Review; their continuation turns share the run's cumulative limits. Goal updates appear as `goal.updated` events and the latest snapshot is available in `state.goal`. A stopped or blocked goal produces a resumable non-success result with reason `goal_paused` or `goal_blocked`; raising an inner goal budget cannot raise the caller's run limits.

Network tools and MCP are disabled unless `--allow-network` is present, and still require review. Shell execution requires the operating-system sandbox and configured allowed domains. Cron scheduling, unattended one-time grants, and automatic replies to human questions are unavailable. A question produces `blocked_input`; resume with a new prompt after the caller has obtained the answer.

## Events and exit codes

`kimi runs schema` prints protocol version 1, defaults, statuses, permission requirements, and exit codes. Events carry a monotonic sequence; `--after` is an exclusive cursor across attempts. Output is JSONL (one JSON object per line).

`tool.progress` includes the tool's progress text in `data.message`, capped at 2,048 characters. `data.kind` distinguishes status updates, output, and progress; `percent`, `replace`, and `custom_kind` are included when supplied by the tool. Existing event identifiers, cursors, and protocol version remain unchanged.

| Exit code | Meaning |
| --- | --- |
| 0 | Completed |
| 2 | Invalid request |
| 3 | Retryable conflict |
| 4 | Human input required, permission denials, or a stopped goal |
| 5 | Budget reached |
| 6 | Cancelled |
| 7 | Runtime failure |

A run may finish with denials while completing other allowed work. Inspect `status`, `reason`, `permission_denials`, and `resumable`; an exit code alone does not describe every outcome.

## Storage

Private run requests, state, cancellation requests, and event journals live under `<KimiHome>/runs/<run-id>/`. Native sessions remain under `<KimiHome>/sessions/`, with the normal session locks. Run ownership and session locks prevent simultaneous writers; journal and audit writes reject unsafe links and special files.
