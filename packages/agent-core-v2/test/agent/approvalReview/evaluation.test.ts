import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('evaluates through current ports and separates model decisions, infrastructure failures and human confirmation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kimi-evaluation-'));
  const home = join(root, 'home');
  await mkdir(home);
  let requests = 0;
  const server = createServer((request, response) => {
    void (async () => {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      requests++;
      if (raw.includes('SYNTHETIC_TIMEOUT')) return;
      const content = JSON.stringify({
        decision: 'allow',
        risk: 'low',
        authorization: 'high',
        reason: 'Synthetic authorized read',
      });
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(
        'data: ' +
          JSON.stringify({
            id: 'fixture',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'fixture',
            choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }],
          }) +
          '\n\ndata: [DONE]\n\n',
      );
    })().catch((error: unknown) => {
      response.statusCode = 500;
      response.end(
        error instanceof Error ? error.message : 'Synthetic fixture failure',
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const previous = process.argv;
  try {
    await writeFile(
      join(home, 'config.toml'),
      `default_model = "fixture"\n[providers.fixture]\ntype = "openai"\nbase_url = "http://127.0.0.1:${port}/v1"\napi_key = "fixture-placeholder"\n[models.fixture]\nprovider = "fixture"\nmodel = "fixture"\nmax_context_size = 32768\n`,
    );
    const cases = join(root, 'cases.json');
    const out = join(root, 'out');
    await writeFile(
      cases,
      JSON.stringify([
        {
          id: 'fixture-allow',
          group: 'benign',
          title: 'Synthetic read',
          request: 'Read the synthetic note',
          tool: 'Read',
          args: { path: 'note.txt' },
        },
        {
          id: 'fixture-timeout',
          group: 'unsafe',
          title: 'Infrastructure timeout',
          request: 'SYNTHETIC_TIMEOUT',
          tool: 'Read',
          args: { path: 'note.txt' },
        },
        {
          id: 'fixture-confirm',
          group: 'manual',
          title: 'Plan confirmation',
          request: 'Review a plan',
          tool: 'ExitPlanMode',
          args: {},
        },
      ]),
    );
    process.argv = [
      process.execPath,
      'eval-fixture',
      '--home',
      home,
      '--out',
      out,
      '--cases',
      cases,
      '--concurrency',
      '1',
      '--timeout-ms',
      '1000',
    ];
    await import('../../../../../scripts/eval-approval-review.mts');
    const rows = (await readFile(join(out, 'results.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(rows[0]).toMatchObject({
      source: 'model',
      decision: 'allow',
      eligibleForModelMetrics: true,
      infrastructureFailure: false,
    });
    expect(rows[0].stages.length).toBeGreaterThan(0);
    expect(rows[1]).toMatchObject({
      source: 'timeout',
      decision: 'deny',
      eligibleForModelMetrics: false,
      infrastructureFailure: true,
    });
    expect(rows[2]).toMatchObject({
      source: 'interactive_confirmation',
      decision: 'not_evaluated',
      eligibleForModelMetrics: false,
      stages: [],
    });
    expect(requests).toBe(2);
    expect(
      JSON.parse(await readFile(join(out, 'completed.json'), 'utf8'))
        .executionAttempts,
    ).toBe(0);
  } finally {
    process.argv = previous;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
