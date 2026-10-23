import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { pnpmEnvironment, projectRoot, run } from './common.mjs';
import { prepareSource } from './prepare.mjs';

const { values } = parseArgs({ options: { worktree: { type: 'string' } } });
const worktree = await prepareSource(values);
const { command, env } = pnpmEnvironment();
const home = join(projectRoot, '.artifacts', 'test-home');
await mkdir(home, { recursive: true });
const options = {
  cwd: worktree,
  env: {
    ...env,
    KIMI_CODE_WATCH: 'false',
    KIMI_DISABLE_TELEMETRY: '1',
    KIMI_CODE_EXPERIMENTAL_FLAG: '0',
    KIMI_CODE_HOME: home,
    KIMI_SHARE_DIR: join(home, 'legacy'),
  },
};
run(
  command,
  [
    'exec',
    'vitest',
    'run',
    'packages/agent-core-v2/test/agent/approvalReview',
    'packages/agent-core-v2/test/agent/toolApproval',
    'packages/agent-core-v2/test/agent/permissionGate',
    'packages/agent-core-v2/test/agent/permissionPolicy',
    'packages/agent-core-v2/test/agent/permissionRules',
    'packages/node-sdk/test/config.test.ts',
    'packages/node-sdk/test/session-prompt-events.test.ts',
    'apps/kimi-code/test/tui/commands/review.test.ts',
    'apps/kimi-code/test/tui/commands/resolve.test.ts',
    'apps/kimi-code/test/tui/commands/registry.test.ts',
    'apps/kimi-code/test/tui/components/chrome/footer-status-line.test.ts',
  ],
  options,
);
for (const packageName of [
  'packages/agent-core-v2',
  'packages/node-sdk',
  'apps/kimi-code',
])
  run(
    command,
    ['exec', 'tsc', '-p', packageName + '/tsconfig.json', '--noEmit'],
    options,
  );
run(process.execPath, ['scripts/check-no-comments.mjs'], options);
