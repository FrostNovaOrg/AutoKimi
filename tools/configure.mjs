import { pathToFileURL } from 'node:url';

const [sdkPath, homeDir, version, timeout] = process.argv.slice(2);
const { createKimiHarness } = await import(pathToFileURL(sdkPath).href);
const harness = createKimiHarness({
  homeDir,
  identity: {
    productName: 'kimi-code-cli',
    version,
    platform: 'kimi_code_cli',
  },
});
try {
  const config = await harness.getConfig();
  const patch = {};
  if (config.experimental?.approval_review !== true)
    patch.experimental = { approval_review: true };
  if (config.autokimiPermissionMode !== 'review')
    patch.autokimiPermissionMode = 'review';
  if (timeout !== '')
    patch.permission = { review: { timeoutMs: Number(timeout) } };
  if (Object.keys(patch).length) await harness.setConfig(patch);
} finally {
  await harness.close();
}
