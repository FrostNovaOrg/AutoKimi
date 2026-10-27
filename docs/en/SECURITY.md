# Security policy

[English](SECURITY.md) | [简体中文](../SECURITY.md)

AutoKimi combines model permission review with a Bash OS sandbox enabled by default. Their coverage differs. The TUI reviews pending requests from the original permission system. Existing allow rules and modes that disable review affect coverage. Models can make mistakes; users manage permission policy, review budgets and configuration. See [architecture](architecture.md) and [verification limits](verification.md).

## Supported scope

Security fixes target current `main` and its pinned Kimi baseline. Older runtime packages are not guaranteed maintenance. Use `autokimi --version` to identify source and read [updates](installation.md#updates). Two-stage review does not provide the security guarantee of two independent models.

## Reporting vulnerabilities

If the repository's Security page offers private vulnerability reporting, use it. Otherwise, open a [GitHub Issue](https://github.com/FrostNovaOrg/AutoKimi/issues) requesting contact without vulnerability details. The maintainer can then provide a non-public channel. Do not publish keys, directly exploitable details or real sessions.

Include the affected commit, OS/architecture, review settings, synthetic reproduction and impact. Distinguish review-service failures, model mistakes and permission-boundary bypasses. Do not test destructive effects with real accounts or important files.

Revoke or rotate exposed credentials immediately. Removing the current file cannot retract history, caches or downloaded copies. Never commit `config.toml`, OAuth data, installation receipts, sessions, raw evaluations or model request logs. Repository and history scans are supporting checks, not proof that all sensitive information is absent.

Headless `exec` requires review, scopes file tools and requires the Bash OS sandbox. Shell networking starts closed and needs both configured domains and caller authorization. File tools and MCP run outside that shell sandbox. Callers should still provide whole-process or multi-tenant isolation. Run storage may contain prompts and results; treat it as sensitive data. The protocol is for trusted local callers. See [headless boundaries](headless.md).

## Red-team remediation (0.3.1)

| Finding              | Enforcement                                                                                                                                                                                                            |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-01 Hardlinks       | File-tool sinks reject multi-link inodes. Full writes use temporary files and atomic replacement; appends use fstat-verified descriptors. Review evidence includes resolved paths and file identity.                   |
| F-02 Version queries | The launcher prints static installation identity without executing updater, SDK or runtime entry. Legacy non-static receipts cannot use the version-check exception.                                                   |
| F-03 Shell expansion | The OS sandbox constrains actual effects independently of command spelling. Missing backends refuse execution. Known protected symlink targets and hardlinks are checked.                                              |
| F-04 Audit aliases   | Appends require an opened single-link regular file, with nonblocking rejection of FIFOs and similar objects. Headless journals use equivalent checks.                                                                  |
| F-05 Installation    | The script, bootstrap digest, source commit and Node archive digests are pinned. Before extraction, runtime archives require an independently trusted digest or GitHub provenance bound to source and signer workflow. |

Full writes replace the inode and preserve ordinary file mode, without promising ACL or extended-attribute preservation. A trusted user must remove hardlink aliases first. The OS sandbox does not provide universal hardlink isolation: other preexisting aliases, malicious concurrent local processes and non-shell tools have separate boundaries. Model sample success rates do not establish execution safety; verification records distinguish mock services, real models and untested scenarios.
