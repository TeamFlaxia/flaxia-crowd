import { describe, expect, it } from 'vitest';
import {
  FRIEDFLAXIA_EMBED_GEMMA,
  assertModelSize,
} from '../friedflaxia/model-registry';

describe('friedflaxia model registry', () => {
  it('pins an immutable revision, URL and SHA-256', () => {
    expect(FRIEDFLAXIA_EMBED_GEMMA.url).toContain(
      `/resolve/${FRIEDFLAXIA_EMBED_GEMMA.revision}/`,
    );
    expect(FRIEDFLAXIA_EMBED_GEMMA.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(FRIEDFLAXIA_EMBED_GEMMA.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(FRIEDFLAXIA_EMBED_GEMMA.url.startsWith('https://huggingface.co/')).toBe(true);
  });

  it('rejects missing and oversized model responses', () => {
    expect(() => assertModelSize(0)).toThrow(/Content-Length/);
    expect(() => assertModelSize(Number.NaN)).toThrow(/Content-Length/);
    expect(() => assertModelSize(FRIEDFLAXIA_EMBED_GEMMA.maxBytes + 1)).toThrow(/too large/);
    expect(() => assertModelSize(1024)).not.toThrow();
  });
});
