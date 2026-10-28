# AutoKimi

[English](README.md) | [简体中文](README.zh-CN.md)

Model-based tool permission review for the Kimi Code native TUI and observable headless tasks.

[MIT](LICENSE) · [Installation](docs/en/installation.md) · [Configuration](docs/en/configuration.md) · [Architecture](docs/en/architecture.md) · [Contributing](docs/en/CONTRIBUTING.md)

AutoKimi adds automatic permission review to Kimi Code's native TUI. Launch the review-enabled runtime with `autokimi`; the official `kimi` command remains available.

When a tool operation requires approval, the reviewer uses the user's authorization and the exact action to **allow or deny** it. Uncertainty, timeouts and review failures result in denial with a reason. There is no automatic fallback to human approval. Recoverable model service errors retry with backoff; repeated infrastructure failures trigger a short cooldown. Only consecutive or accumulated safety denials stop the current turn.

**AutoKimi is an independently maintained MIT project, separate from Moonshot AI's official distribution.** It maintains a small set of patches over the official source, currently pinned to Kimi Code **2.3.3**. It reuses existing Kimi login, provider and model settings. Integration through the engine permission entry point and SDK requires a separate JavaScript runtime, selected by the launcher.

## Features and boundaries

- Isolate shell writes and network access by default; unavailable sandboxes refuse execution without an automatic fallback.
- Review pending tool actions in the native TUI, with two-stage decisions, service retries and an audit trail.
- Request one exact retry for eligible model denials, with complete action details and a confirmation that defaults to Cancel.
- Submit agent-friendly headless jobs with JSONL events, idempotency keys, cumulative budgets, cancellation and native-context continuation.
- Choose a separate reviewer model, provider and endpoint, or follow the current agent's model by default.
- Rebuild from a pinned upstream commit, frozen dependencies and patches; install and update independently while retaining older runtime packages.

In the TUI, existing allow/deny rules run first and the reviewer receives pending actions. Headless `exec` additionally requires review for side-effect tools, while preserving native denials and a limited read-only tool set. Models can make incorrect decisions. Version 0.3.1 sandboxes Bash and its descendants through Anthropic’s OS sandbox runtime by default; file tools and MCP retain their own permission boundaries. Use native Kimi for ACP and Web services.

| Item                 | Current status                                                                     |
| -------------------- | ---------------------------------------------------------------------------------- |
| AutoKimi / Kimi Code | 0.4.0 / 2.3.3                                                                      |
| Build requirements   | Node.js ≥24.15.0; pnpm 10.33.0                                                     |
| Tested               | macOS ARM64: build, TUI regression tests and both installation paths               |
| Pending validation   | Linux terminal interaction and other platform combinations; Windows is unsupported |

Linux x64 CI has passed build, regression and isolated installation checks; see the [verification record](docs/en/verification.md).

Linux shell execution also requires host permission to create the sandbox's user namespaces. Ubuntu 24.04+ restrictions may need administrator configuration; see [troubleshooting](docs/en/troubleshooting.md).

## Installation

The installer supports macOS/Linux on ARM64 and x64. macOS ARM64 has been tested interactively; Linux x64 has passed CI checks. Run:

```sh
curl -fsSL https://raw.githubusercontent.com/FrostNovaOrg/AutoKimi/1e9191a7616639a82148454a11b796136284886b/install.sh | sh -s -- --revision 1e9191a7616639a82148454a11b796136284886b
```

The command pins both the installer and AutoKimi source commit, then builds the pinned Kimi baseline. It does not execute mutable main. Runtime packages requested with `--version` require GitHub provenance bound to the repository, workflow and commit. Local packages require an independently trusted `--sha256`. It requires curl and tar; source builds also require Git and download the exact pnpm version. A first build may use several GB of disk space. If Node.js ≥24.15.0 is missing, the script installs Node in AutoKimi's own directory. It prints the launch command and PATH instructions when finished. Linux shell sandboxing requires `/usr/bin/bwrap`, `/usr/bin/socat` and `/usr/bin/rg` (`bubblewrap socat ripgrep` on Debian/Ubuntu). macOS uses system Seatbelt.

With an existing checkout, run `sh install.sh --source`. You can also build and install manually:

```sh
git clone https://github.com/FrostNovaOrg/AutoKimi.git
cd AutoKimi
git checkout --detach 1e9191a7616639a82148454a11b796136284886b
npm run build
npm run install:local -- --timeout-ms 90000
~/.kimi-code/bin/autokimi
```

Manual builds require Node.js ≥24.15.0 and pnpm **10.33.0**. Installation selects Auto Review as the AutoKimi default, using its own configuration key. The one-command installer preserves an existing review timeout unless you pass `--timeout-ms 90000` to set it to 90 seconds. Login and model configuration remain shared; the official `kimi` executable is preserved.

On first use, run `/login`, or add a service with `/provider` and select a model with `/model`. Existing Kimi settings can be reused. AutoKimi keeps its permission default and new session data separate from native Kimi; login and model settings remain shared.

Inside the TUI:

```text
/auto-review status
/auto-review on
/auto-review model <configured-model-alias>
/auto-review denials
/approval
/auto-review off
```

`/auto-review` opens the settings menu. The toggle applies to the current session, or changes the global default when no session is active. The reviewer model is a shared setting. `/auto-review model` lets you select a configured model or follow the current session model.

`/approval` (alias `/approve`) lists eligible denied actions. Press Enter to inspect the complete arguments, working directory and reason. Details default to Cancel. After scrolling to the end, use Tab to select “Approve this action once”, then Enter to submit. Repeated Enter presses and Space do not grant approval; Esc cancels before submission. Success returns to the input; failure leaves a retry option. `denials` is diagnostic, and explicit-ID approval uses the same confirmation. The exact tool, arguments and cwd must remain unchanged and undergo review again. No permanent allow rule is created. Compaction, undo, reset or restart invalidates old grants.

For parent agents and automation, use the explicit headless interface:

```sh
autokimi exec --prompt-file task.txt --cwd /path/to/project --max-steps 30 --detach
autokimi runs status <run-id> --json
autokimi runs events <run-id> --after 0
autokimi runs stop <run-id>
```

Tasks use automatic review and caller-owned budgets. `--resume <run-id>` continues native context with cumulative counters; `--session <session-id>` starts a new task in existing context. Permission denials are reported as incomplete outcomes. See the [headless protocol](docs/en/headless.md) before integration. Native root `-p/--prompt`, non-terminal TUI startup and ACP/Web services remain disabled.

The permission picker now offers **Always Ask → Auto Review → Ask When Needed → Never Ask**. Select Auto Review for model checks, or use `/auto-review on`; `/auto-review off` selects Always Ask. Official `/auto` still selects Never Ask. The bottom bar shows the active permission mode.

Version 0.4.0 stores sessions under `<KimiHome>/autokimi/sessions/`. To continue an earlier AutoKimi or native Kimi session, close it and run `autokimi session legacy-list`, then `autokimi session import <id>` and `autokimi -r <id>`. Import copies the history and keeps the source unchanged. See [session compatibility](docs/en/architecture.md#permission-modes-and-session-compatibility).

## Source layout

`upstream.lock.json` pins the official commit. `overlay/` holds new source files, `patches/` changes existing files, and `tools/` prepares, builds and installs the runtime. The repository keeps the differences, without the full upstream history, dependencies, runtime packages, login settings or sessions. Generated `.cache/` and `.artifacts/` directories stay out of Git. See [development](docs/en/development.md).

## Documentation

- [Installation, updates and removal](docs/en/installation.md)
- [Configuration, review behavior and context](docs/en/configuration.md)
- [Headless tasks and orchestration](docs/en/headless.md)
- [Native integration architecture](docs/en/architecture.md)
- [Development and upstream upgrades](docs/en/development.md)
- [Timeouts and troubleshooting](docs/en/troubleshooting.md)
- [Verification scope and known limits](docs/en/verification.md)
- [Contributing and reporting issues](docs/en/CONTRIBUTING.md)
- [Security policy](docs/en/SECURITY.md)

Normal builds pin Kimi **2.3.3** and MCP SDK **1.32.2**. `autokimi update` fetches current project source and validates a candidate; installation requires `--install`. `autokimi upgrade` may also upgrade the official `kimi`. `autokimi --version` shows the project and source identity. See [updates](docs/en/installation.md#updates).

Reviews call the selected provider, adding requests and potential costs. Incorrect denials and approvals remain possible; model review and the Bash OS sandbox are separate layers; file tools and MCP run outside that shell sandbox. See the [verification scope](docs/en/verification.md).

Based on Moonshot AI's MIT-licensed source, with its copyright notices retained. See [LICENSE](LICENSE), [LICENSE.upstream](LICENSE.upstream) and [NOTICE](NOTICE).
