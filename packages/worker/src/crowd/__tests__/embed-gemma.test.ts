/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect } from 'vitest';
import { validateEmbedGemmaPayload } from '../index';

describe('validateEmbedGemmaPayload', () => {
  it('accepts a well-formed payload', () => {
    expect(validateEmbedGemmaPayload({ texts: ['hello'], dimensions: 512 })).toBeNull();
  });

  it('requires 1..32 texts', () => {
    expect(validateEmbedGemmaPayload({ texts: [] })).toMatch(/texts/);
    expect(validateEmbedGemmaPayload({ texts: new Array(33).fill('x') })).toMatch(/texts/);
  });

  it('rejects empty or oversized texts', () => {
    expect(validateEmbedGemmaPayload({ texts: [''] })).toMatch(/non-empty/);
    expect(validateEmbedGemmaPayload({ texts: ['x'.repeat(4001)] })).toMatch(/4000/);
  });

  it('enforces the total character budget', () => {
    const texts = new Array(32).fill('x'.repeat(4000));
    expect(validateEmbedGemmaPayload({ texts })).toMatch(/total/);
  });

  it('rejects unsupported dimensions', () => {
    expect(validateEmbedGemmaPayload({ texts: ['x'], dimensions: 100 })).toMatch(/dimensions/);
    expect(validateEmbedGemmaPayload({ texts: ['x'], dimensions: 512 })).toBeNull();
  });
});
