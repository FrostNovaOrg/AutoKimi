import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const exec = promisify(execFile);
const base = await mkdtemp(join(tmpdir(), 'kimi-headless-smoke-'));
const home = join(base, 'home');
const cwd = join(base, 'workspace');
await mkdir(home);
await mkdir(cwd);
await exec('git', ['init', '-q', cwd]);
await writeFile(join(cwd, 'input.txt'), 'Synthetic input\n');
const cliOption = process.argv.indexOf('--cli');
const nativeOption = process.argv.indexOf('--native');
let shellNode = process.execPath;
let command =
  nativeOption < 0 ? shellNode : resolve(process.argv[nativeOption + 1]);
let prefix =
  nativeOption < 0
    ? [
        resolve(
          cliOption < 0
            ? 'apps/kimi-code/dist/main.mjs'
            : process.argv[cliOption + 1],
        ),
      ]
    : [];
let reviews = 0;
let requests = 0;
let hold = true;
let networkAttempts = 0;
let shellToolResults;
const probeToolResults = new Map();
const fileToolResults = new Map();
const protectedPaths = [
  'AGENTS.md',
  'CLAUDE.md',
  'KIMI.md',
  '.agents/skills/fixture/SKILL.md',
  '.kimi-code/config.toml',
];
const printWorkspace = join(base, 'print-workspace');
const retargetAlias = join(printWorkspace, 'retarget.txt');
let retargeted = false;
const activeRuns = new Set();
const goalRequests = new Map();
const completedGoals = new Set();
let completeBudgetGoal = false;
const shellQuote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";

const server = createServer((request, response) => {
  void (async () => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    if (request.method === 'GET') {
      networkAttempts++;
      response.end('synthetic network probe');
      return;
    }
    const body = JSON.parse(raw);
    requests++;
    const reviewer = JSON.stringify(body.messages?.[0]).includes(
      'independent permission reviewer',
    );
    if (reviewer) reviews++;
    const transcript = JSON.stringify(body.messages);
    const completedTools =
      body.messages?.filter((message) => message.role === 'tool').length ?? 0;
    const fileCase = transcript.match(
      /CASE_FILE_(?:PROTECTED_\d+_(?:WRITE|EDIT)|CONTENT|RETARGET)/,
    )?.[0];
    if (fileCase && completedTools > 0)
      fileToolResults.set(
        fileCase,
        body.messages.filter((message) => message.role === 'tool'),
      );
    if (reviewer && fileCase === 'CASE_FILE_RETARGET' && !retargeted) {
      retargeted = true;
      await unlink(retargetAlias);
      await symlink(join(base, 'AGENTS.md'), retargetAlias);
    }
    if (transcript.includes('CASE_SHELL') && completedTools > 0)
      shellToolResults = body.messages.filter(
        (message) => message.role === 'tool',
      );
    const probeName = transcript.match(
      /CASE_SANDBOX_(HOME|LINK|CHILD|NET)/,
    )?.[1];
    if (probeName && completedTools > 0)
      probeToolResults.set(
        probeName,
        body.messages.filter((message) => message.role === 'tool'),
      );
    const chunk = (delta, finishReason = null) =>
      response.write(
        'data: ' +
          JSON.stringify({
            id: 'fixture-response',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'fixture',
            choices: [{ index: 0, delta, finish_reason: finishReason }],
          }) +
          '\n\n',
      );
    const send = () => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      let finish = 'stop';
      if (reviewer) {
        const denied = transcript.includes('CASE_DENY');
        chunk({
          content: JSON.stringify({
            decision: denied ? 'deny' : 'allow',
            risk: denied ? 'high' : 'low',
            authorization: denied ? 'low' : 'high',
            reason: denied
              ? 'Synthetic permission denial'
              : 'Synthetic authorized action',
          }),
        });
      } else {
        let tool;
        const goalCase = transcript.match(
          /CASE_GOAL_(PRINT|COMPLETE|BUDGET|BLOCKED)/,
        )?.[0];
        if (goalCase) {
          const count = (goalRequests.get(goalCase) ?? 0) + 1;
          goalRequests.set(goalCase, count);
          if (count === 1)
            tool = {
              name: 'CreateGoal',
              args: {
                objective: goalCase + ' finish the requested fixture',
                completionCriterion: 'The synthetic fixture is complete',
              },
            };
          else if (
            count >= 3 &&
            (goalCase !== 'CASE_GOAL_BUDGET' || completeBudgetGoal) &&
            !completedGoals.has(goalCase)
          ) {
            completedGoals.add(goalCase);
            tool = {
              name: 'UpdateGoal',
              args: {
                status:
                  goalCase === 'CASE_GOAL_BLOCKED' ? 'blocked' : 'complete',
              },
            };
          }
        } else if (fileCase && completedTools === 0) {
          const protectedCase = fileCase.match(/PROTECTED_(\d+)_(WRITE|EDIT)/);
          const path = protectedCase
            ? protectedPaths[Number(protectedCase[1])]
            : fileCase === 'CASE_FILE_RETARGET'
              ? 'retarget.txt'
              : 'notes.txt';
          tool =
            protectedCase?.[2] === 'EDIT'
              ? {
                  name: 'Edit',
                  args: { path, old_string: 'preserve', new_string: 'changed' },
                }
              : {
                  name: 'Write',
                  args: {
                    path,
                    content:
                      fileCase === 'CASE_FILE_CONTENT'
                        ? '请参考 AGENTS.md、CLAUDE.md、KIMI.md、.agents/skills 和 .kimi-code/config.toml'
                        : 'changed',
                  },
                };
        } else if (transcript.includes('CASE_BUDGET') && completedTools < 2)
          tool = { name: 'Read', args: { path: 'input.txt' } };
        else if (transcript.includes('CASE_QUESTION') && completedTools === 0)
          tool = {
            name: 'AskUserQuestion',
            args: {
              questions: [
                {
                  question: 'Choose a synthetic option?',
                  header: 'Choice',
                  options: [
                    { label: 'A', description: 'First' },
                    { label: 'B', description: 'Second' },
                  ],
                  multi_select: false,
                },
              ],
            },
          };
        else if (
          transcript.includes('CASE_SANDBOX_HOME') &&
          completedTools === 0
        )
          tool = {
            name: 'Bash',
            args: {
              command: 'printf changed >> "$KIMI_CODE_HOME/config.toml"',
            },
          };
        else if (
          transcript.includes('CASE_SANDBOX_LINK') &&
          completedTools === 0
        )
          tool = {
            name: 'Bash',
            args: {
              command:
                'a=AGENTS; ln "./$a.md" ./linked-notes.md && printf changed > ./linked-notes.md',
            },
          };
        else if (
          transcript.includes('CASE_SANDBOX_CHILD') &&
          completedTools === 0
        )
          tool = {
            name: 'Bash',
            args: {
              command:
                shellQuote(shellNode) +
                ' -e ' +
                shellQuote(
                  'require("node:fs").writeFileSync(process.env.KIMI_CODE_HOME+"/config.toml","changed")',
                ),
            },
          };
        else if (
          transcript.includes('CASE_SANDBOX_NET') &&
          completedTools === 0
        )
          tool = {
            name: 'Bash',
            args: {
              command:
                shellQuote(shellNode) +
                ' -e ' +
                shellQuote(
                  'fetch("http://127.0.0.1:' +
                    server.address().port +
                    '/probe").then(()=>require("node:fs").writeFileSync("network-marker","unexpected")).catch(()=>process.exit(1))',
                ),
            },
          };
        else if (transcript.includes('CASE_SHELL') && completedTools === 0)
          tool = {
            name: 'Bash',
            args: {
              command:
                shellQuote(join(dirname(shellNode), 'npm')) +
                ' --userconfig=./.fixture-npmrc --globalconfig=./.fixture-global-npmrc --cache=./.fixture-npm-cache --version >/dev/null && ' +
                shellQuote(shellNode) +
                ' -e ' +
                shellQuote(
                  'require("node:fs").writeFileSync("child.pid",String(process.pid));setInterval(()=>require("node:fs").writeFileSync("child.heartbeat",String(Date.now())),50)',
                ),
              timeout: 60,
            },
          };
        else if (
          (transcript.includes('CASE_WRITE') ||
            transcript.includes('CASE_DENY')) &&
          completedTools === 0
        )
          tool = {
            name: 'Write',
            args: {
              path: transcript.includes('CASE_DENY')
                ? 'denied.txt'
                : 'result.txt',
              content: 'fixture done',
            },
          };
        if (tool) {
          chunk({
            tool_calls: [
              {
                index: 0,
                id: 'fixture-' + completedTools,
                type: 'function',
                function: {
                  name: tool.name,
                  arguments: JSON.stringify(tool.args),
                },
              },
            ],
          });
          finish = 'tool_calls';
        } else chunk({ content: 'fixture done' });
      }
      chunk({}, finish);
      response.write(
        'data: ' +
          JSON.stringify({
            id: 'fixture-response',
            choices: [],
            usage: {
              prompt_tokens: 11,
              completion_tokens: 7,
              total_tokens: 18,
            },
          }) +
          '\n\n',
      );
      response.end('data: [DONE]\n\n');
    };
    if (!reviewer && transcript.includes('CASE_HOLD') && hold) {
      const timer = setTimeout(send, 10000);
      response.once('close', () => clearTimeout(timer));
    } else send();
  })().catch((error) => {
    response.statusCode = 500;
    response.end(
      error instanceof Error ? error.message : 'Synthetic fixture failure',
    );
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
await writeFile(
  join(home, 'config.toml'),
  `default_model = "fixture"
default_permission_mode = "manual"
[experimental]
approval_review = true
[providers.fixture]
type = "openai"
base_url = "http://127.0.0.1:${port}/v1"
api_key = "fixture-placeholder"
[models.fixture]
provider = "fixture"
model = "fixture"
max_context_size = 32768
[permission.review]
two_stage = false
timeout_ms = 5000
`,
);
const env = {
  ...process.env,
  KIMI_CODE_HOME: home,
  KIMI_CODE_CACHE_DIR: join(base, 'native-cache'),
  KIMI_SHARE_DIR: join(home, 'legacy'),
  KIMI_DISABLE_TELEMETRY: '1',
  KIMI_CODE_WATCH: 'false',
};
async function call(args, changes = {}) {
  try {
    const value = await exec(command, [...prefix, ...args], {
      env: { ...env, ...changes },
      timeout: 30000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return {
      code: 0,
      events: value.stdout.trim().split('\n').filter(Boolean).map(JSON.parse),
    };
  } catch (error) {
    if (typeof error.code !== 'number') throw error;
    return {
      code: error.code,
      events: String(error.stdout)
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(JSON.parse),
    };
  }
}
async function status(id) {
  const value = await call(['runs', 'status', id]);
  assert.equal(value.code, 0, JSON.stringify(value));
  return value.events[0].state;
}
async function wait(
  id,
  predicate = (state) =>
    !['queued', 'running', 'stopping'].includes(state.status),
) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const value = await status(id);
    if (predicate(value)) return value;
    await delay(50);
  }
  assert.fail(
    'Run did not reach the expected state: ' + JSON.stringify(await status(id)),
  );
}
async function detach(prompt, key, args = []) {
  const value = await call([
    'exec',
    '--prompt',
    prompt,
    '--cwd',
    cwd,
    '--timeout',
    '15s',
    '--idempotency-key',
    key,
    '--detach',
    ...args,
  ]);
  assert.equal(value.code, 0, JSON.stringify(value));
  const accepted = value.events[0];
  activeRuns.add(accepted.run_id);
  return accepted;
}
try {
  const schema = (await call(['runs', 'schema'])).events[0];
  assert.equal(schema.version, 1);
  assert.equal(schema.permissions.mode, 'review');
  const printCwd = printWorkspace;
  await mkdir(printCwd);
  const printReviews = reviews;
  const printed = await exec(
    command,
    [
      ...prefix,
      '--permission-mode',
      'review',
      '-p',
      'CASE_WRITE',
      '--output-format',
      'stream-json',
    ],
    {
      cwd: printCwd,
      env,
      timeout: 30000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  assert.ok(
    printed.stdout
      .trim()
      .split('\n')
      .every((line) => JSON.parse(line)),
  );
  assert.ok(reviews > printReviews);
  assert.equal(
    await readFile(join(printCwd, 'result.txt'), 'utf8'),
    'fixture done',
  );
  await rm(join(printCwd, 'result.txt'));
  const contentReviews = reviews;
  await exec(
    command,
    [...prefix, '--permission-mode', 'review', '-p', 'CASE_FILE_CONTENT'],
    { cwd: printCwd, env, timeout: 30000 },
  );
  assert.ok(reviews > contentReviews);
  assert.match(
    await readFile(join(printCwd, 'notes.txt'), 'utf8'),
    /请参考 AGENTS.md/,
  );
  await writeFile(join(base, 'AGENTS.md'), 'preserve');
  await symlink(join(printCwd, 'notes.txt'), retargetAlias);
  await exec(
    command,
    [...prefix, '--permission-mode', 'review', '-p', 'CASE_FILE_RETARGET'],
    { cwd: printCwd, env, timeout: 30000 },
  );
  assert.equal(retargeted, true);
  assert.equal(await readFile(join(base, 'AGENTS.md'), 'utf8'), 'preserve');
  assert.match(
    await readFile(join(printCwd, 'notes.txt'), 'utf8'),
    /请参考 AGENTS.md/,
  );
  assert.match(
    JSON.stringify(fileToolResults.get('CASE_FILE_RETARGET')),
    /changed/,
  );
  await exec('git', ['init', '-q', printCwd]);
  for (const path of protectedPaths) {
    await mkdir(dirname(join(printCwd, path)), { recursive: true });
    await writeFile(join(printCwd, path), 'preserve');
  }
  const protectedReviews = reviews;
  for (let index = 0; index < protectedPaths.length; index++) {
    for (const tool of ['WRITE', 'EDIT']) {
      const prompt = 'CASE_FILE_PROTECTED_' + index + '_' + tool;
      await exec(
        command,
        [...prefix, '--permission-mode', 'review', '-p', prompt],
        { cwd: printCwd, env, timeout: 30000 },
      );
      assert.match(JSON.stringify(fileToolResults.get(prompt)), /protected/);
      assert.equal(
        await readFile(join(printCwd, protectedPaths[index]), 'utf8'),
        'preserve',
      );
    }
  }
  assert.equal(reviews, protectedReviews);
  const printGoal = await exec(
    command,
    [...prefix, '--permission-mode', 'review', '-p', 'CASE_GOAL_PRINT'],
    {
      cwd: printCwd,
      env,
      timeout: 30000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  assert.match(printGoal.stdout, /fixture done/);
  assert.ok(completedGoals.has('CASE_GOAL_PRINT'));
  assert.ok(goalRequests.get('CASE_GOAL_PRINT') >= 4);
  const defaultReviews = reviews;
  await exec(command, [...prefix, '-p', 'CASE_FINAL'], {
    cwd,
    env,
    timeout: 30000,
  });
  assert.equal(reviews, defaultReviews);
  const disabledRequests = requests;
  await assert.rejects(
    exec(
      command,
      [...prefix, '--permission-mode', 'review', '-p', 'CASE_FINAL'],
      {
        cwd,
        env: { ...env, KIMI_CODE_EXPERIMENTAL_APPROVAL_REVIEW: '0' },
        timeout: 30000,
      },
    ),
  );
  assert.equal(requests, disabledRequests);
  const before = requests;
  const first = await detach('CASE_FINAL', 'dedupe');
  const duplicate = await detach('CASE_FINAL', 'dedupe');
  assert.equal(duplicate.run_id, first.run_id);
  assert.equal(duplicate.deduplicated, true);
  assert.equal((await wait(first.run_id)).status, 'completed');
  assert.equal(requests - before, 1);
  const conflict = await call([
    'exec',
    '--prompt',
    'different',
    '--cwd',
    cwd,
    '--timeout',
    '15s',
    '--idempotency-key',
    'dedupe',
    '--detach',
  ]);
  assert.equal(conflict.events[0].error.code, 'idempotency_conflict');

  const goalRun = await call([
    'exec',
    '--prompt',
    'CASE_GOAL_COMPLETE',
    '--cwd',
    cwd,
    '--read-only',
    '--timeout',
    '15s',
  ]);
  assert.equal(goalRun.code, 0, JSON.stringify(goalRun));
  assert.ok(
    goalRun.events.filter((event) => event.type === 'turn.ended').length >= 2,
  );
  const goalState = await status(goalRun.events[0].run_id);
  assert.equal(goalState.goal.status, 'complete');
  assert.equal(goalState.usage.denials, 0);
  assert.ok(goalState.usage.steps >= 4);

  const blockedGoal = await call([
    'exec',
    '--prompt',
    'CASE_GOAL_BLOCKED',
    '--cwd',
    cwd,
    '--timeout',
    '15s',
  ]);
  assert.equal(blockedGoal.code, 4, JSON.stringify(blockedGoal));
  const blockedGoalState = await status(blockedGoal.events[0].run_id);
  assert.equal(blockedGoalState.goal.status, 'blocked');
  assert.equal(blockedGoalState.reason, 'goal_blocked');
  assert.equal(blockedGoalState.resumable, true);

  const limitedGoal = await call([
    'exec',
    '--prompt',
    'CASE_GOAL_BUDGET',
    '--cwd',
    cwd,
    '--max-steps',
    '2',
    '--timeout',
    '15s',
  ]);
  assert.equal(limitedGoal.code, 5, JSON.stringify(limitedGoal));
  const limitedGoalId = limitedGoal.events[0].run_id;
  const limitedGoalState = await status(limitedGoalId);
  assert.equal(limitedGoalState.usage.steps, 2);
  assert.equal(limitedGoalState.reason, 'step_budget');
  assert.equal(limitedGoalState.resumable, true);
  const exhaustedGoal = await call(['exec', '--resume', limitedGoalId]);
  assert.equal(exhaustedGoal.code, 2);
  assert.equal(exhaustedGoal.events[0].error.code, 'budget_exhausted');
  completeBudgetGoal = true;
  const continuedGoal = await call([
    'exec',
    '--resume',
    limitedGoalId,
    '--max-steps',
    '6',
  ]);
  assert.equal(continuedGoal.code, 0, JSON.stringify(continuedGoal));
  const continuedGoalState = await status(limitedGoalId);
  assert.equal(continuedGoalState.goal.status, 'complete');
  assert.equal(continuedGoalState.attempt, 2);
  assert.ok(continuedGoalState.usage.steps > limitedGoalState.usage.steps);

  const written = await call([
    'exec',
    '--prompt',
    'CASE_WRITE',
    '--cwd',
    cwd,
    '--timeout',
    '15s',
  ]);
  assert.equal(
    written.events.find((event) => event.type === 'session.ready').data
      .permission,
    'review',
  );
  assert.equal(written.code, 0, JSON.stringify(written));
  assert.ok(reviews > 0);
  assert.equal(await readFile(join(cwd, 'result.txt'), 'utf8'), 'fixture done');
  const writeId = written.events[0].run_id;
  assert.equal(written.events.at(-1).data.usage.requests, 3);
  const writeState = await status(writeId);
  assert.equal(writeState.usage.requests, 3);
  assert.equal(writeState.usage.tokens, 54);
  const page = await call([
    'runs',
    'events',
    writeId,
    '--after',
    '2',
    '--limit',
    '2',
  ]);
  assert.deepEqual(
    page.events[0].events.map((event) => event.sequence),
    [3, 4],
  );
  assert.equal(page.events[0].next_cursor, 4);
  assert.equal(page.events[0].has_more, true);

  const requestsBeforeReadOnly = requests;
  const readOnly = await call([
    'exec',
    '--prompt',
    'CASE_WRITE',
    '--cwd',
    cwd,
    '--read-only',
    '--timeout',
    '15s',
  ]);
  assert.equal(readOnly.code, 4, JSON.stringify(readOnly));
  assert.equal(requests - requestsBeforeReadOnly, 2);
  assert.match(
    readOnly.events.at(-1).data.permission_denials[0].reason,
    /read-only/,
  );
  const globalOption = await call([
    '--yolo',
    'exec',
    '--prompt',
    'CASE_FINAL',
    '--cwd',
    cwd,
  ]);
  assert.equal(globalOption.code, 2);
  assert.equal(globalOption.events[0].error.code, 'invalid_global_option');

  const denied = await call([
    'exec',
    '--prompt',
    'CASE_DENY',
    '--cwd',
    cwd,
    '--timeout',
    '15s',
  ]);
  assert.equal(denied.code, 4, JSON.stringify(denied));
  assert.equal(existsSync(join(cwd, 'denied.txt')), false);
  assert.ok(
    (await status(denied.events[0].run_id)).permission_denials.length > 0,
  );

  const budget = await call([
    'exec',
    '--prompt',
    'CASE_BUDGET',
    '--cwd',
    cwd,
    '--max-steps',
    '1',
    '--timeout',
    '15s',
  ]);
  assert.equal(budget.code, 5, JSON.stringify(budget));
  const runId = budget.events[0].run_id;
  const saved = await status(runId);
  assert.equal(saved.usage.steps, 1);
  assert.equal(saved.reason, 'step_budget');
  const refused = await call(['exec', '--resume', runId]);
  assert.equal(refused.events[0].error.code, 'budget_exhausted');
  const resumed = await call([
    'exec',
    '--resume',
    runId,
    '--max-steps',
    '4',
    '--idempotency-key',
    'resume-once',
  ]);
  assert.equal(resumed.code, 0, JSON.stringify(resumed));
  assert.ok(resumed.events.every((event) => event.attempt === 2));
  const restored = await status(runId);
  assert.equal(restored.session_id, saved.session_id);
  assert.equal(restored.usage.steps, 3);

  const configurationBefore = await readFile(join(home, 'config.toml'));
  await writeFile(join(cwd, 'AGENTS.md'), 'Synthetic project instructions\n');
  for (const name of ['HOME', 'LINK', 'CHILD', 'NET']) {
    const probe = await call([
      'exec',
      '--prompt',
      'CASE_SANDBOX_' + name,
      '--cwd',
      cwd,
      '--timeout',
      '20s',
    ]);
    assert.deepEqual(
      await readFile(join(home, 'config.toml')),
      configurationBefore,
      'Protected configuration changed during ' + name,
    );
    assert.equal(
      await readFile(join(cwd, 'AGENTS.md'), 'utf8'),
      'Synthetic project instructions\n',
      'Protected instructions changed during ' + name,
    );
    assert.ok(
      probe.events.some((event) => event.type === 'tool.result'),
      name + ': ' + JSON.stringify(probeToolResults.get(name) ?? probe),
    );
    await rm(join(cwd, 'linked-notes.md'), { force: true });
  }
  assert.equal(networkAttempts, 0);
  assert.equal(existsSync(join(cwd, 'network-marker')), false);
  const waiting = await detach('CASE_SHELL', 'stop-shell');
  try {
    await wait(
      waiting.run_id,
      () =>
        existsSync(join(cwd, 'child.pid')) &&
        existsSync(join(cwd, 'child.heartbeat')),
    );
  } catch (error) {
    throw new Error(
      'Sandboxed workspace command failed: ' + JSON.stringify(shellToolResults),
      { cause: error },
    );
  }
  const childPid = Number(await readFile(join(cwd, 'child.pid'), 'utf8'));
  assert.equal((await call(['runs', 'stop', waiting.run_id])).code, 0);
  assert.equal((await wait(waiting.run_id)).reason, 'cancelled');
  const heartbeat = await readFile(join(cwd, 'child.heartbeat'), 'utf8');
  await delay(200);
  assert.equal(await readFile(join(cwd, 'child.heartbeat'), 'utf8'), heartbeat);
  if (process.platform !== 'linux')
    assert.throws(
      () => process.kill(childPid, 0),
      (error) => error.code === 'ESRCH',
    );

  const question = await call([
    'exec',
    '--prompt',
    'CASE_QUESTION',
    '--cwd',
    cwd,
    '--timeout',
    '15s',
  ]);
  assert.equal(question.code, 4, JSON.stringify(question));
  assert.equal(
    (await status(question.events[0].run_id)).status,
    'blocked_input',
  );
  const disabled = await call(
    ['exec', '--prompt', 'CASE_FINAL', '--cwd', cwd],
    { KIMI_CODE_EXPERIMENTAL_APPROVAL_REVIEW: '0' },
  );
  assert.equal(disabled.code, 7, JSON.stringify(disabled));
  assert.equal(
    (await status(disabled.events[0].run_id)).reason,
    'review_disabled',
  );

  const enabledConfig = await readFile(join(home, 'config.toml'), 'utf8');
  const disabledConfig = enabledConfig.replace(
    /approval_review\s*=\s*true/,
    'approval_review = false',
  );
  assert.notEqual(disabledConfig, enabledConfig);
  try {
    await writeFile(join(home, 'config.toml'), disabledConfig);
    const beforeDisabled = requests;
    const unavailable = await call([
      'exec',
      '--prompt',
      'CASE_FINAL',
      '--cwd',
      cwd,
    ]);
    assert.equal(unavailable.code, 7, JSON.stringify(unavailable));
    assert.equal(
      (await status(unavailable.events[0].run_id)).reason,
      'review_disabled',
    );
    assert.equal(requests, beforeDisabled);
  } finally {
    await writeFile(join(home, 'config.toml'), enabledConfig);
  }

  const interrupted = await detach('CASE_HOLD', 'crash-recovery');
  await wait(interrupted.run_id, (state) => state.usage.requests > 0);
  await delay(200);
  const owner = JSON.parse(
    await readFile(
      join(home, 'runs', interrupted.run_id, 'owner.json'),
      'utf8',
    ),
  );
  process.kill(owner.pid, 'SIGKILL');
  assert.equal((await wait(interrupted.run_id)).reason, 'worker_lost');
  hold = false;
  const recovered = await call([
    'exec',
    '--resume',
    interrupted.run_id,
    '--prompt',
    'CASE_FINAL',
  ]);
  assert.equal(recovered.code, 0, JSON.stringify(recovered));
  assert.equal((await status(interrupted.run_id)).usage.requests, 2);
  console.log(
    'Headless runtime smoke passed: autonomous goals, goal continuation and budget resume, reviewed writes, denial reporting, idempotency, cursors, inherited budgets, session resume, stop/child cleanup, blocked input, review enforcement, OS shell containment and crash recovery.',
  );
} finally {
  for (const id of activeRuns) {
    try {
      await call(['runs', 'stop', id]);
      await wait(id);
    } catch {}
  }
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(base, { recursive: true, force: true });
}
