import { describe, expect, it } from 'vitest';
import { validateVectorEmbedPayload } from '../index';

describe('validateVectorEmbedPayload engine option', () => {
  it('accepts text-only and multimodal friedflaxia payloads', () => {
    expect(validateVectorEmbedPayload({ text: 'hello', engine: 'friedflaxia' })).toBeNull();
    expect(
      validateVectorEmbedPayload({
        text: 'hello',
        imageUrls: ['https://example.com/a.jpg'],
        engine: 'friedflaxia',
      }),
    ).toBeNull();
  });

  it('rejects empty payloads', () => {
    expect(validateVectorEmbedPayload({ engine: 'friedflaxia' })).toMatch(/needs at least/);
  });

  it('rejects unknown engines', () => {
    expect(validateVectorEmbedPayload({ text: 'hello', engine: 'onnx' })).toMatch(/engine/);
  });
});
