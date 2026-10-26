import { describe, expect, it, vi } from 'vitest';
import { McpOAuthClientProvider } from '#/mcpCore/oauth/provider';
import { createMemoryMcpOAuthStore } from '../stubs';

function fixture() {
  const store = createMemoryMcpOAuthStore();
  const provider = new McpOAuthClientProvider({
    serverName: 'example',
    serverUrl: 'https://mcp.example.test',
    store,
  });
  return { store, provider };
}

describe('MCP OAuth issuer binding', () => {
  it('ignores unbound legacy credentials while preserving the shared store', async () => {
    const { store, provider } = fixture();
    const tokens = {
      access_token: 'example-access',
      refresh_token: 'example-refresh',
      token_type: 'Bearer',
    };
    const client = { client_id: 'example-client', client_secret: 'example-secret' };
    await store.write(provider.storeKey + '-tokens.json', tokens);
    await store.write(provider.storeKey + '-client.json', client);
    const loaded = new McpOAuthClientProvider({
      serverName: 'example',
      serverUrl: 'https://mcp.example.test',
      store,
    });
    expect(await loaded.tokens()).toBeUndefined();
    expect(await loaded.clientInformation()).toBeUndefined();
    expect(await store.read(provider.storeKey + '-tokens.json')).toEqual(tokens);
    expect(await store.read(provider.storeKey + '-client.json')).toEqual(client);
  });
  it('persists SDK issuer metadata after the transactional token response', async () => {
    const { store, provider } = fixture();
    const tokens = {
      access_token: 'example-access',
      refresh_token: 'example-refresh',
      token_type: 'Bearer',
    };
    const issuer = 'https://auth.example.test';
    await provider.saveDiscoveryState({ authorizationServerUrl: issuer });
    const fetch = provider.createOAuthFetch(async () =>
      Response.json({ ...tokens, issuer: 'https://other.example.test' }),
    );
    await fetch(issuer + '/token', {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'authorization_code', code: 'example-code' }),
    });
    await provider.saveTokens({ ...tokens, issuer });
    await provider.saveClientInformation({ client_id: 'example-client', issuer });
    expect((await provider.tokens())?.issuer).toBe(issuer);
    expect((await provider.clientInformation())?.issuer).toBe(issuer);
    expect(await store.read(provider.storeKey + '-tokens.json')).toMatchObject({ issuer });
  });
  it('does not substitute an unbound stored refresh token into a request', async () => {
    const { store, provider } = fixture();
    await store.write(provider.storeKey + '-tokens.json', {
      access_token: 'example-access',
      refresh_token: 'legacy-refresh',
      token_type: 'Bearer',
    });
    const request = vi.fn(async () => Response.json({}));
    const fetch = provider.createOAuthFetch(request);
    const response = await fetch('https://auth.example.test/token', {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'bound-refresh' }),
    });
    expect(request).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
  });
});
