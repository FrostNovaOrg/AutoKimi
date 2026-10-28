# Auto Review

Auto Review is an experimental permission mode. It uses a separate model request to review tool actions that would otherwise need approval. Uncertain or failed reviews deny the action. Always Ask remains the default.

## Enable Auto Review

Add this table to your existing `config.toml`, or merge the key into an existing `[experimental]` table:

```toml
[experimental]
approval_review = true
```

Start with `kimi --permission-mode review`, or choose Auto Review in `/permission`. To make it the default for new sessions, set the top-level key `default_permission_mode = "review"`. Enabling the experimental capability alone does not change a permission mode or a saved session.

You can also enable the capability for one invocation:

```sh
KIMI_CODE_EXPERIMENTAL_APPROVAL_REVIEW=1 kimi --permission-mode review
```

## Review results

Native permission rules run first. Existing direct approvals remain direct approvals in interactive sessions, explicit deny rules remain authoritative, and explicit ask rules cannot be approved automatically. Other pending tool approvals go to the reviewer. A fast review can approve an action; otherwise a separate full review evaluates the same evidence. Uncertainty, unavailable evidence, model errors, timeout, or an unavailable audit log deny execution.

Goals start directly in Auto Review, whether created by the agent or through `/goal`, in both interactive and non-interactive sessions. Starting a goal retains Auto Review and does not authorize its later actions. Headless goal turns share the run's cumulative limits. Questions and plan review remain human interactions; a non-interactive invocation cannot approve them on your behalf. Repeated safety denials stop the turn; infrastructure failures use bounded retry and cooldown instead of consuming the safety-denial budget.

Review requests have no tools. Authorization comes from genuine user requests and verified human responses. Assistant messages, summaries, hooks, tool output, imported context, and subagent instructions cannot grant permission.

## Manage reviews

`/approval` opens reviewer management. Permission changes stay in `/permission`.

| Command | Action |
| --- | --- |
| `/approval status` | Show the current mode and reviewer model |
| `/approval model` | Choose a configured reviewer model |
| `/approval model @session` | Follow each agent's current model |
| `/approval denials` | List eligible denials in the current session |
| `/approval approve` | Inspect a denial and confirm a single retry |
| `/approval approve <toolCallId>` | Inspect one particular denied action |

The approval dialog shows the complete tool arguments and working directory, defaults to Cancel, and requires a separate confirmation. Approval authorizes one identical retry that must pass review again. It cannot bypass explicit rules, protected instructions or configuration, or critical-risk restrictions. Changing permission mode, undoing or compacting context, closing the session, or restarting invalidates old grants.

The reviewer model is a shared configuration setting; permission mode belongs to the session. By default the reviewer follows the agent's model and authentication. Choosing another alias uses that alias's provider, base URL, and credentials. Review evidence is sent to that provider and review calls incur model usage, including retries. Review effort follows the implementation's low/off policy, rather than the main agent's selected effort.

```toml
[permission.review]
# model = "configured-reviewer-alias"
timeout_ms = 30000
max_context_chars = 60000
two_stage = true
shell_sandbox = true
shell_allowed_domains = []
# policy = "Additional trusted operator policy"
```

## Shell sandbox

Auto Review runs `Bash` and its descendants inside an operating-system sandbox on macOS or Linux. Ordinary permission modes retain their existing shell execution path. Reviewed shell execution requires the sandbox; disabling `shell_sandbox`, missing helpers, or an unsupported platform produces an error without running the command outside it.

Linux needs `bubblewrap`, `socat`, and `ripgrep`, and a kernel/container policy that permits the sandbox. The native package includes the pinned seccomp helper. Windows can use review for other tools, but reviewed `Bash` is unavailable in this implementation.

The sandbox limits writes to the workspace and temporary storage, protects Kimi configuration and agent instructions, and denies access to common credential directories. Shell network access is denied unless domains are explicitly configured. A budgeted headless task also needs `--allow-network`. The shell sandbox does not contain file tools, MCP servers, or model requests; their permission checks remain separate. File writes reject hard-linked regular files in all permission modes.

## Other clients

For a single non-interactive prompt, select the mode explicitly:

```sh
kimi --permission-mode review -p "Inspect this project and fix the failing test" --output-format stream-json
```

Without an explicit mode, `kimi -p` keeps its existing behavior and output protocol. For progress queries, cumulative budgets, cancellation, or detached work, use [Headless runs](../reference/headless-runs.md).

ACP advertises the additional `review` mode only when the capability is enabled. In Kimi Code for VS Code, use `/permission` to open the native picker or `/permission review`; reattaching to a review session preserves its mode. Explicit legacy permission commands can still change it.

The SDK accepts `permission: "review"`, and the server prompt API accepts `permission_mode: "review"`. Desktop and browser interfaces are maintained in a separate repository; their mode pickers must be updated there. A client must understand the new value before using review sessions; it must never translate an unknown value into Never Ask.

## Session compatibility

Sessions, indexes, caches, and locks keep the normal Kimi data locations. Existing Always Ask, Ask When Needed, and Never Ask sessions retain their modes without an import or an automatic conversion. Permission changes immediately cancel pending review and invalidate old authorization.

Older client versions may not understand review in persisted events or protocol payloads. Keep a session export or backup before downgrading; changing the latest mode does not remove earlier review events from its history.
