/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, expect, it } from 'vitest';
import { createNodeToken, resolveTenantIdFromDb, validateCallbackUrl, verifyNodeToken } from '../security';
import { TEST_NODE_TOKEN_SECRET } from '../worker/__tests__/testSecrets';

describe('verifyNodeToken expert capabilities', () => {
  const base = {
    siteId: 'example.com',
    nodeId: 'node-1',
    capabilities: ['theia-inference'],
    exp: Date.now() + 60_000,
  };

  it('accepts a token with valid expert capabilities', async () => {
    const token = await createNodeToken(TEST_NODE_TOKEN_SECRET, {
      ...base,
      expertCapabilities: ['theia-expert-coder', 'theia-expert-text-editor-2'],
    });
    expect((await verifyNodeToken(TEST_NODE_TOKEN_SECRET, token))?.expertCapabilities).toEqual([
      'theia-expert-coder',
      'theia-expert-text-editor-2',
    ]);
  });

  it.each<[string, unknown]>([
    ['non-array', 'theia-expert-coder'],
    ['more than 32 entries', Array.from({ length: 33 }, (_, i) => `theia-expert-e${i}`)],
    ['bad prefix', ['coder']],
    ['bad id', ['theia-expert-Bad']],
    ['over-long id', [`theia-expert-${'a'.repeat(52)}`]],
  ])('rejects %s', async (_label, expertCapabilities) => {
    const token = await createNodeToken(TEST_NODE_TOKEN_SECRET, {
      ...base,
      expertCapabilities: expertCapabilities as string[] | undefined,
    });
    expect(await verifyNodeToken(TEST_NODE_TOKEN_SECRET, token)).toBeNull();
  });
});

describe('resolveTenantIdFromDb', () => {
  const token = 'test-key-for-d1';
  // Lowercase 64-hex SHA-256 of `token`, computed independently of the Worker:
  //   printf '%s' 'test-key-for-d1' | sha256sum
  const expectedHash = 'b1568d729980e54a571e9e03ba15e4a59bade51a0261b007df804e9decafd800';

  /** Minimal fake D1 binding: records what was queried and returns a scripted row. */
  function makeDb(first: () => Promise<{ tenant_id: string } | null>) {
    const state = { prepareCalls: 0, boundHash: undefined as string | undefined };
    const db = {
      prepare(query: string) {
        state.prepareCalls++;
        expect(query).toContain('api_keys');
        expect(query).toContain('key_hash');
        return {
          bind(hash: string) {
            state.boundHash = hash;
            return { first };
          },
        };
      },
    } as unknown as D1Database;
    return { db, state };
  }

  it('returns the tenant for a correct hash lookup', async () => {
    const { db, state } = makeDb(() => Promise.resolve({ tenant_id: 'tenant-a' }));
    expect(await resolveTenantIdFromDb(db, token)).toBe('tenant-a');
    expect(state.prepareCalls).toBe(1);
    expect(state.boundHash).toBe(expectedHash);
  });

  it('returns null when no row matches the hash', async () => {
    const { db, state } = makeDb(() => Promise.resolve(null));
    expect(await resolveTenantIdFromDb(db, token)).toBeNull();
    expect(state.prepareCalls).toBe(1);
    expect(state.boundHash).toBe(expectedHash);
  });

  it('fails closed (null) when the database throws', async () => {
    const { db, state } = makeDb(() => Promise.reject(new Error('D1 unavailable')));
    expect(await resolveTenantIdFromDb(db, token)).toBeNull();
    expect(state.prepareCalls).toBe(1);
    expect(state.boundHash).toBe(expectedHash);
  });
});

describe('validateCallbackUrl IPv6 SSRF checks', () => {
  it.each([
    'https://[::1]/hook',
    'https://[::]/hook',
    'https://[0:0:0:0:0:0:0:1]/hook',
    'https://[fc00::1]/hook',
    'https://[fd12:3456:789a::1]/hook',
    'https://[fe80::1]/hook',
    'https://[::ffff:127.0.0.1]/hook',
    'https://[::ffff:7f00:1]/hook',
    'https://[::ffff:192.168.1.10]/hook',
    'https://[::ffff:c0a8:10a]/hook',
    'https://[::ffff:808:808]/hook', // all IPv4-mapped literals are rejected
    'https://[::8.8.8.8]/hook',
    'https://[::127.0.0.1]/hook',
    'https://[2001:db8::1]/hook',
    'https://[2002:0808:0808::1]/hook',
    'https://[64:ff9b::a00:1]/hook',
    'https://[64:ff9b:1::a00:1]/hook',
    'https://[2001:20::1]/hook',
    'https://[2001:0:1::1]/hook',
    'https://[192.0.0.8::1]/hook',
    'https://[100::1]/hook',
    'https://[ff02::1]/hook',
  ])('blocks private IPv6 target %s', url => {
    expect(validateCallbackUrl(url)).toBeNull();
  });

  it.each([
    'https://[2606:4700::1111]/hook',
    'https://[2606:4700:4700::1111]/hook',
    'https://[2001:4860:4860::8888]/hook',
    'https://[2001:4860::1]/hook',
  ])('permits global IPv6 target %s', url => {
    expect(validateCallbackUrl(url)).toBe(url);
  });
});

describe('validateCallbackUrl rejects trailing-dot DNS bypasses', () => {
  it.each([
    'https://localhost./hook',
    'https://foo.local./hook',
    'https://foo.internal./hook',
    'https://127.0.0.1./hook',
  ])('blocks %s', url => {
    expect(validateCallbackUrl(url)).toBeNull();
  });

  it('permits a public fully-qualified name with a trailing dot', () => {
    expect(validateCallbackUrl('https://hooks.example./hook')).toBe('https://hooks.example./hook');
  });
});

describe('validateCallbackUrl rejects malformed IPv6 literals', () => {
  it.each([
    'https://[:::1]/hook',
    'https://[1::2::3]/hook',
    'https://[12345::1]/hook',
  ])('blocks malformed IPv6 target %s', url => {
    expect(validateCallbackUrl(url)).toBeNull();
  });
});
