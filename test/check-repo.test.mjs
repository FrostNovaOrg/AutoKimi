import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectContent } from '../tools/check-repo.mjs';

test('repository guard rejects generated and private material', () => {
  for (const path of [
    'node_modules/dependency/package.json',
    '.cache/upstream/package.json',
    'sessions/session.json',
    'private.log',
    'approval-review.jsonl',
    '.env',
    'config.toml',
    'private.pem',
  ])
    assert.throws(() => inspectContent(path, 'data'), /private/);
  assert.throws(
    () => inspectContent('src/key.txt', 'sk-' + 'x'.repeat(40)),
    /credential/,
  );
  assert.throws(
    () => inspectContent('src/key.txt', 'ghp_' + 'x'.repeat(40)),
    /credential/,
  );
  assert.throws(
    () =>
      inspectContent(
        'src/key.txt',
        ['-----BEGIN', 'PRIVATE KEY-----'].join(' '),
      ),
    /credential/,
  );
  assert.throws(
    () =>
      inspectContent(
        'readme.md',
        '/' + ['Users', 'example', 'secret'].join('/'),
      ),
    /home path/,
  );
  assert.throws(() => inspectContent('data', 'binary\0data'), /Binary/);
  inspectContent(
    'docs/installation.md',
    'Use ~/.kimi-code/config.toml and the configured provider.',
  );
});
