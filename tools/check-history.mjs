import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { inspectContent } from './check-repo.mjs';
import { isMain, projectRoot } from './common.mjs';

export function checkHistory(options = {}) {
  const root = resolve(options.root ?? projectRoot);
  const git = (args, extra = {}) =>
    execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
      ...extra,
    });
  assert.equal(
    git(['rev-parse', '--is-shallow-repository']).trim(),
    'false',
    'Fetch complete history before auditing',
  );
  const patterns = options.patterns ?? [];
  assert.ok(
    patterns.every((value) => typeof value === 'string' && value.length > 0),
    'Search patterns must be non-empty strings',
  );
  const refs = git(['for-each-ref', '--format=%(refname)'])
    .trim()
    .split('\n')
    .filter(Boolean);
  const ids = options.allObjects
    ? git(['cat-file', '--batch-all-objects', '--batch-check=%(objectname)'])
        .trim()
        .split('\n')
        .filter(Boolean)
    : git(['rev-list', '--objects', '--all', '--no-object-names'])
        .trim()
        .split('\n')
        .filter(Boolean);
  assert.ok(ids.length > 0, 'No history objects to audit');
  const buffer = git(['cat-file', '--batch'], {
    input: Buffer.from(ids.join('\n') + '\n'),
    encoding: null,
  });
  const objects = new Map();
  let offset = 0;
  while (offset < buffer.length) {
    const end = buffer.indexOf(10, offset);
    assert.ok(end >= offset, 'Invalid Git object header');
    const [id, type, sizeText] = buffer
      .subarray(offset, end)
      .toString('utf8')
      .split(' ');
    const size = Number(sizeText);
    assert.ok(
      Number.isSafeInteger(size) &&
        size >= 0 &&
        end + 2 + size <= buffer.length,
      'Invalid Git object size',
    );
    objects.set(id, {
      type,
      content: buffer.subarray(end + 1, end + 1 + size).toString('utf8'),
    });
    offset = end + size + 2;
  }
  const findings = [];
  function search(value, location) {
    const text = value.normalize('NFKC').toLowerCase();
    for (const [index, pattern] of patterns.entries())
      if (text.includes(pattern.normalize('NFKC').toLowerCase()))
        findings.push({
          ...location,
          rule: 'forbidden text',
          patternIndex: index + 1,
        });
  }
  for (const ref of refs) search(ref, { type: 'ref', ref });
  const paths = new Map();
  let commits = 0;
  let blobs = 0;
  for (const [id, object] of objects) {
    if (object.type !== 'commit' && object.type !== 'tag') continue;
    search(object.content, { type: object.type, object: id });
    try {
      inspectContent('metadata.txt', object.content);
    } catch (error) {
      findings.push({ type: object.type, object: id, rule: error.message });
    }
    if (object.type !== 'commit') continue;
    commits++;
    for (const entry of git(['ls-tree', '-r', '-z', id])
      .split('\0')
      .filter(Boolean)) {
      const separator = entry.indexOf('\t');
      const header = entry.slice(0, separator);
      const path = entry.slice(separator + 1);
      const oid = header.split(' ')[2];
      const names = paths.get(oid) ?? new Set();
      names.add(path);
      paths.set(oid, names);
    }
  }
  for (const [id, object] of objects) {
    if (object.type !== 'blob') continue;
    blobs++;
    search(object.content, { type: 'blob', object: id });
    for (const path of paths.get(id) ?? ['unattached.txt']) {
      search(path, { type: 'path', object: id, path });
      try {
        inspectContent(path, object.content);
      } catch (error) {
        findings.push({ type: 'blob', object: id, path, rule: error.message });
      }
    }
  }
  return {
    clean: findings.length === 0,
    scope: options.allObjects ? 'all-local-objects' : 'all-reachable-refs',
    refs,
    commits,
    blobs,
    objects: objects.size,
    findings,
  };
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      root: { type: 'string' },
      pattern: { type: 'string', multiple: true },
      'all-objects': { type: 'boolean' },
    },
  });
  const result = checkHistory({
    root: values.root,
    patterns: values.pattern,
    allObjects: values['all-objects'],
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.clean) process.exitCode = 1;
}
