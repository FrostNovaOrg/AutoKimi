import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { projectRoot } from '../tools/common.mjs';

const names = (await readdir(join(projectRoot, 'docs')))
  .filter((name) => name.endsWith('.md'))
  .sort();
const paths = [
  'README.md',
  'README.zh-CN.md',
  ...names.flatMap((name) => ['docs/' + name, 'docs/en/' + name]),
];
const pages = new Map(
  await Promise.all(
    paths.map(async (path) => [
      path,
      await readFile(join(projectRoot, path), 'utf8'),
    ]),
  ),
);

test('both documentation languages cover every topic with reciprocal navigation', async () => {
  assert.deepEqual(
    (await readdir(join(projectRoot, 'docs/en')))
      .filter((name) => name.endsWith('.md'))
      .sort(),
    names,
  );
  for (const path of ['README.md', 'README.zh-CN.md'])
    assert.ok(
      pages
        .get(path)
        .includes('[English](README.md) | [简体中文](README.zh-CN.md)'),
      path,
    );
  for (const name of names) {
    assert.ok(
      pages
        .get('docs/' + name)
        .includes(`[English](en/${name}) | [简体中文](${name})`),
      name,
    );
    assert.ok(
      pages
        .get('docs/en/' + name)
        .includes(`[English](${name}) | [简体中文](../${name})`),
      name,
    );
    assert.ok(pages.get('README.md').includes(`](docs/en/${name})`), name);
    assert.ok(pages.get('README.zh-CN.md').includes(`](docs/${name})`), name);
  }
});

function anchors(text) {
  const seen = new Map();
  return new Set(
    [
      ...text
        .replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, '')
        .matchAll(/^#{1,6} (.+)$/gm),
    ].map(([, heading]) => {
      const slug = heading
        .toLowerCase()
        .replace(/[^\p{L}\p{M}\p{N}_\-\s]/gu, '')
        .replace(/\s/g, '-');
      const count = seen.get(slug) ?? 0;
      seen.set(slug, count + 1);
      return slug + (count ? '-' + count : '');
    }),
  );
}

test('documentation links resolve heading anchors and keep readers in their selected language', async () => {
  for (const [path, text] of pages) {
    const body = text.replace(/^\[English\].*$/m, '');
    const english = path === 'README.md' || path.startsWith('docs/en/');
    for (const [, link] of body.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)) {
      if (/^[a-z]+:/i.test(link)) continue;
      const [file, fragment] = link.split('#');
      const target = relative(
        projectRoot,
        resolve(
          projectRoot,
          dirname(path),
          decodeURIComponent(file || path.split('/').at(-1)),
        ),
      );
      const targetText =
        pages.get(target) ??
        (await readFile(join(projectRoot, target), 'utf8'));
      if (fragment && target.endsWith('.md'))
        assert.ok(
          anchors(targetText).has(decodeURIComponent(fragment)),
          `${path}: ${link}`,
        );
      if (target.startsWith('docs/'))
        assert.equal(
          target.startsWith('docs/en/'),
          english,
          `${path}: ${link}`,
        );
    }
  }
});
