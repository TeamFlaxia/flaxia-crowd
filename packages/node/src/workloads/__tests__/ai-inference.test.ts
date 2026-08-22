import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleAiInference } from '../ai-inference';

const mockGenerate = vi.fn().mockResolvedValue([{ label: 'POSITIVE', score: 0.99 }]);
const mockPipeline = vi.fn();

vi.mock('@huggingface/transformers', () => {
  return {
    env: { backends: { onnx: { wasm: {} } } },
    pipeline: (...args: any[]) => mockPipeline(...args),
    TextStreamer: class {
      constructor(
        public tokenizer: any,
        public config: { callback_function: (text: string) => void },
      ) {}
    },
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  mockPipeline.mockReset();
  const gen = Object.assign(mockGenerate, { tokenizer: { decode: vi.fn() } });
  mockPipeline.mockResolvedValue(gen);
});

describe('AI Inference Workload', () => {
  it('should return pipeline output for text-classification', async () => {
    const payload = {
      task: 'text-classification',
      model: 'Xenova/distilbert-base-uncased-finetuned-sst-2-english',
      input: 'I love this service!',
      options: { dtype: 'q4f16' }
    };

    const result = await handleAiInference(payload);

    expect(result.output).toBeDefined();
    expect(result.output).toEqual([{ label: 'POSITIVE', score: 0.99 }]);
  });

  it('should pass streamer to generator when onToken provided', async () => {
    const payload = {
      task: 'text-classification',
      model: 'test-model',
      input: 'hello',
    };

    const result = await handleAiInference(payload, () => {});
    expect(result.output).toBeDefined();
  });

  it('should throw an error for unsupported tasks', async () => {
    const payload = {
      task: 'invalid-task',
      model: 'some-model',
      input: 'test',
    };

    await expect(handleAiInference(payload as any)).rejects.toThrow(/Invalid or unsupported task/);
  });

  it('should handle array input', async () => {
    const payload = {
      task: 'text-classification',
      model: 'test-model',
      input: ['first input', 'second input'],
    };

    const result = await handleAiInference(payload);
    expect(result.output).toBeDefined();
  });

  it('should accept all supported tasks without throwing', async () => {
    const supportedTasks = [
      'text-classification', 'token-classification', 'question-answering', 'fill-mask',
      'summarization', 'translation', 'text2text-generation', 'text-generation',
      'zero-shot-classification', 'audio-classification', 'zero-shot-audio-classification',
      'automatic-speech-recognition', 'text-to-audio', 'image-to-text', 'image-classification',
      'image-segmentation', 'background-removal', 'zero-shot-image-classification',
      'object-detection', 'zero-shot-object-detection', 'document-question-answering',
      'image-to-image', 'depth-estimation', 'feature-extraction', 'image-feature-extraction'
    ];

    for (const task of supportedTasks) {
      const payload = { task, model: 'test-model', input: 'test' };
      const result = await handleAiInference(payload);
      expect(result.output).toBeDefined();
    }
  });

  it('should provide informative error message listing supported tasks', async () => {
    try {
      await handleAiInference({ task: 'unsupported', model: 'm', input: 'test' } as any);
      expect.unreachable();
    } catch (e: any) {
      expect(e.message).toContain('unsupported task');
      expect(e.message).toContain('text-classification');
    }
  });

  it('should pass device option to pipeline', async () => {
    const payload = {
      task: 'text-generation',
      model: 'test-model-device-opt',
      input: 'hello',
      options: { device: 'webgpu' }
    };

    await handleAiInference(payload);

    expect(mockPipeline).toHaveBeenCalledWith(
      'text-generation',
      'test-model-device-opt',
      expect.objectContaining({ device: 'webgpu' }),
    );
  });

  it('should set do_sample: false by default for greedy decoding', async () => {
    const payload = {
      task: 'text-generation',
      model: 'test-model-greedy',
      input: 'hello',
    };

    await handleAiInference(payload);

    expect(mockGenerate).toHaveBeenCalledWith(
      'hello',
      expect.objectContaining({ do_sample: false }),
    );
  });

  it('should pass generation options when specified', async () => {
    const payload = {
      task: 'text-generation',
      model: 'test-model-gen-opts',
      input: 'hello',
      options: {
        temperature: 0.7,
        top_p: 0.9,
        top_k: 50,
        repetition_penalty: 1.1,
        do_sample: true,
      }
    };

    await handleAiInference(payload);

    expect(mockGenerate).toHaveBeenCalledWith(
      'hello',
      expect.objectContaining({
        do_sample: true,
        temperature: 0.7,
        top_p: 0.9,
        top_k: 50,
        repetition_penalty: 1.1,
      }),
    );
  });
});
