# Installation, updates and removal

[English](installation.md) | [简体中文](../installation.md)

## One-command installation

Run in a terminal:

```sh
curl -fsSL https://raw.githubusercontent.com/FrostNovaOrg/AutoKimi/TRUSTED_COMMIT/install.sh | sh -s -- --revision TRUSTED_COMMIT
```

The script supports macOS/Linux on ARM64 and x64; macOS ARM64 has been tested. Linux x64 has passed CI build, regression and isolated installation checks; terminal interaction still needs manual testing. It requires curl and tar, plus Git for source builds. By default it builds an explicitly trusted AutoKimi commit with Kimi pinned by the lock file. Only `--version` requests a matching runtime package, verified against GitHub provenance bound to that commit in addition to `SHA256SUMS`. Download or checksum failures stop installation. Source builds download the exact pnpm version, without requiring a global installation.

If Node.js ≥24.15.0 is unavailable, the script verifies an official Node package checksum and installs it under `<home>/autokimi/tools/`, leaving system Node unchanged. The home directory is selected from `AUTOKIMI_HOME`, `KIMI_CODE_HOME`, then `~/.kimi-code`; `--home` takes precedence. The script prints the launch path and required PATH command without editing shell configuration. Keep the selected Node path in place.

From a local checkout, these installation options are available:

```sh
sh install.sh --source
sh install.sh --version v0.3.1 --revision TRUSTED_COMMIT
sh install.sh --package /path/to/autokimi-v0.3.1-darwin-arm64.tar.gz --sha256 TRUSTED_SHA256 --home /path/to/kimi-home
sh install.sh --timeout-ms 90000
```

`--version` selects an AutoKimi Release tag. An explicitly selected version without a matching platform package fails; add `--source` to build that tag instead. `--package` requires a matching `SHA256SUMS` file in the same directory. `--source` forces a source build. Installation enables review and selects Always Ask. Omitting `--timeout-ms` preserves an existing timeout. First use still requires login or model configuration in an interactive session.

## Build and install

Complete official Kimi login or model configuration first. Use Node.js ≥24.15.0 and pnpm 10.33.0. You can install the required Node with your own version manager, or point `AUTOKIMI_PNPM` at the required pnpm executable.

```sh
npm run build
npm run install:local -- --timeout-ms 90000
```

`build` downloads the locked official tag, verifies its commit and version, applies patches and builds a separate JavaScript runtime. It does not modify or recompile an installed official native `kimi` executable. Dependency installation uses the frozen upstream lock file.

The installer uses `KIMI_CODE_HOME`, or `~/.kimi-code` when unset, creating:

```text
~/.kimi-code/bin/autokimi
~/.kimi-code/autokimi/releases/<release-id>/
~/.kimi-code/autokimi/installation.json
```

It checks the official `kimi` file's hash before and after installation and refuses to overwrite an unmanaged command named `autokimi`. An `install.lock` serializes installs into the same home. Configuration, launcher and receipt use backups and atomic writes, with rollback on later failures. If a crashed installer leaves a lock, confirm no installer is running before removing it. The launcher preserves the working directory and command arguments, pins the selected home, and disables official automatic updates for this separate runtime. It needs a working Node executable; reinstall if that Node is moved or removed.

The packaged SDK merges configuration to enable `experimental.approval_review` and set `default_permission_mode = "manual"`. Only an explicit `--timeout-ms` changes the review timeout. Other review settings, providers, models and login data retain their values. When `config.toml` is a symlink to a valid file, the new configuration is generated in a temporary home, then atomically written to the real target; both success and rollback preserve the symlink. **Configuration is shared with official Kimi, so its next launch also sees the changed default permission mode.**

90 seconds is the combined limit for both stages. An earlier result continues immediately; each review does not wait a fixed 90 seconds. Without the option, existing values are preserved; the source default is 30 seconds.

## Package and install separately

```sh
npm run package:runtime
node tools/install.mjs --package .artifacts/runtime --timeout-ms 90000
```

A runtime package includes the CLI, configuration SDK, prebuilt native resources, Web resources and production dependencies. Package content, file permissions and relative links determine its release identity. Installing a prepared package requires no rebuild or original development directory, but revalidates its complete content. Run the installation script from this repository. Packages are platform-specific; macOS optional native dependencies cannot simply be reused on Linux.

The `--prepare` destination must be a new directory. Generated source must pass locked-commit, input-fingerprint and source-state checks. Use a new path for another package, or remove an old package after confirming it is no longer needed.

## Maintainer Release packages

Build and test on the target system and architecture, commit the source, then run:

```sh
npm run package:release
```

This requires a clean source checkout. It produces `.artifacts/release/autokimi-v<version>-<platform>-<arch>.tar.gz` and `SHA256SUMS`, including runtime dependencies, licenses and standalone installation tools. Packages are tied to a platform and architecture; the installer rejects mismatches. Existing output filenames cause an error to prevent overwriting prepared artifacts.

Manually upload tested platform packages and a combined `SHA256SUMS` to the matching `v<version>` GitHub Release. The one-command installer can then prefer those packages. CI is not required for this step; source installation remains available without published packages.

## Isolated configuration and offline development

```sh
node tools/install.mjs --package .artifacts/runtime --home .artifacts/kimi-home
```

`--home` selects the configuration, launcher and runtime package location. This directory needs its own model settings; the installer does not copy real login data into it.

Reuse a local official Git checkout to avoid another source download:

```sh
npm run prepare:upstream -- --source /path/to/local/kimi-code
npm run build -- --offline --store-dir /path/to/pnpm-store
```

Uncommitted changes in the local source are not copied. Offline dependency installation requires a complete pnpm cache. If dependencies are already installed, use `npm run build -- --skip-install`. `--worktree` selects a different generated source directory; pass the same path to later build and test commands, and use `--source <generated-source-directory>` for packaging.

## Updates

After `git pull`, rebuild and reinstall. When overlay or patches change, the preparer refuses to reuse stale source to protect development edits. Preserve any needed edits in `.cache/kimi-code`, then move or remove that generated directory before rebuilding. The preparer never clears an existing directory automatically.

Updating official `kimi` does not change installed AutoKimi, which keeps its own baseline. Maintainers can explicitly validate an official release:

```sh
npm run follow:upstream -- --version 2.3.3
```

This verifies the release tag, npm integrity, signatures and provenance all identify the same commit, then applies patches, builds, tests and packages in an isolated directory. It neither changes root `upstream.lock.json` nor installs by default. Reports and `candidate.lock.json` are under `.artifacts/upstream-candidates/`. Follow the reported path with `npm run install:local -- --lock <path>` to switch installations, or explicitly pass `--install` to the follow command.

Installed `autokimi update` first fetches current `main` source from this project's fixed GitHub repository, then validates a Kimi candidate with those patches. It only validates by default; `autokimi update --install` installs. `--revision <full-commit-SHA>` pins the AutoKimi source; here, **`--version` selects the Kimi baseline**, unlike `install.sh --version`, which selects an AutoKimi Release. Source-check or download failures stop the process without falling back to old patches. Runtime packages include overlay, patches, build tools, tests and documentation in `build-kit/` for independent rebuilding. Update work is kept under `KIMI_CODE_HOME/autokimi/update-work`, outside the release. `project-update.json` records project source identity; `runtime/report.json` records candidate and installation state.

`autokimi --version` displays the AutoKimi version, source commit, modification state, source digest and Kimi version. Archives without a Git commit are identified as such. The package manifest and installation receipt retain the same identity.

`autokimi upgrade` also fetches current AutoKimi source. The command itself requests installation, so no extra `--install` is needed. It completes candidate evidence checks, build, tests and packaging first. If official Kimi is older, it runs official `kimi upgrade --yes`, rereads the actual version to confirm success, then installs AutoKimi. An equal or newer official version is not upgraded again or downgraded. Unchanged AutoKimi package content is not reinstalled unless official Kimi changed, in which case reinstall refreshes its hash in the receipt. `autokimi upgrade --help` displays help without version checks or upgrades.

Updates resolve the home in this order: `--home`, `AUTOKIMI_HOME`, `KIMI_CODE_HOME`, `~/.kimi-code`. Installation takes a lock and rereads the current version. On failure, inspect both project and runtime reports. `partial` means some changes took effect; `cleanupWarning` means cleanup or reporting failed after installation took effect. Old releases remain available. Updates never run in the background. See [troubleshooting](troubleshooting.md).

Older launchers cannot acquire this update mechanism themselves. Rebuild and reinstall after `git pull` once; subsequent `autokimi upgrade` calls can then fetch project fixes.

## Removal

Confirm `~/.kimi-code/bin/autokimi` contains the `# autokimi local launcher` marker before removing that script and `~/.kimi-code/autokimi/`. Substitute your custom `--home` if applicable. Preserve official `kimi`, login data and sessions.

Before removal, `/auto-review off` can disable the review setting in shared configuration; set your preferred default permission mode separately. Do not delete the whole `~/.kimi-code` directory.

## Installation trust chain (0.3.1)

The recommended command pins the installer’s full commit and passes the same commit to `--revision`. It downloads bootstrap from that commit, verifies an embedded SHA-256, then executes it. The four platform digests for standalone Node 24.15.0 are embedded too; same-origin dynamic checksums are no longer the trust root. Obtain the initial script and commit from a trusted source. Pinning does not establish that code is bug-free.

Default installation builds that exact AutoKimi commit, without following main or latest. In a trusted local Git checkout, `sh install.sh --source` uses current HEAD; build uncommitted development changes through the development workflow. A runtime requested with `--version` also needs the exact `--revision` used to build it. GitHub CLI verifies Sigstore provenance bound to the repository, `.github/workflows/release.yml`, source commit, signer-workflow commit and GitHub-hosted runner. Unsigned packages, mismatched provenance and verification failures are not extracted or executed. Without gh, use explicit `--source`.

Local archives may instead use `--sha256` from an independently trusted channel. SHA256SUMS downloaded beside an archive is not independent trust. It remains a transport-integrity check and cannot authorize execution by itself. The manual release workflow produces tested, attested Actions artifacts without creating a Release. This remediation does not publish new binary assets.

Linux Bash also needs `/usr/bin/bwrap`, `/usr/bin/socat`, `/usr/bin/rg` and available user namespaces/seccomp. Missing capabilities leave file tools usable but refuse shell startup. See [configuration](configuration.md#shell-os-sandbox-031) for policy and trusted external-container compatibility.
