import { describe, expect, it } from 'vitest';
import {
  isBlockedIPv6Host,
  isSafePublicHostname,
  isSafePublicUrl,
  normalizeHostname,
  parseIPv6Address,
} from '../host-security';

describe('shared hostname security rules', () => {
  it.each([
    'localhost',
    'localhost.',
    'foo.local',
    'foo.local.',
    'foo.internal',
    'foo.internal.',
    'foo.home.arpa.',
    '0.0.0.0',
    '127.0.0.1',
    '169.254.169.254',
    '192.168.1.1',
    '100.64.0.1',
    '[::1]',
    '[fc00::1]',
  ])('rejects unsafe host %s', (host) => {
    expect(isSafePublicHostname(host)).toBe(false);
  });

  it.each([
    'example.com',
    'example.com.',
    'cdn.jsdelivr.net',
    '8.8.8.8',
    '[2606:4700:4700::1111]',
  ])('accepts public host %s', (host) => {
    expect(isSafePublicHostname(host)).toBe(true);
  });

  it('strips exactly one trailing dot before checking', () => {
    expect(normalizeHostname('EXAMPLE.COM.')).toBe('example.com');
    expect(normalizeHostname('[2606:4700::1111]')).toBe('2606:4700::1111');
  });

  it.each([
    '[64:ff9b::192:168:1:1]', // NAT64 well-known prefix
    '[64:ff9b:1::1]', // NAT64 local-use prefix
    '[2002:0a00:0001::1]', // 6to4 carrying 10.0.0.1
    '[2001::1]', // Teredo
    '[2001:db8::1]', // documentation
    '[100::1]', // discard-only
    '[::ffff:192.168.1.1]', // IPv4-mapped private
    '[::ffff:8.8.8.8]', // all mapped addresses are rejected here
    '[1:2:3:4:5:6:7]', // malformed: fail closed
  ])('blocks IPv6 range %s', (host) => {
    expect(isBlockedIPv6Host(host)).toBe(true);
    expect(isSafePublicHostname(host)).toBe(false);
  });

  it.each([
    '[2606:4700:4700::1111]',
    '[2001:4860:4860::8888]',
  ])('permits global IPv6 host %s', (host) => {
    expect(parseIPv6Address(host)).not.toBeNull();
    expect(isSafePublicHostname(host)).toBe(true);
  });

  it('validates full URLs instead of trusting an https:// prefix', () => {
    expect(isSafePublicUrl('https://example.com/image.png')?.hostname).toBe('example.com');
    expect(isSafePublicUrl('https://localhost./image.png')).toBeNull();
    expect(isSafePublicUrl('https://foo.local./image.png')).toBeNull();
    expect(isSafePublicUrl('https://user:pass@example.com/image.png')).toBeNull();
    expect(isSafePublicUrl('https://example.com:8443/image.png')).toBeNull();
    expect(isSafePublicUrl('http://example.com/image.png')).toBeNull();
    expect(isSafePublicUrl('https://[64:ff9b::a00:1]/image.png')).toBeNull();
  });
});
