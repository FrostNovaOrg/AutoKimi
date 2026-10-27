# Contributing and reporting issues

[English](CONTRIBUTING.md) | [简体中文](../CONTRIBUTING.md)

Bug reports, documentation improvements and fixes are welcome. Read the [maintenance rules](../../AGENTS.md) and [development workflow](development.md) first. Follow the [security policy](SECURITY.md) for vulnerabilities.

## Reporting issues

Use [GitHub Issues](https://github.com/FrostNovaOrg/AutoKimi/issues) with your OS, CPU architecture, terminal, Node version, `autokimi --version`, sanitized configuration and minimal reproduction steps. State whether installation came from source or a Release package. Exclude API keys, OAuth data, full sessions, raw audit files and real task content.

For review mistakes, provide public synthetic requests, tool arguments and the expected authorization scope, plus provider, model and review settings. Model output contains untrusted content; one passing example cannot establish general safety. Do not run destructive reproductions against real data.

## Submitting changes

- Put new upstream files in `overlay/` and changes to existing upstream files in `patches/`. Do not commit complete upstream checkouts or generated packages.
- Pin the exact upstream version, preserve TUI integration through the SDK, and keep official `kimi` independent.
- Preserve actual permission boundaries. Runtime fixes need tests covering the affected behavior; include validation commands and scope in the change description.
- Run `npm test`, `npm run check` and `npm run check:history` before committing. Runtime changes also require build, related upstream tests, isolated installation and `npm run test:headless`.
- Follow upstream `write-tui` rules for TUI changes, checking narrow terminals, complete arguments, Kitty keys and cancellation.

Contributions use the MIT license. Retain third-party copyright and license notices. Version changes must also check locks, documentation and platform validation claims.

## Documentation languages

The default [README](../../README.md) is English; the [Simplified Chinese entry](../../README.zh-CN.md) provides complete Chinese instructions. Chinese technical documents live in `docs/`, with English counterparts in `docs/en/`. Update both languages when changing features, commands or limits, retaining language-switch links. Keep CLI commands, configuration keys and actual UI button labels unchanged. `npm test` checks language coverage, documentation navigation and relative-link anchors.
