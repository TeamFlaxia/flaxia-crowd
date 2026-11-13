import { describe, it, expect } from 'vitest';
import { listAiModels, resolveAiModel } from '../ai-model-registry';

describe('default model registry', () => {
  it('registers the PLaMO translate model', () => {
    expect(listAiModels()).toContain('TeamFlaxia/plamo-3-translate-0.8b-onnx');
    expect(listAiModels()).not.toContain('Xenova/m2m100_418M');
  });

  it('pins PLaMo to the Flaxia model revision with a cap above the q4f16 weights', () => {
    const definition = resolveAiModel('TeamFlaxia/plamo-3-translate-0.8b-onnx');
    expect(definition.repo).toBe('TeamFlaxia/plamo-3-translate-0.8b-onnx');
    expect(definition.revision).toBe('1c8417ee1a72442440ad515b02f99186c81fd08a');
    // The q4f16 weights weigh ~673 MiB; the entry cap must sit above them
    // even though the default 512 MiB cap would reject the download.
    expect(definition.maxBytes).toBeGreaterThan(673 * 1024 * 1024);
  });

  it('keeps the registry fail-closed for unknown models', () => {
    expect(() => resolveAiModel('someone/else-model')).toThrow(/model not allowed/);
  });
});
