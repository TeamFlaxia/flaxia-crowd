import { describe, expect, it } from 'vitest';
import { validateVectorEmbedPayload } from '../index';

describe('validateVectorEmbedPayload engine option', () => {
  it('accepts text-only friedflaxia payloads', () => {
    expect(
      validateVectorEmbedPayload({ text: 'hello', engine: 'friedflaxia' }),
    ).toBeNull();
  });

  it('rejects friedflaxia media and empty text', () => {
    expect(
      validateVectorEmbedPayload({
        text: 'hello',
        imageUrls: ['https://example.com/a.jpg'],
        engine: 'friedflaxia',
      }),
    ).toMatch(/text-only/);
    expect(
      validateVectorEmbedPayload({ engine: 'friedflaxia' }),
    ).toMatch(/text is required/);
  });

  it('rejects unknown engines', () => {
    expect(
      validateVectorEmbedPayload({ text: 'hello', engine: 'onnx' }),
    ).toMatch(/engine/);
  });
});
