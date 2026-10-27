# Configuration and review behavior

[English](configuration.md) | [简体中文](../configuration.md)

## Toggle and permission mode

```toml
default_permission_mode = "manual"

[experimental]
approval_review = true

[permission.review]
timeout_ms = 90000
max_context_chars = 60000
two_stage = true
# model = "provider/model-alias"
# policy = "Additional trusted operating policy"
```

Configuration is usually in `~/.kimi-code/config.toml`. Merge these keys into the corresponding existing tables; do not define TOML tables twice. The reviewer uses a configured model alias. If omitted or set to `@session`, it follows the current agent's model and authentication.

| Setting             | Source default      | Range / meaning                                                                             |
| ------------------- | ------------------- | ------------------------------------------------------------------------------------------- |
| `approval_review`   | `false`             | Enabled by installation and `/auto-review on`                                               |
| `timeout_ms`        | `30000`             | 1000–120000 milliseconds, shared by both stages; installation examples explicitly set 90000 |
| `max_context_chars` | `60000`             | Review evidence budget of 4000–100000 characters, not tokens                                |
| `two_stage`         | `true`              | Independent full review when fast review does not allow                                     |
| `model`             | Current agent model | Does not inherit the main agent's thinking effort                                           |
| `policy`            | None                | Up to 8000 characters appended to the review system policy                                  |

`KIMI_CODE_EXPERIMENTAL_APPROVAL_REVIEW` or the master `KIMI_CODE_EXPERIMENTAL_FLAG` can override configuration. The TUI identifies an environment override; commands cannot rewrite that override.

Invalid `review` configuration does not discard `permission.rules`. The runtime retains invalid raw values and denies affected reviews. Strict configuration writes still fail rather than silently restoring review defaults.

`/auto-review on` enables review and selects Always Ask. `status` queries state and synchronizes the bottom bar. `off` restores the selected permission mode's original approval behavior. With an active session, on/off overrides only that session and is saved in session metadata, without changing sessions in other directories. With no active session, it changes the global default. Environment overrides still take precedence. Official `/auto` selects Never Ask; `yolo` also pauses review. During asynchronous activation or session switching, the latest session and permission state take precedence; stale snapshots do not overwrite modes or the bottom bar.

## Reviewer model, effort and endpoint

When `permission.review.model` is omitted or set to `@session`, the reviewer follows the agent that triggered the action. For the main agent, this is the current `/model` selection; a subagent may use a different model. An explicit alias selects that model for reviews. `/auto-review model` offers configured models, and `/auto-review status` shows the setting. The model is shared configuration; the toggle can be overridden per session.

The review thinking-effort policy is fixed in code. Always-thinking models use `low` when supported, otherwise their default effort or `on`. Other models use `off`. Both fast and full reviews use this policy, without inheriting the main agent's effort. There is currently no review-specific effort configuration key.

To use a separate review service, add a provider and model alias to the appropriate existing `config.toml` tables:

```toml
[providers.review_api]
type = "openai"
base_url = "https://api.example.com/v1"
api_key_env = "REVIEW_API_KEY"

[models.reviewer]
provider = "review_api"
model = "YOUR_MODEL_ID"
max_context_size = 32768 # Set to the actual model capacity

[permission.review]
model = "reviewer"
```

Supply the key through the selected environment variable. Endpoint precedence is model-level `base_url`, provider-level `base_url`, then the protocol's environment variable or default. `permission.review` references a model alias and accepts neither a separate `base_url` nor an `effort` key. Changes to a shared provider affect other models using it; a separate provider lets you manage review endpoint and credentials independently. Restart the interactive session and query status after changing it.

## Final decisions are allow or deny

Existing permission rules run first. Actions already allowed or explicitly denied retain their original behavior; only pending approvals reach the reviewer. An explicit `ask` rule is denied directly in review mode, without opening an approval dialog.

With two stages enabled, a valid `allow` from fast review passes. A fast `deny` or internal `ask` triggers an independent full review using the same evidence, without seeing the first verdict. Remaining uncertainty becomes denial. With two stages disabled, only full review runs.

Timeouts, unavailable models, invalid or truncated responses, oversized evidence, authorization or setting changes during review, and audit write failures deny the action. Recovery depends on the source. Review calls automatically retry provider errors considered recoverable upstream, with at most 10 attempts per stage. They use the main Kimi loop's exponential backoff, `Retry-After` and cancellation semantics. Retries and waits share the overall review deadline. Safety denials, unrecoverable errors and user cancellation do not retry.

Three consecutive actual safety denials, or 10 safety denials among the last 50 review results including the current one, stop the turn. `reviewer`, `timeout` and `audit` failures do not consume this safety-denial budget. Two consecutive tool-level infrastructure failures trigger a 30-second cooldown; retries become available afterward. A completed model review with a working audit resets the infrastructure-failure count. Missing evidence can be supplied before retrying. A new turn resets counters, cooldown and window. Audit failure changes the final result to an `audit` denial, while the original model safety verdict still contributes to safety counters and the infrastructure failure remains available for diagnosis. An unavailable audit cannot erase consecutive safety denials.

### Decision sources and recovery

Audit `source` distinguishes `model` (actual model verdict), `policy` (deterministic precheck), `config` (invalid configuration), `evidence` (missing authorization or evidence), `authorization` (authorization or setting changes during review), `timeout`, `reviewer` (model service or response failure), and `audit` (audit failure). These sources guide diagnosis and recovery; the permission result remains binary.

- `evidence`: read relevant scripts and supply complete evidence, then retry within the original exact authorization. Missing evidence does not justify a safety stop.
- `reviewer`, `timeout` and `audit`: infrastructure failures do not mean the action was judged dangerous. Recoverable model failures retry first; remaining failures back off and may enter cooldown. They alone do not stop the turn.
- `authorization`: the user must reconfirm the exact action and scope. Authorization from before the change cannot justify a retry.
- `model`: an explicit one-time retry is available only under the conditions below. `policy` and `config` keep strict denial behavior. Fix configuration without widening automatic approval boundaries.

Splitting a task is permitted only when each step reduces actual side effects, can be verified independently, and does not produce the original denied effect. Every step must be reviewed again. Changing tools, scripts, encoding or delegation to achieve the same denied effect is prohibited.

Actions involving review configuration, agent instruction files or unsupported custom approval callbacks are denied in prechecks. File checks follow file and parent-directory symlinks, including dangling targets, to prevent aliases from accessing protected paths. A completely matching `<home>/bin/kimi --version` or `<home>/bin/autokimi --version` may pass this path protection only when the installation receipt, managed release path, entry hash and complete launcher hash are valid; normal review still follows. Task questions, plan or goal confirmation, login and workspace trust may still require interaction. Ordinary pending tool approvals do not open the traditional permission dialog. The exact one-time grant below is the only human override.

### One-time authorization for an exact action

`/auto-review` opens settings for status, toggle, reviewer model and eligible denials. `/auto-review model` opens a searchable model list. Unknown aliases are not written; `model @session` restores following the current session model. Model configuration is shared across sessions; menus and results identify the toggle's scope.

`/approval` (alias `/approve`) lists eligible denials for the current session. Enter opens details. Use ↑↓, PgUp/PgDn and Home/End to inspect the complete tool, arguments, cwd and reason. Focus defaults to Cancel. After scrolling to the end, use Tab or ←→ to select “Approve this action once”, then Enter to submit. Repeated Enter presses, ordinary Space and Kitty-protocol Space do not grant approval. Esc cancels from the list or returns from details to the list. Explicit `/auto-review approve <toolCallId>` uses the same confirmation. `all` is unsupported.

The panel shows progress while sending. Only SDK acknowledgment consumes the TUI record and reports success, then returns to the input. Failure retains the record for retry. Authorization goes directly to the original main session, without being diverted by media attachments, side conversations or cached prompts. Session changes or a session that is not idle prevent submission.

Only actual, non-critical model denials from the main agent are eligible. Challenges bind the toolCallId, complete `{tool,args,cwd}` fingerprint and `prefixRevision()`, with at most 10 retained. They are consumed before the first re-review and cannot be reused even if it fails. A grant adds only `verified_one_time_user_approval`; fast/full review still runs. It does not execute directly or modify permission rules. Compaction, undo, clear, reset or restart invalidates it. Subagents and background automatic approval are unsupported.

### Real answers and approval records

Only direct user prompts and shell input can provide requests; shell output cannot. Answers and approvals come only from actual resolved interactions in the current session's main agent. Tool text or another session cannot reconstruct authorization. Approval must be `resolved + approved`, have complete fields, and exactly match `{tool,args,cwd}`. A one-time approval is consumed in its original flow or before its first review; session approval also requires the corresponding rule to remain present.

The last 8 question answers are passed as `human_question_answers`, while question text is separated into `questions_untrusted` and cannot expand the goal or workspace. Record times, answers and rules contribute to the authorization fingerprint; changes during review invalidate the decision. The facade limits interaction count and lifetime. These are not persistent grants across compaction or restart.

## Evidence visible to the reviewer

The reviewer receives selected evidence rather than the full conversation:

- The current tool, complete arguments, cwd, agent and the root agent's last 8 real user requests. Hooks, skills, summaries, tool output and subagent text cannot authorize actions.
- The last 8 tool calls and path-related `Read` results. Package commands may also link manifests and referenced local scripts. At most 8 reads are retained with completeness flags. Paginated or tool-truncated reads are incomplete. Explicit `max_chars` requires tool state proving complete range coverage and end of file; truncation wording in file content is not a tool truncation signal.
- The last 4 standard verification command results, including success status, the last 4000 output characters and truncation flags.
- Exact one-time authorization, matching unconsumed real approvals, and the last 8 real question answers. Authorization evidence excludes challenge values; question text is untrusted.

When space is limited, verification output, historical calls and older reads shrink first. The current action and fixed authorization evidence are never truncated; exceeding the budget results in denial. `pending_action` appears last. Both stages reuse the same evidence; the second does not see the first verdict. Reading related scripts completely can supply behavioral evidence. Incomplete evidence may result in conservative denial. Any split steps must actually reduce effects and be independently verifiable; changing tools cannot recreate the same denied effect.

## Audit

Session `approval-review.jsonl` records timestamps, tool identifiers, model, verdict, source, duration, fingerprints, denial counters, stop-turn state and authorization-use flags. It excludes raw requests, arguments, answers, interaction IDs, challenges and free-form model reasons. Files use mode `0600`, refuse symlinks and should not be uploaded.

AutoKimi permits the interactive TUI, explicit `exec` jobs and listed administrative commands. New upstream entries are denied by default. Root `-p/--prompt`, ACP/Web and non-terminal TUI startup still fail. Use the [headless task interface](headless.md) for automation. Headless tasks force Always Ask and review, disable TUI one-time grants and inherit caller budgets across continuation.

For old MCP OAuth credentials without an `issuer`, AutoKimi requires login again instead of reusing their tokens or client secrets. Original storage remains available to native `kimi`; new logins retain authorization-server binding.
