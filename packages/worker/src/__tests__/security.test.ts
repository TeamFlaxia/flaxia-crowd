/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, expect, it } from 'vitest';
import { createNodeToken, validateCallbackUrl, verifyNodeToken } from '../security';
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
    'https://[::ffff:808:808]/hook',
    'https://[2001:4860:4860::8888]/hook',
    'https://[2001:4860::1]/hook',
  ])('permits global IPv6 target %s', url => {
    expect(validateCallbackUrl(url)).toBe(url);
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
