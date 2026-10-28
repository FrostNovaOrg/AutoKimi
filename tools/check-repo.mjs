import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { filesUnder, isMain, projectRoot, readJson, run } from './common.mjs';

export function inspectContent(path, content) {
  assert.ok(
    !/(^|\/)(?:node_modules|\.cache|\.artifacts|dist|dist-web|sessions|binary-evaluation)(\/|$)/.test(
      path,
    ),
    'Generated or private directory: ' + path,
  );
  assert.ok(
    !/(?:\.(?:log|jsonl|pem|key|zip|tar|gz|png|jpg|pdf|tsbuildinfo)$|(?:^|\/)\.env(?:\.|$)|(?:^|\/)(?:config\.toml|oauth\.json|installation\.json)$)/i.test(
      path,
    ),
    'Generated or private file: ' + path,
  );
  assert.ok(!content.includes('\0'), 'Binary file: ' + path);
  const secrets = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
    /\bgithub_pat_[A-Za-z0-9_]{35,}\b/,
    /\bsk-[A-Za-z0-9_-]{24,}\b/,
  ];
  assert.ok(
    !secrets.some((pattern) => pattern.test(content)),
    'Possible credential: ' + path,
  );
  const homeScan =
    /^overlay\/scripts\/approval-review-(?:stress-)?cases\.json$/.test(path)
      ? content.replaceAll('/home/' + 'eval-user/', '/synthetic-home/')
      : content;
  assert.ok(
    !/(?:\/Users\/|\/home\/)[a-z][a-z0-9_.-]*\//i.test(homeScan),
    'Machine-specific home path: ' + path,
  );
}

export async function checkRepo(root = projectRoot) {
  const files = [
    ...new Set(
      existsSync(join(root, '.git'))
        ? run(
            'git',
            ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
            { cwd: root, capture: true },
          )
            .split('\0')
            .filter(Boolean)
        : await filesUnder(root, '', [
            '.cache',
            '.artifacts',
            'node_modules',
            'coverage',
            'dist',
            '.DS_Store',
          ]),
    ),
  ].sort();
  let bytes = 0;
  for (const path of files) {
    const full = join(root, path);
    assert.ok(
      (await lstat(full)).isFile(),
      'Only regular source files may be committed: ' + path,
    );
    const content = await readFile(full);
    assert.ok(content.length <= 128 * 1024, 'File exceeds 128 KiB: ' + path);
    bytes += content.length;
    const text = content.toString('utf8');
    inspectContent(path, text);
    if (path.endsWith('.md')) {
      for (const [, link] of text.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)) {
        if (/^(?:[a-z]+:|#)/i.test(link)) continue;
        const target = decodeURIComponent(link.split('#')[0]);
        assert.ok(
          !target.startsWith('/'),
          'Use relative documentation links: ' + path,
        );
        assert.ok(
          existsSync(resolve(dirname(full), target)),
          `Broken link in ${path}: ${link}`,
        );
      }
    }
  }
  assert.ok(
    bytes <= 1024 * 1024,
    'Repository source exceeds the 1024 KiB budget',
  );
  const lock = await readJson(join(root, 'upstream.lock.json'));
  assert.equal(lock.repository, 'https://github.com/MoonshotAI/kimi-code.git');
  assert.match(lock.commit, /^[a-f0-9]{40}$/);
  assert.equal(lock.tag, '@moonshot-ai/kimi-code@' + lock.version);
  for (const path of lock.patches)
    assert.ok(files.includes(path), 'Missing integration patch: ' + path);
  return { files: files.length, bytes, budgetBytes: 1024 * 1024 };
}

if (isMain(import.meta.url))
  console.log(JSON.stringify(await checkRepo(), null, 2));
