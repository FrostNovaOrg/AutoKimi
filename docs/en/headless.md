# Headless tasks and orchestration

[English](headless.md) | [简体中文](../headless.md)

AutoKimi 0.3.1 adds an explicit `exec` entry for parent agents, orchestrators and scripts. Plain `autokimi` still opens the TUI; native `-p`, ACP and Web service entries remain disabled. Configure Kimi authentication, the main model and reviewer before calling it. Headless workers do not log in interactively or request human approval.

## Submit, observe and stop

```sh
autokimi runs schema
autokimi exec --prompt-file task.txt --cwd /path/to/project \
  --idempotency-key task-42 --max-steps 30 --max-requests 120 \
  --max-tools 100 --max-tokens 200000 --timeout 15m --detach
autokimi runs status <run-id> --json
autokimi runs events <run-id> --after 0 --limit 100
autokimi runs stop <run-id>
```

Place task options after `exec`; global TUI options cannot configure these commands. Choose `--prompt` or `--prompt-file`, with at most 1 MiB of input. `--model <alias>` selects a configured main model for a new task. The reviewer uses shared review settings. `--format jsonl` is the only output format.

`--detach` returns one `run.accepted` record. An independent worker owns the task, so caller exit or disconnection does not stop it. Without `--detach`, the foreground client streams the current attempt's events and waits for its result. SIGINT/SIGTERM request cancellation and wait for cleanup. Killing the client is not cancellation; use `runs stop`.

`runs stop` persists a cancellation request, including while a task is queued. `run.stop_accepted` means receipt only. Keep polling until terminal state to confirm cancellation and child-process cleanup. Stopping a finished task returns its snapshot without starting a model. `status`, `events` and `list` only read local state.

## Protocol and idempotency

Output is `version: 1` JSONL. Stdout contains structured records; diagnostics go to stderr. `runs schema` describes defaults, statuses and exit codes. Events contain `run_id`, `session_id` once created, `attempt`, `sequence`, `timestamp`, `type` and `data`. Track `run.started`, `run.usage`, `assistant.delta`, tool events, `permission.denied` and `run.finished`. The final event's `data` contains status, result, cumulative usage and denial or error details.

`run_id` identifies a task, `session_id` its native context and `attempt` an explicit continuation. Sequence numbers increase across attempts. `--after` is an exclusive cursor; `--limit` accepts 1–200. Persist `next_cursor` and keep paging while `has_more` is true. Text arrives in chunks; terminal `final_text` is authoritative.

Within one Kimi home, `--idempotency-key` deduplicates semantically identical submissions, including reordered options. Reusing a key with different input, budgets or capabilities conflicts. A duplicate returns the original run without another worker. An earlier attempt's key cannot attach to a later attempt; use a new key for each deliberate continuation. Keys do not deduplicate across machines or Kimi homes.

A successful `runs status` exit code only means the query succeeded. Inspect `state.status`, `reason`, `resumable`, `usage` and `permission_denials` for the task outcome. `permission_denials` retains the latest 100 entries; `usage.denials` is the total:

| Status                   | Meaning                                            | Foreground execution exit code                |
| ------------------------ | -------------------------------------------------- | --------------------------------------------- |
| `completed`              | Finished without permission denials                | 0                                             |
| `completed_with_denials` | Agent finished, but at least one action was denied | 4                                             |
| `blocked_input`          | Caller input is required                           | 4                                             |
| `stopped`                | Budget, timeout, cancellation or safety stop       | Budget/timeout 5, cancellation 6, otherwise 7 |
| `failed` / `interrupted` | Runtime error or lost worker                       | 7                                             |

Invalid requests return 2; retryable lock conflicts return 3. `queued`, `running` and `stopping` are active states. Final prose, a successful query or an accepted stop request does not establish task completion.

## Budgets and continuation

Every budget is a cumulative run limit:

| Option           | Default | Scope                                                             |
| ---------------- | ------- | ----------------------------------------------------------------- |
| `--max-steps`    | 30      | Main and subagent model-loop steps                                |
| `--max-requests` | 120     | All model requests, including review, both stages and retries     |
| `--max-tools`    | 100     | All tool attempts, including denied attempts                      |
| `--max-tokens`   | 200000  | Provider-reported input, cached input and output tokens           |
| `--timeout`      | 15m     | Cumulative active runtime, including model, review and tool waits |

The engine controller holds caller limits outside model control. Goal-budget tools cannot raise them. Checks run before model requests and tool execution. Token accounting depends on provider usage reports and can overshoot for in-flight requests, including concurrent subagent requests; it is not a monetary cap. Paused time is excluded. Crash recovery inherits the latest persisted time and usage, and cannot recover unreported tokens. Cleanup has separate bounded waits.

```sh
# Raise the total cap, rather than grant an additional number of steps.
# If 30 steps are used, a cap of 45 allows at most 15 more.
autokimi exec --resume <run-id> --max-steps 45 \
  --idempotency-key task-42-attempt-2 --detach

# Supply explicit input after a question.
autokimi exec --resume <run-id> --prompt 'Choose A and continue the original task'

# Start a new task and budget in existing native context.
autokimi exec --session <session-id> --prompt-file next-task.txt --cwd /path/to/project
```

Only `resumable: true` permits continuation. Explicitly increase every exhausted cap. A resume cannot change the workspace or model, or expand network capability; read-only restrictions can only tighten. Counters, the denial window and native session carry forward. Safety stops and ordinary runtime errors do not automatically retry. `--session` creates a new task, whose new scope requires caller authorization. Concurrent writers to the same session are rejected. Separate session locks do not serialize workspace writes; the orchestrator should give parallel coding tasks independent worktrees or directories.

A lost worker becomes `interrupted/worker_lost`. Recovery uses native SDK history rather than manufacturing a conversation from assistant text. If an unfinished tool is recorded, inspect files, child processes and external effects before passing `--accept-uncertain-effects`. This acknowledgment neither rolls back nor automatically replays tools.

## Permissions and isolation limits

Headless execution forces Always Ask and automatic review. An environment override disabling review fails before model execution. Switching to auto/yolo stops the run. Native deny rules remain effective; side-effect tools ordinarily allowed directly by native rules are sent through review. The limited read-only tool set retains a direct path, subject to budgets, file scope and native deny rules.

`--cwd` grants the file-tool workspace, with real-path and symlink checks and protection for the Kimi home. `--read-only` permits a limited set of read, query and task-local state tools, disabling Bash, writes and MCP. WebSearch, FetchURL and MCP are disabled by default; `--allow-network` admits them to normal permission review. It does not control provider connections. Bash networking additionally requires this flag and permission from the OS sandbox’s `shell_allowed_domains`.

**Bash and descendants require the OS sandbox.** Writes outside the workspace and temporary directory are denied; discovered instructions, runtime configuration and their real targets remain protected. Missing sandboxes refuse the command. File tools and MCP are outside the shell sandbox, and the whole task process is not isolated as a multi-tenant service. The orchestrator still owns strict isolation; see [sandbox configuration](configuration.md#shell-os-sandbox-031).

Headless execution does not consume TUI one-time grants or fabricate human approvals. `AskUserQuestion` produces `blocked_input`, leaving the parent session to supply input. The caller owns goals and scheduling: tasks cannot create autonomous goals, scheduled jobs or detached background delegation. Cancellation cleans up only background tasks created by the current run.

## Local state and operations

State lives under `<KimiHome>/autokimi/runs/<run-id>/`, with directory mode 0700 and task-file mode 0600. Requests, results and events may contain task text. Treat them as sensitive session data and keep them out of repositories and public logs. Permission-review audits retain their separate format.

Each run has one worker and each native session one writer, coordinated through local atomic file locks. This is a trusted single-machine protocol, not a remote multi-tenant service. Journals are limited to 32 MiB; final text is capped at 64 KiB with `text_truncated` marking truncation. Reaching the journal limit fails the run. There is no automatic retention policy. After confirming a task has stopped, remove whole run directories according to your policy, retaining required cursors and results. Stop active tasks before replacing or removing their runtime package.

See [verification](verification.md) for tested platforms and [configuration](configuration.md) for model settings and costs.
