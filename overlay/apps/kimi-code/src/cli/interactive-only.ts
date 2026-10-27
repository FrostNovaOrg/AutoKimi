import type { Command } from 'commander';

export const INTERACTIVE_ONLY_ERROR =
  'Use autokimi exec for reviewed headless tasks. Use native kimi for -p prompts, ACP and web servers.';

export function rejectHeadlessServer(): void {
  throw new Error(INTERACTIVE_ONLY_ERROR);
}

export function restrictToInteractiveTui(
  program: Command,
  terminal: {
    stdin: { isTTY?: boolean };
    stdout: { isTTY?: boolean };
  } = process,
): void {
  program.hook('preAction', (_root, action) => {
    let entry = action;
    while (entry.parent !== null && entry.parent !== program)
      entry = entry.parent;
    if (
      (action !== program &&
        ![
          'exec',
          'runs',
          'session',
          'export',
          'fork',
          'provider',
          'login',
          'doctor',
          'migrate',
          'upgrade',
          '__plugin_run_node',
          '__update_download',
        ].includes(entry.name())) ||
      (action === program &&
        (program.opts()['prompt'] !== undefined ||
          terminal.stdin.isTTY !== true ||
          terminal.stdout.isTTY !== true))
    )
      program.error(INTERACTIVE_ONLY_ERROR, { exitCode: 2 });
  });
}
