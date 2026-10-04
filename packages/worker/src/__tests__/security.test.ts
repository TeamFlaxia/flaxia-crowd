/// <reference types="@cloudflare/vitest-pool-workers" />
/**
 * `callbackUrl` SSRF guard.
 *
 * `URL.hostname` hands an IPv6 literal back with its brackets (`[::1]`), so a
 * guard that matches the raw hostname never parses the address at all: every
 * IPv6 literal — loopback, unique-local, IPv4-mapped — used to be accepted.
 */
import { describe, it, expect } from 'vitest';
import { validateCallbackUrl } from '../security';

describe('validateCallbackUrl', () => {
  describe('IPv6 literals', () => {
    const blocked: Array<[label: string, url: string]> = [
      ['loopback ::1', 'https://[::1]/hook'],
      ['the unspecified address ::', 'https://[::]/hook'],
      ['an expanded loopback', 'https://[0:0:0:0:0:0:0:1]/hook'],
      ['unique local fc00::/7', 'https://[fc00::1]/hook'],
      ['unique local fd00::/8', 'https://[fd12:3456:789a::1]/hook'],
      ['link local fe80::/10', 'https://[fe80::1]/hook'],
      ['IPv4-mapped loopback', 'https://[::ffff:127.0.0.1]/hook'],
      ['IPv4-mapped loopback in hex', 'https://[::ffff:7f00:1]/hook'],
      ['IPv4-mapped private', 'https://[::ffff:192.168.1.10]/hook'],
      ['IPv4-mapped private in hex', 'https://[::ffff:c0a8:10a]/hook'],
      ['IPv4-mapped unspecified', 'https://[::ffff:0.0.0.0]/hook'],
    ];

    it.each(blocked)('rejects %s', (_label, url) => {
      expect(validateCallbackUrl(url)).toBeNull();
    });

    it('allows a public IPv6 literal', () => {
      expect(validateCallbackUrl('https://[2606:4700::1111]/dns-query')).toBe(
        'https://[2606:4700::1111]/dns-query',
      );
      expect(validateCallbackUrl('https://[2606:4700:4700::1111]/hook')).toBe(
        'https://[2606:4700:4700::1111]/hook',
      );
      expect(validateCallbackUrl('https://[::ffff:808:808]/hook')).toBe('https://[::ffff:808:808]/hook');
    });
  });

  describe('IPv4 and hostnames', () => {
    const blocked: Array<[label: string, url: string]> = [
      ['loopback', 'https://127.0.0.1/hook'],
      ['the unspecified address', 'https://0.0.0.0/hook'],
      ['private 10/8', 'https://10.1.2.3/hook'],
      ['private 172.16/12', 'https://172.16.5.4/hook'],
      ['private 192.168/16', 'https://192.168.0.1/hook'],
      ['link local 169.254/16', 'https://169.254.1.1/hook'],
      ['carrier grade NAT 100.64/10', 'https://100.64.0.1/hook'],
      ['benchmarking 198.18/15', 'https://198.18.0.1/hook'],
      ['a .local name', 'https://printer.local/hook'],
      ['an .internal name', 'https://api.internal/hook'],
      ['a .localhost name', 'https://admin.localhost/hook'],
      ['plain HTTP to a public host', 'http://example.com/hook'],
    ];

    it.each(blocked)('rejects %s', (_label, url) => {
      expect(validateCallbackUrl(url)).toBeNull();
    });

    it('allows public hosts', () => {
      for (const url of [
        'https://hooks.example.com/crowd',
        'https://example.com:8443/hook',
        'https://8.8.8.8/hook',
        'https://example.com./hook',
      ]) {
        expect(validateCallbackUrl(url)).toBe(url);
      }
    });

    it('still allows plain HTTP to loopback for local development', () => {
      expect(validateCallbackUrl('http://localhost:8787/hook')).toBe('http://localhost:8787/hook');
      expect(validateCallbackUrl('http://127.0.0.1:8787/hook')).toBe('http://127.0.0.1:8787/hook');
    });

    it('rejects non-HTTP protocols and malformed URLs', () => {
      expect(validateCallbackUrl('ftp://example.com/hook')).toBeNull();
      expect(validateCallbackUrl('not a url')).toBeNull();
      expect(validateCallbackUrl('')).toBeNull();
    });
  });
});
