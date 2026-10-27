# Security policy

[English](SECURITY.md) | [简体中文](../SECURITY.md)

AutoKimi is a model-based permission review layer, not a system sandbox. By default it reviews pending requests from the original permission system. Existing allow rules and modes that disable review affect coverage. Models can make mistakes; users manage permission policy, review budgets and configuration. See [architecture](architecture.md) and [verification limits](verification.md).

## Supported scope

Security fixes target current `main` and its pinned Kimi baseline. Older runtime packages are not guaranteed maintenance. Use `autokimi --version` to identify source and read [updates](installation.md#updates). Two-stage review does not provide the security guarantee of two independent models.

## Reporting vulnerabilities

If the repository's Security page offers private vulnerability reporting, use it. Otherwise, open a [GitHub Issue](https://github.com/FrostNovaOrg/AutoKimi/issues) requesting contact without vulnerability details. The maintainer can then provide a non-public channel. Do not publish keys, directly exploitable details or real sessions.

Include the affected commit, OS/architecture, review settings, synthetic reproduction and impact. Distinguish review-service failures, model mistakes and permission-boundary bypasses. Do not test destructive effects with real accounts or important files.

Revoke or rotate exposed credentials immediately. Removing the current file cannot retract history, caches or downloaded copies. Never commit `config.toml`, OAuth data, installation receipts, sessions, raw evaluations or model request logs. Repository and history scans are supporting checks, not proof that all sensitive information is absent.
