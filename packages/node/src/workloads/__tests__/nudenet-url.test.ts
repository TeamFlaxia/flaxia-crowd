import { describe, it, expect } from 'vitest';
import {
  isImageTooLarge,
  isPrivateImageHost,
  MAX_IMAGE_BYTES,
  readImageBlob,
  resolveImageUrl,
} from '../nudenet-url';

describe('nudenet imageUrl host guard', () => {
  it('blocks loopback, private and link-local IPv4 literals', () => {
    for (const host of [
      '127.0.0.1',
      '127.1.2.3',
      '0.0.0.0',
      '10.1.2.3',
      '172.16.5.5',
      '172.31.255.254',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '198.18.0.1',
      '192.0.0.10',
      '224.0.0.1',
      '255.255.255.255',
    ]) {
      expect(isPrivateImageHost(host), host).toBe(true);
    }
    for (const host of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '192.169.1.1', '203.0.113.10']) {
      expect(isPrivateImageHost(host), host).toBe(false);
    }
  });

  it('blocks loopback, unique-local, link-local and mapped IPv6 literals', () => {
    for (const host of [
      '[::1]',
      '::1',
      '::',
      '[fc00::1]',
      '[fd12:3456::1]',
      '[fe80::1]',
      '[ff02::1]',
      '[::ffff:127.0.0.1]',
      '[::ffff:10.0.0.1]',
      '[64:ff9b::127.0.0.1]',
    ]) {
      expect(isPrivateImageHost(host), host).toBe(true);
    }
    expect(isPrivateImageHost('[2606:4700:4700::1111]')).toBe(false);
    expect(isPrivateImageHost('[::ffff:8.8.8.8]')).toBe(false);
    expect(isPrivateImageHost('[64:ff9b::8.8.8.8]')).toBe(false);
  });

  it('blocks internal names but not ordinary public hosts', () => {
    for (const host of ['localhost', 'LOCALHOST', 'foo.localhost', 'printer.local', 'metadata.internal', 'localhost.']) {
      expect(isPrivateImageHost(host), host).toBe(true);
    }
    // An empty host cannot be routed anywhere public; internal-looking labels
    // on a public domain are still public.
    expect(isPrivateImageHost('')).toBe(true);
    for (const host of ['example.com', 'cdn.example.com', 'local.example.com', 'internal.example.com']) {
      expect(isPrivateImageHost(host), host).toBe(false);
    }
  });

  it('resolves only absolute public http(s) URLs', () => {
    expect(resolveImageUrl('https://cdn.example.com/a.jpg').hostname).toBe('cdn.example.com');
    expect(resolveImageUrl('http://8.8.8.8/a.png').protocol).toBe('http:');

    for (const raw of [
      'http://127.0.0.1:8080/admin',
      'http://[::1]/admin',
      'http://2130706433/admin',
      'http://0x7f.1/admin',
      'http://localhost/admin',
      'http://metadata.internal/latest',
      'file:///etc/passwd',
      'data:image/png;base64,AAAA',
      'not a url',
    ]) {
      expect(() => resolveImageUrl(raw), raw).toThrow();
    }
  });

  it('flags an oversized declared length, and only an oversized one', () => {
    expect(isImageTooLarge(String(MAX_IMAGE_BYTES + 1))).toBe(true);
    expect(isImageTooLarge(String(MAX_IMAGE_BYTES))).toBe(false);
    expect(isImageTooLarge('1024', MAX_IMAGE_BYTES)).toBe(false);
    expect(isImageTooLarge(null)).toBe(false);
    expect(isImageTooLarge('not-a-number')).toBe(false);
  });

  it('reads a small body and refuses one over the cap', async () => {
    const ok = await readImageBlob(
      new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }),
      16,
    );
    expect(ok.size).toBe(3);
    expect(ok.type).toBe('image/png');

    await expect(readImageBlob(new Response(new Uint8Array(64)), 16)).rejects.toThrow(/larger than/);

    // A declared length is refused before the body is read...
    const declared = new Response(new Uint8Array(64), { headers: { 'content-length': '64' } });
    await expect(readImageBlob(declared, 16)).rejects.toThrow(/larger than/);

    // ...and a body that lies about its length is cut off while it streams.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(10));
        controller.enqueue(new Uint8Array(10));
        controller.enqueue(new Uint8Array(10));
        controller.close();
      },
    });
    await expect(
      readImageBlob(new Response(stream, { headers: { 'content-length': '10' } }), 16),
    ).rejects.toThrow(/larger than/);
  });
});
