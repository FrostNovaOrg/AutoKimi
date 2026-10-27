import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { install, preparePackage } from './install.mjs';

const exec = promisify(execFile);
const base = await mkdtemp(join(tmpdir(), 'autokimi-headless-smoke-'));
const home = join(base, 'home');
const cwd = join(base, 'workspace');
await mkdir(home);
await mkdir(cwd);
await exec('git', ['init', '-q', cwd]);
await writeFile(join(cwd, 'input.txt'), 'Synthetic input\n');
const cliOption = process.argv.indexOf('--cli');
let command = process.execPath;
let prefix = [cliOption < 0 ? '' : resolve(process.argv[cliOption + 1])];
let reviews = 0;
let requests = 0;
let hold = true;
const activeRuns = new Set();
const shellQuote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";

const server = createServer(async (request, response) => {
  let raw = '';
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  requests++;
  const reviewer = JSON.stringify(body.messages?.[0]).includes(
    'independent permission reviewer',
  );
  if (reviewer) reviews++;
  const transcript = JSON.stringify(body.messages);
  const completedTools =
    body.messages?.filter((message) => message.role === 'tool').length ?? 0;
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
      if (transcript.includes('CASE_BUDGET') && completedTools < 2)
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
      else if (transcript.includes('CASE_SHELL') && completedTools === 0)
        tool = {
          name: 'Bash',
          args: {
            command:
              shellQuote(process.execPath) +
              ' -e ' +
              shellQuote(
                'require("node:fs").writeFileSync("child.pid",String(process.pid));setTimeout(()=>{},30000)',
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
          usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
        }) +
        '\n\n',
    );
    response.end('data: [DONE]\n\n');
  };
  if (!reviewer && transcript.includes('CASE_HOLD') && hold) {
    const timer = setTimeout(send, 10000);
    response.once('close', () => clearTimeout(timer));
  } else send();
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
  if (cliOption < 0) {
    const runtime = await preparePackage(join(base, 'runtime'));
    await mkdir(join(home, 'bin'));
    await writeFile(join(home, 'bin', 'kimi'), 'official command sentinel\n');
    const receipt = await install({ package: runtime, home });
    command = receipt.launcher;
    prefix = [];
  }
  assert.equal((await call(['runs', 'schema'])).events[0].version, 1);
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

  const written = await call([
    'exec',
    '--prompt',
    'CASE_WRITE',
    '--cwd',
    cwd,
    '--timeout',
    '15s',
  ]);
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

  const waiting = await detach('CASE_SHELL', 'stop-shell');
  await wait(waiting.run_id, () => existsSync(join(cwd, 'child.pid')));
  const childPid = Number(await readFile(join(cwd, 'child.pid'), 'utf8'));
  assert.equal((await call(['runs', 'stop', waiting.run_id])).code, 0);
  assert.equal((await wait(waiting.run_id)).reason, 'cancelled');
  await delay(100);
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

  const interrupted = await detach('CASE_HOLD', 'crash-recovery');
  await wait(interrupted.run_id, (state) => state.usage.requests > 0);
  await delay(200);
  const owner = JSON.parse(
    await readFile(
      join(home, 'autokimi', 'runs', interrupted.run_id, 'owner.json'),
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
    'Headless runtime smoke passed: reviewed writes, denial reporting, idempotency, cursors, inherited budgets, session resume, stop/child cleanup, blocked input, review enforcement and crash recovery.',
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
