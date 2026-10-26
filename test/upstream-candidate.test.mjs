import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import {
  resolveCandidateVersion,
  verifyNpmEvidence,
} from '../tools/upstream-candidate.mjs';

function attestation(payload) {
  return {
    bundle: {
      dsseEnvelope: {
        payload: Buffer.from(JSON.stringify(payload)).toString('base64'),
      },
    },
  };
}

function evidenceFixture() {
  const version = '2.3.1';
  const commit = '684bae9ea6a437f3bae98bba1dcb797a917d500b';
  const tarball = Buffer.from('synthetic release bytes');
  const sha512 = createHash('sha512').update(tarball).digest('hex');
  const metadata = {
    version,
    dist: {
      integrity: `sha512-${createHash('sha512').update(tarball).digest('base64')}`,
    },
  };
  const payload = {
    predicateType: 'https://slsa.dev/provenance/v1',
    subject: [
      {
        name: 'pkg:npm/%40moonshot-ai/kimi-code@2.3.1',
        digest: { sha512 },
      },
    ],
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: {
            repository: 'https://github.com/MoonshotAI/kimi-code',
            path: '.github/workflows/release.yml',
          },
        },
        resolvedDependencies: [{ digest: { gitCommit: commit } }],
      },
      runDetails: { metadata: { invocationId: 'fixture-run' } },
    },
  };
  return {
    version,
    commit,
    tarball,
    metadata,
    attestations: { attestations: [attestation(payload)] },
    sha512,
  };
}

test('validates explicit versions and the latest stable manifest', async (t) => {
  assert.deepEqual(await resolveCandidateVersion({ version: '2.3.1' }), {
    version: '2.3.1',
    prerelease: false,
  });
  assert.deepEqual(await resolveCandidateVersion({ version: '2.4.0-rc.1' }), {
    version: '2.4.0-rc.1',
    prerelease: true,
  });
  await assert.rejects(resolveCandidateVersion({ version: 'not-semver' }));
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        schemaVersion: 1,
        version: '2.3.1',
        publishedAt: '2026-10-23T08:01:44Z',
        rollout: [],
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  assert.deepEqual(
    await resolveCandidateVersion({
      cdnBase: `http://127.0.0.1:${port}/kimi-code`,
    }),
    {
      version: '2.3.1',
      prerelease: false,
      publishedAt: '2026-10-23T08:01:44Z',
      rollout: [],
    },
  );
});

test('rejects a prerelease from the latest channel', async (t) => {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        version: '2.4.0-rc.1',
        publishedAt: '2026-10-23T08:01:44Z',
        rollout: [],
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  await assert.rejects(
    resolveCandidateVersion({ cdnBase: `http://127.0.0.1:${port}` }),
    /prerelease/,
  );
});

test('binds tarball hashes and provenance to the exact package and commit', () => {
  const fixture = evidenceFixture();
  assert.deepEqual(verifyNpmEvidence(fixture), {
    sha512: fixture.sha512,
    integrity: `sha512-${createHash('sha512')
      .update(fixture.tarball)
      .digest('base64')}`,
    invocationId: 'fixture-run',
  });
  {
    const metadata = {
      ...fixture.metadata,
      dist: { integrity: 'sha512-invalid' },
    };
    assert.throws(
      () => verifyNpmEvidence({ ...fixture, metadata }),
      /hash mismatch|Unsupported/,
    );
  }
  assert.throws(
    () =>
      verifyNpmEvidence({
        ...fixture,
        attestations: { attestations: [] },
      }),
    /Missing SLSA provenance/,
  );
  assert.throws(
    () => verifyNpmEvidence({ ...fixture, commit: '0'.repeat(40) }),
    /commit does not match/,
  );
});
