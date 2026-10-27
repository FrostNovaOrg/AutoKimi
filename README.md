# AutoKimi

[English](README.md) | [简体中文](README.zh-CN.md)

Model-based tool permission review for the Kimi Code native terminal UI.

[MIT](LICENSE) · [Installation](docs/en/installation.md) · [Configuration](docs/en/configuration.md) · [Architecture](docs/en/architecture.md) · [Contributing](docs/en/CONTRIBUTING.md)

AutoKimi adds automatic permission review to Kimi Code's native TUI. Launch the review-enabled runtime with `autokimi`; the official `kimi` command remains available.

When a tool operation requires approval, the reviewer uses the user's authorization and the exact action to **allow or deny** it. Uncertainty, timeouts and review failures result in denial with a reason. There is no automatic fallback to human approval. Recoverable model service errors retry with backoff; repeated infrastructure failures trigger a short cooldown. Only consecutive or accumulated safety denials stop the current turn.

**AutoKimi is an independently maintained MIT project, separate from Moonshot AI's official distribution.** It maintains a small set of patches over the official source, currently pinned to Kimi Code **2.3.3**. It reuses existing Kimi login, provider and model settings. Integration through the engine permission entry point and SDK requires a separate JavaScript runtime, selected by the launcher.

## Features and boundaries

- Review pending tool actions in the native TUI, with two-stage decisions, service retries and an audit trail.
- Request one exact retry for eligible model denials, with complete action details and a confirmation that defaults to Cancel.
- Choose a separate reviewer model, provider and endpoint, or follow the current agent's model by default.
- Rebuild from a pinned upstream commit, frozen dependencies and patches; install and update independently while retaining older runtime packages.

Existing allow/deny rules run first. The reviewer only receives actions passed to it by the permission system. It provides no operating system isolation, and models can make incorrect decisions. AutoKimi supports interactive TUI sessions; use native Kimi for automation, ACP and Web services.

| Item                 | Current status                                                       |
| -------------------- | -------------------------------------------------------------------- |
| AutoKimi / Kimi Code | 0.2.2 / 2.3.3                                                        |
| Build requirements   | Node.js ≥24.15.0; pnpm 10.33.0                                       |
| Tested               | macOS ARM64: build, TUI regression tests and both installation paths |
| Pending validation   | Full Linux and x64 experience; Windows is unsupported                |

## Installation

The installer supports macOS/Linux on ARM64 and x64. macOS ARM64 has been tested; other combinations still need testing. Run:

```sh
curl -fsSL https://raw.githubusercontent.com/FrostNovaOrg/AutoKimi/main/install.sh | sh
```

The script prefers a matching GitHub Release package and verifies its SHA-256 checksum. When no package is published, it builds from source using the pinned Kimi baseline. It requires curl and tar; source builds also require Git and download the exact pnpm version. A first build may use several GB of disk space. If Node.js ≥24.15.0 is missing, the script installs Node in AutoKimi's own directory. It prints the launch command and PATH instructions when finished.

With an existing checkout, run `sh install.sh --source`. You can also build and install manually:

```sh
git clone https://github.com/FrostNovaOrg/AutoKimi.git
cd AutoKimi
npm run build
npm run install:local -- --timeout-ms 90000
~/.kimi-code/bin/autokimi
```

Manual builds require Node.js ≥24.15.0 and pnpm **10.33.0**. Installation enables review and sets the default permission mode to Always Ask. The one-command installer preserves an existing review timeout unless you pass `--timeout-ms 90000` to set it to 90 seconds. Login and model configuration remain shared; the official `kimi` executable is preserved.

On first use, run `/login`, or add a service with `/provider` and select a model with `/model`. Existing Kimi settings can be reused. Changing the shared default permission mode also affects the next launch of native Kimi.

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

**Interactive terminal sessions only.** `autokimi` rejects `-p/--prompt`, session startup without a terminal, and ACP/Web services. Use native `kimi` for automation. Help, version and update commands can run non-interactively.

**The official `/auto` command selects Never Ask and pauses the reviewer.** Keep Always Ask enabled when using AutoKimi; `/auto-review on` switches back to it. Review status appears in the bottom bar.

## Source layout

`upstream.lock.json` pins the official commit. `overlay/` holds new source files, `patches/` changes existing files, and `tools/` prepares, builds and installs the runtime. The repository keeps the differences, without the full upstream history, dependencies, runtime packages, login settings or sessions. Generated `.cache/` and `.artifacts/` directories stay out of Git. See [development](docs/en/development.md).

## Documentation

- [Installation, updates and removal](docs/en/installation.md)
- [Configuration, review behavior and context](docs/en/configuration.md)
- [Native integration architecture](docs/en/architecture.md)
- [Development and upstream upgrades](docs/en/development.md)
- [Timeouts and troubleshooting](docs/en/troubleshooting.md)
- [Verification scope and known limits](docs/en/verification.md)
- [Contributing and reporting issues](docs/en/CONTRIBUTING.md)
- [Security policy](docs/en/SECURITY.md)

Normal builds pin Kimi **2.3.3** and MCP SDK **1.32.2**. `autokimi update` fetches current project source and validates a candidate; installation requires `--install`. `autokimi upgrade` may also upgrade the official `kimi`. `autokimi --version` shows the project and source identity. See [updates](docs/en/installation.md#updates).

Reviews call the selected provider, adding requests and potential costs. Incorrect denials and approvals remain possible; this is not an operating system sandbox. See the [verification scope](docs/en/verification.md).

Based on Moonshot AI's MIT-licensed source, with its copyright notices retained. See [LICENSE](LICENSE), [LICENSE.upstream](LICENSE.upstream) and [NOTICE](NOTICE).
