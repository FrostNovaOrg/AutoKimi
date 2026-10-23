# AutoKimi maintenance rules

- Reply in the user's language. Keep this repository small and reproducible.
- `overlay/` contains new upstream source files; `patches/` contains changes to existing upstream files. Do not duplicate the same change in both.
- Pin upstream by the exact commit in `upstream.lock.json`. Do not silently follow the latest Kimi release.
- Keep dependencies, upstream checkouts, runtime packages, credentials, sessions and raw evaluation output out of Git.
- Preserve the official `kimi` command. Never modify an installed runtime or user configuration merely to reorganize this repository.
- Preserve the upstream SDK boundary for TUI code. Engine TypeScript remains comment-free, except existing lint directives.
- Use Node's built-in modules for repository tools. Do not add dependencies without a concrete need.
- Run `npm test` and `npm run check`; run `npm run test:upstream` after changing runtime behavior or integration patches.
- Do not commit scratch notes, generated output or agent/co-author attribution.
