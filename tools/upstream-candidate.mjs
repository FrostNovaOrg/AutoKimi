import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  projectRoot,
  readUpstreamLock,
  run,
  validateUpstreamLock,
} from './common.mjs';

const OFFICIAL_REPOSITORY = 'https://github.com/MoonshotAI/kimi-code';
const OFFICIAL_GIT = OFFICIAL_REPOSITORY + '.git';
const NPM_PACKAGE = '@moonshot-ai/kimi-code';
const NPM_REGISTRY = 'https://registry.npmjs.org';
const DEFAULT_CDN = 'https://code.kimi.com/kimi-code';
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

async function fetchResponse(url) {
  const target = new URL(url);
  assert.ok(
    target.protocol === 'https:' ||
      ['127.0.0.1', 'localhost', '::1'].includes(target.hostname),
    'Only HTTPS or an isolated loopback endpoint is allowed',
  );
  const response = await fetch(url, {
    signal: AbortSignal.timeout(60000),
    headers: { accept: 'application/json' },
  }).catch((error) => {
    throw new Error(`Download failed: ${url}`, { cause: error });
  });
  assert.ok(response.ok, `Download failed (${response.status}): ${url}`);
  return response;
}

async function fetchJson(url) {
  const response = await fetchResponse(url);
  return response.json();
}

async function fetchBuffer(url) {
  const response = await fetchResponse(url);
  return Buffer.from(await response.arrayBuffer());
}

function parseVersion(value) {
  assert.equal(typeof value, 'string', 'Missing upstream version');
  const match = SEMVER.exec(value);
  assert.ok(match, `Invalid semver: ${value}`);
  return { version: value, prerelease: match[4] !== undefined };
}

export async function resolveCandidateVersion(options = {}) {
  if (options.version !== undefined) return parseVersion(options.version);
  const base = options.cdnBase ?? process.env.AUTOKIMI_CDN_BASE ?? DEFAULT_CDN;
  const manifest = await fetchJson(`${base}/latest.json`);
  const selected = parseVersion(manifest.version);
  assert.ok(!selected.prerelease, 'The latest channel contains a prerelease');
  assert.ok(
    typeof manifest.publishedAt === 'string' &&
      Number.isFinite(Date.parse(manifest.publishedAt)),
    'Invalid upstream publication time',
  );
  assert.ok(
    manifest.rollout === undefined || Array.isArray(manifest.rollout),
    'Invalid upstream rollout manifest',
  );
  return {
    ...selected,
    publishedAt: manifest.publishedAt,
    rollout: manifest.rollout,
  };
}

export async function resolveReleaseCommit(version, repository = OFFICIAL_GIT) {
  const tag = `${NPM_PACKAGE}@${version}`;
  const output = run(
    'git',
    ['ls-remote', repository, `refs/tags/${tag}`, `refs/tags/${tag}^{}`],
    { capture: true },
  );
  const rows = output
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split(/\s+/));
  assert.ok(rows.length > 0 && rows.length <= 2, 'Upstream tag is missing');
  const objectSha = rows[0][0];
  const commit = rows.at(-1)[0];
  assert.match(objectSha, /^[a-f0-9]{40}$/);
  assert.match(commit, /^[a-f0-9]{40}$/);
  if (objectSha !== commit) {
    const object = await fetchJson(
      `${OFFICIAL_REPOSITORY}/git/tags/${objectSha}`.replace(
        'https://github.com',
        'https://api.github.com/repos',
      ),
    );
    assert.equal(object.tag, tag, 'Unexpected upstream tag object');
    assert.equal(object.object?.sha, commit, 'Tag and commit do not match');
    assert.equal(object.object?.type, 'commit', 'Tag target is not a commit');
  }
  return { tag, tagObject: objectSha, commit };
}

export function decodeAttestation(bundle) {
  const payload = bundle?.dsseEnvelope?.payload;
  assert.equal(typeof payload, 'string', 'Missing attestation payload');
  return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
}

export function verifyNpmEvidence(input) {
  const { metadata, attestations, tarball, version, commit } = input;
  assert.equal(metadata.version, version, 'npm version does not match');
  const integrity = metadata.dist?.integrity;
  assert.equal(typeof integrity, 'string', 'Missing npm integrity');
  assert.ok(integrity.startsWith('sha512-'), 'Unsupported npm integrity');
  const actualBase64 = createHash('sha512').update(tarball).digest('base64');
  assert.equal(integrity, `sha512-${actualBase64}`, 'npm tarball hash mismatch');
  const actualHex = createHash('sha512').update(tarball).digest('hex');
  const subjectName = `pkg:npm/%40moonshot-ai/kimi-code@${version}`;
  let provenance;
  for (const entry of attestations.attestations ?? []) {
    const payload = decodeAttestation(entry.bundle);
    if (payload.predicateType !== 'https://slsa.dev/provenance/v1') continue;
    const subject = (payload.subject ?? []).find(
      (item) => item.name === subjectName,
    );
    assert.ok(subject, 'Provenance subject does not match the npm package');
    assert.equal(
      subject.digest?.sha512,
      actualHex,
      'Provenance tarball hash mismatch',
    );
    provenance = payload;
    break;
  }
  assert.ok(provenance, 'Missing SLSA provenance');
  const definition = provenance.predicate?.buildDefinition;
  assert.equal(
    definition?.externalParameters?.workflow?.repository,
    OFFICIAL_REPOSITORY,
    'Unexpected provenance repository',
  );
  assert.equal(
    definition?.externalParameters?.workflow?.path,
    '.github/workflows/release.yml',
    'Unexpected release workflow',
  );
  assert.ok(
    (definition?.resolvedDependencies ?? []).some(
      (dependency) => dependency.digest?.gitCommit === commit,
    ),
    'Provenance commit does not match the release tag',
  );
  return {
    sha512: actualHex,
    integrity: `sha512-${actualBase64}`,
    invocationId: provenance.predicate?.runDetails?.metadata?.invocationId,
  };
}

export async function verifyNpmSignatures(options) {
  const { directory, version } = options;
  await mkdir(directory, { recursive: true });
  const env = {
    ...process.env,
    NPM_CONFIG_USERCONFIG: '/dev/null',
    NPM_CONFIG_CACHE: join(directory, 'npm-cache'),
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_PROGRESS: 'false',
  };
  run(
    'npm',
    [
      'install',
      '--ignore-scripts',
      `--registry=${NPM_REGISTRY}`,
      `${NPM_PACKAGE}@${version}`,
    ],
    { cwd: directory, env },
  );
  return run('npm', ['audit', 'signatures', `--registry=${NPM_REGISTRY}`], {
    cwd: directory,
    env,
    capture: true,
  });
}

function normalizedDependencies(value) {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(value ?? {}).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  );
}

async function verifyEnvironment(lock) {
  const [baseRoot, candidateRoot, baseApp, candidateApp] = await Promise.all([
    fetchJson(
      `https://raw.githubusercontent.com/MoonshotAI/kimi-code/${lock.commit}/package.json`,
    ),
    fetchJson(
      `https://raw.githubusercontent.com/MoonshotAI/kimi-code/${lock.candidateCommit}/package.json`,
    ),
    fetchJson(
      `https://raw.githubusercontent.com/MoonshotAI/kimi-code/${lock.commit}/apps/kimi-code/package.json`,
    ),
    fetchJson(
      `https://raw.githubusercontent.com/MoonshotAI/kimi-code/${lock.candidateCommit}/apps/kimi-code/package.json`,
    ),
  ]);
  assert.equal(
    candidateRoot.packageManager,
    baseRoot.packageManager,
    'Upstream package manager changed; manual migration required',
  );
  assert.equal(
    candidateRoot.packageManager,
    `pnpm@${lock.pnpm}`,
    'Upstream pnpm version changed; manual migration required',
  );
  assert.equal(
    candidateRoot.engines?.node,
    baseRoot.engines?.node,
    'Upstream Node engine changed; manual migration required',
  );
  assert.equal(candidateApp.version, lock.version, 'CLI version mismatch');
  assert.equal(
    candidateApp.engines?.node,
    baseApp.engines?.node,
    'CLI Node engine changed; manual migration required',
  );
  for (const field of ['dependencies', 'optionalDependencies']) {
    assert.equal(
      normalizedDependencies(candidateApp[field]),
      normalizedDependencies(baseApp[field]),
      `CLI ${field} changed; manual native dependency review required`,
    );
  }
}

export async function createUpstreamCandidate(options = {}) {
  const root = resolve(options.root ?? projectRoot);
  const baseline = await readUpstreamLock(root);
  const selected = await resolveCandidateVersion(options);
  const release = await resolveReleaseCommit(selected.version);
  const [metadata, attestations] = await Promise.all([
    fetchJson(
      `${NPM_REGISTRY}/${encodeURIComponent(NPM_PACKAGE)}/${selected.version}`,
    ),
    fetchJson(
      `${NPM_REGISTRY}/-/npm/v1/attestations/${encodeURIComponent(`${NPM_PACKAGE}@${selected.version}`)}`,
    ),
  ]);
  assert.equal(typeof metadata.dist?.tarball, 'string', 'Missing npm tarball');
  assert.ok(
    metadata.dist.tarball.includes(`kimi-code-${selected.version}.tgz`),
    'Unexpected npm tarball URL',
  );
  const tarball = await fetchBuffer(metadata.dist.tarball);
  const evidence = verifyNpmEvidence({
    metadata,
    attestations,
    tarball,
    version: selected.version,
    commit: release.commit,
  });
  const lock = validateUpstreamLock({
    ...baseline,
    tag: release.tag,
    version: selected.version,
    commit: release.commit,
  });
  await verifyEnvironment({
    ...lock,
    commit: baseline.commit,
    candidateCommit: release.commit,
  });
  if (options.auditDirectory !== undefined)
    await verifyNpmSignatures({
      directory: resolve(options.auditDirectory),
      version: selected.version,
    });
  if (options.lockPath !== undefined)
    await writeFile(
      resolve(options.lockPath),
      JSON.stringify(lock, null, 2) + '\n',
      { mode: 0o600 },
    );
  if (options.tarballPath !== undefined)
    await writeFile(resolve(options.tarballPath), tarball, { mode: 0o600 });
  return {
    lock,
    evidence: {
      ...selected,
      ...release,
      ...evidence,
      attestationCount: attestations.attestations?.length ?? 0,
      signaturesVerified: options.auditDirectory !== undefined,
    },
  };
}
