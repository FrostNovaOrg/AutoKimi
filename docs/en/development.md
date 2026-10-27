# Development and upstream maintenance

[English](development.md) | [简体中文](../development.md)

Follow the maintenance rules in [AGENTS.md](../../AGENTS.md).

## Routine validation

```sh
npm test
npm run check
npm run check:history
npm run build
npm run test:upstream
npm run test:install
```

The first two commands require only Node and Git. Isolated tests cover source restoration, cache protection, packages, launchers, configuration merging and repository guards. `check` includes unignored new files, rejecting dependencies, generated output, common credential formats, machine-specific home paths and broken relative documentation links. It also enforces a source-size budget.

`build` prepares source, installs frozen dependencies and builds internal packages and the CLI. `test:upstream` runs relevant review, CLI, MCP OAuth and upstream model-setting tests plus targeted message-flow cases against generated source. It checks TypeScript for engine, SDK and TUI and enforces comment-free engine code. Tests use isolated configuration without real model calls. `test:install` uses an actual built runtime and synthetic settings to verify installation, setting preservation, startup and reinstall. The lock file determines pnpm; `AUTOKIMI_PNPM` can select an executable. Set test `TMPDIR` to a system temporary directory outside the Git worktree. Inside the repository, some writes may match worktree permission rules and bypass pending review, so passing tests would not prove the reviewer ran.

The repository defines lightweight push/PR CI checks and patch-application validation, with optional full build and native integration tests on manual dispatch. Current validation results come from local runs; GitHub Actions has not been validated. CI does not read Kimi login data or publish runtime packages.

## Editing source

Maintain new upstream files in `overlay/` and changes to existing official files in `patches/`. Never commit the complete official source from `.cache`.

1. Run `npm run prepare:upstream` to restore working source.
2. Develop in `.cache/kimi-code`, following its official maintenance rules; run focused tests after building.
3. Copy new files back to `overlay`. Export clean diffs for existing baseline files into the corresponding patches, excluding build output, user data and raw evaluation results.
4. Preserve development edits, then use a fresh `--worktree` to verify all patches apply from scratch. Changed inputs do not authorize the preparer to overwrite old cache directories.
5. Complete the checks and isolated installation validation, then review staged files and size.

After updating overlay and patches, validate with:

```sh
node tools/build.mjs --worktree .cache/validation
node tools/test-upstream.mjs --worktree .cache/validation
node tools/install.mjs --source .cache/validation --prepare .artifacts/validation-runtime
node tools/install.mjs --package .artifacts/validation-runtime --home .artifacts/validation-home
```

Export each patch's complete set of existing files and retain unchanged portions of that patch. Do not overwrite a single patch with the entire generated checkout's diff: this can mix other patches or lose existing changes. Check for accidental edits to upstream-tracked files. Ordinary `git diff` excludes new files, which must be copied to overlay. Run `git diff --check` and repository checks before committing; pattern scans cannot replace human review.

## Upgrading upstream

Updating official `kimi` does not update AutoKimi. Maintainers explicitly select a new baseline:

1. Verify the official tag and full commit, then update `upstream.lock.json`.
2. In a new work directory, port permission entry points, service registration, SDK configuration and TUI interfaces. Resolve patch conflicts explicitly.
3. Check for changes to original permission rules, explicit denials, task confirmations and tool execution order.
4. Run the full build, related regressions, type checks and isolated install. Verify the official command hash remains unchanged.
5. Use isolated test files in the native TUI to verify allow, deny, invalid-response and timeout paths. Real model tests require an authorized account, with costs and test limits stated.
6. Update verification records and compatibility claims before releasing a usable version.

### Optional candidate following

See [updates](installation.md#updates) for candidate updates, source fetching, receipts and failure states.

The source budget is 672 KiB, covering frozen-dependency patches, TUI confirmation, installation regressions and Chinese/English documentation. Caches, dependencies and runtime packages still stay out of Git.

## Repository release audit

Run `npm run check:history` in a complete Git checkout to scan commits and historical files across all reachable branches and tags for common sensitive formats. Shallow clones are rejected. Add `-- --pattern MODEL_IDENTIFIER` for a case-insensitive identifier search; `--all-objects` includes local unreachable objects. Output identifies objects, paths and rules without file bodies. History checks do not establish that remote caches or other copies have been cleaned.

Before release, verify remote refs with a fresh mirror clone and review GitHub description, Topics, Issues/PRs and attachments. Runtime packages, user configuration, credentials, sessions and raw evaluations must stay out of Git. Revoke exposed credentials first, then assess history cleanup; deleting the current file is insufficient.

The npm `private: true` flag prevents accidental npm publication and does not affect GitHub visibility. See [maintainer Release packages](installation.md#maintainer-release-packages). State untested platforms accurately. Verify actual CI runs separately; local results cannot substitute for them.
