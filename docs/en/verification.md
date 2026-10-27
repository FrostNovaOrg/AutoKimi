# Verification scope and limits

[English](verification.md) | [简体中文](../verification.md)

## Method

`npm test` validates repository tools with temporary installation directories and synthetic configuration. `npm run check` checks source content and size. Runtime changes also require `npm run test:upstream`, covering review, permissions, SDK, TUI, targeted message flows, TypeScript and the no-comments guard. `npm run test:install` verifies a real runtime package in a synthetic home. `npm run test:headless` validates the installed headless protocol through a local mock model service, without paid model calls.

## Recorded results

AutoKimi 0.3.1 passed on macOS ARM64: 82/82 repository tests, 832/832 runtime tests across 40 files, 12/12 message-flow cases, four TypeScript projects, the no-comments guard, full pinned rebuild, isolated installation and headless smoke tests. The real package also passed with standalone Node 24.15.0 inside its isolated Kimi home. With an always-allow local mock reviewer, actual OS enforcement blocked configuration writes, split-name hardlinks, nested Node and unapproved networking; workspace writes, cancellation and context continuation still worked. Installation tests cover replacement of both archive and checksums, bootstrap replacement and static version queries. Evaluation regressions separate model results, timeouts and human confirmation. No paid model calls or new signed release artifacts were made; this result does not measure model attack success rates.

The complete AutoKimi 0.3.0 [Linux x64 CI run](https://github.com/FrostNovaOrg/AutoKimi/actions/runs/40463972815) passed on 2026-10-27 with pinned Node 24.15.0 and pnpm 10.33.0: 76/76 repository tests, 813/813 runtime tests, 12/12 message-flow cases, four type checks, the no-comments guard, full build, isolated installation and the new headless smoke test.

AutoKimi 0.3.0 (Kimi 2.3.3) passed on macOS ARM64: 76/76 repository tests, 813/813 runtime tests across 37 files, 12/12 targeted message-flow cases, four TypeScript projects, the no-comments guard and a full rebuild from the pinned baseline. Real-package isolated installation and reinstallation passed. Headless end-to-end checks cover reviewed file writes, read-only restrictions, denial reporting, idempotency, cursors, cumulative budgets and same-session continuation, cancellation and shell-child cleanup, blocked input, enforced review and crash recovery. These smoke tests do not establish real-provider compatibility or model decision quality.

AutoKimi 0.2.2 (Kimi 2.3.3): 74/74 repository tests, 793/793 related runtime tests across 35 files, and 12/12 message-flow cases passed, along with four TypeScript projects, frozen-dependency build, source checks and the no-comments guard. New cases cover complete approval details, confirmation defaulting to Cancel, Space/Kitty keys, submission acknowledgment and failure retry, and reviewer model selection. TUI lint had no errors and retained one existing upstream warning.

One-command installation was verified on macOS ARM64 in an isolated home: automatic download and verification of separate Node 24.15.0, actual runtime installation, and 6 headless-rejection checks passed. The source path used a local Git snapshot instead of a download, while running the real exact pnpm, frozen build and installation. Both preserved the simulated native `kimi` and configuration. Isolated installation and reinstall smoke tests passed. Regressions cover Release selection, checksum corruption, platform/version mismatch and paths with spaces.

After the Chinese/English documentation update, 76/76 repository tests passed, including new language coverage, navigation and link-anchor checks. Real runtime installation and reinstall smoke tests passed in an isolated home, with both documentation languages included in the package. Runtime source and patches were unchanged; upstream regressions were not rerun for that documentation update.

Kimi 2.3.3 npm integrity, signatures and provenance were checked. The upstream MIT license is unchanged; MCP SDK is pinned to 1.32.2. Old unbound OAuth credentials are not reused. Historical validation is retained in Git. These results cover targeted regressions, not the entire upstream test suite.

On 2026-10-27, the complete [Linux x64 GitHub Actions run](https://github.com/FrostNovaOrg/AutoKimi/actions/runs/40452938193) passed with Node 24.15.0 and pnpm 10.33.0: 76/76 repository tests, 793/793 targeted regressions, 12/12 message-flow cases, four TypeScript projects, the no-comments guard and isolated installation. Another 394 message-flow cases were outside the selected filter. Upstream build warnings were non-blocking; full interactive TUI behavior still needs manual testing.

## Limits

Models may incorrectly deny or allow actions. Review covers only operations passed to it by the permission system and is not an OS sandbox. Pagination, truncation, missing scripts and earlier authorization may lead to conservative denial. Two stages do not provide model independence.

A whole-package digest is not a signature. Full Linux TUI behavior, all provider/model combinations and real official upgrades remain untested. Upstream upgrades require porting and testing again. Raw evaluations remain local under `.artifacts/`.
