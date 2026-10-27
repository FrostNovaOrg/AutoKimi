import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  pnpmEnvironment,
  projectRoot,
  readUpstreamLock,
  run,
} from './common.mjs';
import { prepareSource } from './prepare.mjs';

const { values } = parseArgs({
  options: { worktree: { type: 'string' }, lock: { type: 'string' } },
});
const lock = await readUpstreamLock(projectRoot, values.lock);
const worktree = await prepareSource({ ...values, lock });
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
    'packages/agent-core-v2/test/agent/questionTools/tools/ask-user.test.ts',
    'packages/agent-core-v2/test/agent/toolApproval',
    'packages/agent-core-v2/test/agent/permissionGate',
    'packages/agent-core-v2/test/agent/permissionPolicy',
    'packages/agent-core-v2/test/agent/permissionRules',
    'packages/agent-core-v2/test/features/swarm/swarm.test.ts',
    'packages/agent-core-v2/test/mcpCore/oauth',
    'packages/oauth/test/oauth-token-transaction.test.ts',
    'packages/node-sdk/test/config.test.ts',
    'packages/node-sdk/test/review-config.test.ts',
    'packages/node-sdk/test/session-prompt-events.test.ts',
    'apps/kimi-code/test/tui/commands/review.test.ts',
    'apps/kimi-code/test/tui/components/dialogs/review-approval.test.ts',
    'apps/kimi-code/test/cli/interactive-only.test.ts',
    'apps/kimi-code/test/tui/commands/resolve.test.ts',
    'apps/kimi-code/test/tui/commands/registry.test.ts',
    'apps/kimi-code/test/tui/components/chrome/footer-status-line.test.ts',
    'apps/kimi-code/test/tui/commands/model-switch-confirm.test.ts',
    'apps/kimi-code/test/tui/commands/swarm.test.ts',
    'apps/kimi-code/test/tui/components/dialogs/effort-selector.test.ts',
    'apps/kimi-code/test/tui/components/dialogs/model-selector.test.ts',
    'apps/kimi-code/test/tui/components/dialogs/model-switch-confirm-dialog.test.ts',
    'apps/kimi-code/test/tui/components/messages/agent-swarm-progress.test.ts',
    'apps/kimi-code/test/tui/controllers/auth-flow.test.ts',
    'apps/kimi-code/test/tui/controllers/subagent-event-handler.test.ts',
    'apps/kimi-code/test/utils/effort-switch-config.test.ts',
    'apps/kimi-code/test/utils/model-switch-confirm-config.test.ts',
    'apps/kimi-code/test/tui/printable-key-guard.test.ts',
    'apps/kimi-code/test/tui/chalk-named-color-guard.test.ts',
  ],
  options,
);
run(
  command,
  [
    'exec',
    'vitest',
    'run',
    'apps/kimi-code/test/tui/kimi-tui-message-flow.test.ts',
    '-t',
    'approval review|review denial|structured review|AgentSwarm call that is rejected|swarm panel when AgentSwarm is rejected|swarm whose subagents start|Highspeed switch in a new session|old-session confirmation with hint',
  ],
  options,
);
for (const packageName of [
  'packages/agent-core-v2',
  'packages/node-sdk',
  'apps/kimi-code',
  'scripts',
])
  run(
    command,
    ['exec', 'tsc', '-p', packageName + '/tsconfig.json', '--noEmit'],
    options,
  );
run(process.execPath, ['scripts/check-no-comments.mjs'], options);
