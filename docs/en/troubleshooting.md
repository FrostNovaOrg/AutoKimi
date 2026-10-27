# Troubleshooting

[English](troubleshooting.md) | [简体中文](../troubleshooting.md)

## Only `/auto` appears, without `/auto-review`

Confirm you launched `autokimi`, rather than official `kimi`. Official `/auto` selects Never Ask. After installation, use `command -v autokimi` to locate the launcher and run `autokimi --version`. It shows the AutoKimi version, source identity and upstream Kimi 2.3.3. Check that `/auto-review status` works in the TUI to confirm review support.

If the command is missing, add the selected home's `bin` directory to PATH. An existing unmanaged command with the same name prevents installation; determine its origin first.

## Review shows ON but does not run

Use `/auto-review on` to select Always Ask. Never Ask and yolo pause review. Actions already allowed by existing rules do not call the reviewer individually.

If an environment override is reported, check `KIMI_CODE_EXPERIMENTAL_APPROVAL_REVIEW` and `KIMI_CODE_EXPERIMENTAL_FLAG`; environment variables take precedence over configuration.

## Review timed out

No final verdict was obtained before the deadline, so the action was denied. This does not mean the model judged it dangerous. Both stages share one deadline; a slow first stage leaves less time for the second.

The source default is 30 seconds total. Set `timeout_ms = 90000` under `[permission.review]`, or explicitly pass `--timeout-ms 90000` when reinstalling. Reinstalling without the option preserves the existing value.

Check `durationMs`, `reason` and `stopTurn` in that session's `approval-review.jsonl`. If durations repeatedly approach the limit, inspect provider latency, rate limits and model availability. If 90 seconds still times out, inspect service health and request size. Do not probe by repeatedly executing a denied action.

`Retrying (n/10)` indicates a recoverable connection, rate-limit or provider failure, with upstream backoff in progress; disabling auto-review is unnecessary. Each stage allows at most 10 attempts under the shared deadline and cancellation signal. A recovered request continues with the normal verdict. Exhaustion denies the current action; consecutive tool-level failures trigger a 30-second cooldown. These are infrastructure failures, not safety verdicts, and do not by themselves stop the turn. Later retries must stay within the original exact authorization; changing tools cannot recreate the same denied effect.

An earlier local investigation found 5 timeouts near 30 seconds among 186 reviews. First-stage usage events during those windows suggested insufficient time for the second stage. The old audit lacked per-stage timing, so queueing and reasoning time could not be separated. Extending the deadline addressed that observation; it does not establish that all future timeouts are eliminated.

## A previously read script or earlier authorization is denied

Evidence associates only reads or script content relevant to the current action's paths. Compacted summaries do not count as user authorization. See [configuration](configuration.md) for context scope. Pagination, tool truncation or an explicit character limit without proof of completeness makes evidence incomplete. Unrelated paths can also cause conservative denial. Read the related script completely and supply evidence within the original exact authorization. The word “truncated” in file content does not itself mean tool truncation. Steps may be split only if they reduce actual effects, can be verified independently and do not produce the original denied effect. Changing tools, encoding or delegation to achieve that effect is prohibited.

## Retry a model denial once

Run `/approval` (or `/approve`) to list eligible denials in the current session. Enter opens complete arguments, cwd and reason. Scroll to the end, use Tab to select one-time approval, then Enter to send. Cancel is the default; repeated Enter and Space do not grant approval. Success is reported only after SDK acknowledgment; failure leaves a retry option. `/auto-review approve [toolCallId]` uses the same confirmation; `denials` is diagnostic. The main agent must resubmit the exact same tool, arguments and cwd for review. No permanent rule is created.

An empty list usually means the denial came from a protected path, explicit ask rule, configuration/evidence problem, infrastructure failure, critical verdict or subagent. These are ineligible. Changed arguments, a consumed challenge, compaction, undo, session reset, restart, disabling review or leaving Always Ask also prevent approval. `importContext`, tool output and assistant text cannot construct a valid one-time grant.

## Reviewer unavailable / invalid response

Check the model alias, authentication and provider. A response outside the required JSON format, truncation or filtering can also cause failure. Verify model configuration without posting authentication details in an issue. `/auto-review model <alias>` selects a configured model.

Two consecutive tool-level infrastructure failures trigger a 30-second cooldown rather than stopping the turn. Retry afterward within the original authorization. Audit failure still denies the action, without clearing the model safety-denial stop counters.

## Following upstream fails

`npm run follow:upstream`, `autokimi update` and `autokimi upgrade` run only when explicitly called, without background retries. Inspect the work directory's `report.json` and command output to locate the failure: evidence, build, tests, official upgrade, packaging or installation. `officialStatus` and `autoKimiStatus` track the two components separately. `partial` means failure occurred after official Kimi upgraded or AutoKimi installed; it is not complete success. `failed` does not prove versions remained unchanged.

- `npm tarball hash mismatch`, `Provenance commit does not match` or signature failure: do not install that candidate. Check official publication completeness without bypassing verification.
- `Upstream package manager changed`, `Node engine changed` or changed native dependencies: maintainer porting is required; automatic compatible-version following cannot continue.
- Patch conflict or build/test failure: the candidate cannot be installed and official upgrade is not attempted. Inspect reports and the isolated worktree; do not hide the error by changing the root lock.
- Official upgrade fails or reread version misses the target: AutoKimi installation does not proceed. Check the official version and upgrade log.
- Official upgrade command errors but actual version increased: state is `updated` and `partial`. If the version cannot be reread, it is `unknown`. Neither means the version stayed unchanged or the operation fully succeeded.
- Official Kimi upgraded but AutoKimi installation failed: state is `partial` and the old AutoKimi release remains. Both components have not necessarily returned to their old versions.
- `cleanupWarning` after installation committed: the launcher and receipt retain installed state, but temporary directories or a lock may remain. Inspect before cleaning; do not repeat the upgrade to hide the warning.

The upgrade process rereads installation under lock to prevent a concurrent follower from downgrading based on stale state. This does not prohibit a maintainer's explicit manual installation of an older package. Installation, configuration and receipt failures are handled by stage; external side effects cannot all be assumed reversible. Without explicit `--install`, `upgrade` or `install:local --lock <candidate-lock>`, the current installation remains unchanged.

## Cache reports local edits or Overlay changed

The preparer protects edits in generated source. Copy needed changes back to overlay/patches and back them up, then restore with a fresh `--worktree`, or clean the old generated directory yourself. Do not remove state markers to force reuse of inconsistent source.

## Headless caller exits before the task is complete

Inspect `autokimi runs status <run-id> --json`; query success does not establish completion. Check `permission_denials` for `completed_with_denials`, supply explicit input before resuming `blocked_input`, and inspect budgets or cancellation for `stopped`. Do not route around denials or reset counters. For `worker_lost`, inspect unfinished effects before following [recovery](headless.md). `submission_busy`, `run_busy` and `session_busy` are lock conflicts: back off with the same idempotency key, without deleting active locks. If an installation lacks `exec`, confirm its version is at least 0.3.0.

## Shell sandbox unavailable / shell was not started

Each runtime checks the real sandbox with a harmless command before starting user shell work. An installed binary alone does not prove the backend can launch. Startup failure denies shell execution and appears in the headless task's permission denials; inspect the reported backend error. AutoKimi does not retry outside the sandbox.

Ubuntu 24.04+ may allow bubblewrap itself but deny the nested namespaces used by `apply-seccomp`. Ask the host administrator to assess namespace policy against the [upstream requirements](https://github.com/anthropics/sandbox-runtime#platform-specific-dependencies). AutoKimi never changes host security policy. Following upstream's own integration setup, CI enables capability-bearing user namespaces only on its disposable runner; the runtime still enforces filesystem, network, socket and nested-namespace restrictions. This CI configuration does not establish compatibility with every host's default policy.

On Linux, check `/usr/bin/bwrap`, `/usr/bin/socat`, `/usr/bin/rg` and user-namespace support. Container or host restrictions do not trigger a downgrade. On macOS, check system `sandbox-exec`. Inspect protected hardlinks or unresolved links and have a trusted user resolve aliases. Allow only required `shell_allowed_domains`; headless tasks also need `--allow-network`. External caches and linked-worktree shared Git metadata may be denied; use project caches or the parent orchestrator. See [configuration](configuration.md#shell-os-sandbox-031) for changed defaults and the trusted-TUI compatibility setting.
