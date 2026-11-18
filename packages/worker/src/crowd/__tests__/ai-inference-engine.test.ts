import { describe, expect, it } from 'vitest';
import { validateAiInferencePayload } from '../index';

describe('validateAiInferencePayload engine option', () => {
  it('accepts friedflaxia text-generation', () => {
    expect(
      validateAiInferencePayload({
        task: 'text-generation',
        model: 'TeamFlaxia/plamo-3-translate-0.8b-onnx',
        input: 'hello',
        engine: 'friedflaxia',
      }),
    ).toBeNull();
  });

  it('rejects friedflaxia for other tasks and unknown engines', () => {
    expect(
      validateAiInferencePayload({
        task: 'text-classification',
        model: 'x',
        input: 'hello',
        engine: 'friedflaxia',
      }),
    ).toMatch(/text-generation only/);
    expect(
      validateAiInferencePayload({
        task: 'text-generation',
        model: 'x',
        input: 'hello',
        engine: 'onnx',
      }),
    ).toMatch(/engine/);
  });
});
