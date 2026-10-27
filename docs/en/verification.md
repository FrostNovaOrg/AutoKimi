# Verification scope and limits

[English](verification.md) | [简体中文](../verification.md)

## Method

`npm test` validates repository tools with temporary installation directories and synthetic configuration. `npm run check` checks source content and size. Runtime changes also require `npm run test:upstream`, covering review, permissions, SDK, TUI, targeted message flows, TypeScript and the no-comments guard. `npm run test:install` verifies a real runtime package in a synthetic home.

## Recorded results

AutoKimi 0.2.2 (Kimi 2.3.3): 74/74 repository tests, 793/793 related runtime tests across 35 files, and 12/12 message-flow cases passed, along with four TypeScript projects, frozen-dependency build, source checks and the no-comments guard. New cases cover complete approval details, confirmation defaulting to Cancel, Space/Kitty keys, submission acknowledgment and failure retry, and reviewer model selection. TUI lint had no errors and retained one existing upstream warning.

One-command installation was verified on macOS ARM64 in an isolated home: automatic download and verification of separate Node 24.15.0, actual runtime installation, and 6 headless-rejection checks passed. The source path used a local Git snapshot instead of a download, while running the real exact pnpm, frozen build and installation. Both preserved the simulated native `kimi` and configuration. Isolated installation and reinstall smoke tests passed. Regressions cover Release selection, checksum corruption, platform/version mismatch and paths with spaces. CI was skipped at the maintainer's request; Linux and x64 have not been tested on real systems.

After the Chinese/English documentation update, 76/76 repository tests passed, including new language coverage, navigation and link-anchor checks. Real runtime installation and reinstall smoke tests passed in an isolated home, with both documentation languages included in the package. Runtime source and patches were unchanged; upstream regressions were not rerun for this update.

Kimi 2.3.3 npm integrity, signatures and provenance were checked. The upstream MIT license is unchanged; MCP SDK is pinned to 1.32.2. Old unbound OAuth credentials are not reused. Historical validation is retained in Git. These results cover targeted regressions, not the entire upstream test suite.

## Limits

Models may incorrectly deny or allow actions. Review covers only operations passed to it by the permission system and is not an OS sandbox. Pagination, truncation, missing scripts and earlier authorization may lead to conservative denial. Two stages do not provide model independence.

A whole-package digest is not a signature. Full Linux TUI behavior, all provider/model combinations and real official upgrades remain untested. Upstream upgrades require porting and testing again. Raw evaluations remain local under `.artifacts/`.
