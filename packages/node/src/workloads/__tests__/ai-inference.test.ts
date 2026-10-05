import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleAiInference, registerAiModels, listAiModels } from '../ai-inference';

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

// The allowlist is process-wide: extend it with a test-only entry so the tests
// never depend on the production registry contents.
const TEST_MODEL = 'test/allowlisted-model';
registerAiModels({
  [TEST_MODEL]: { repo: 'test/allowlisted-model', revision: 'test-rev', maxBytes: 1024 * 1024 },
  'test/second-model': { repo: 'test/second-model', revision: 'test-rev', maxBytes: 1024 * 1024 },
  'test/device-model': { repo: 'test/device-model', revision: 'test-rev', maxBytes: 1024 * 1024 },
  'test/greedy-model': { repo: 'test/greedy-model', revision: 'test-rev', maxBytes: 1024 * 1024 },
  'test/gen-opts-model': { repo: 'test/gen-opts-model', revision: 'test-rev', maxBytes: 1024 * 1024 },
  'test/array-model': { repo: 'test/array-model', revision: 'test-rev', maxBytes: 1024 * 1024 },
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
      model: TEST_MODEL,
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
      model: TEST_MODEL,
      input: 'hello',
    };

    const result = await handleAiInference(payload, () => {});
    expect(result.output).toBeDefined();
  });

  it('should throw an error for unsupported tasks', async () => {
    const payload = {
      task: 'invalid-task',
      model: TEST_MODEL,
      input: 'test',
    };

    await expect(handleAiInference(payload as any)).rejects.toThrow(/Invalid or unsupported task/);
  });

  it('should handle array input', async () => {
    const payload = {
      task: 'text-classification',
      model: 'test/array-model',
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
      const payload = { task, model: 'test/second-model', input: 'test' };
      const result = await handleAiInference(payload);
      expect(result.output).toBeDefined();
    }
  });

  it('should provide informative error message listing supported tasks', async () => {
    try {
      await handleAiInference({ task: 'unsupported', model: TEST_MODEL, input: 'test' } as any);
      expect.unreachable();
    } catch (e: any) {
      expect(e.message).toContain('unsupported task');
      expect(e.message).toContain('text-classification');
    }
  });

  it('should pass device option to pipeline', async () => {
    const payload = {
      task: 'text-generation',
      model: 'test/device-model',
      input: 'hello',
      options: { device: 'webgpu' }
    };

    await handleAiInference(payload);

    expect(mockPipeline).toHaveBeenCalledWith(
      'text-generation',
      'test/device-model',
      expect.objectContaining({ device: 'webgpu' }),
    );
  });

  it('should set do_sample: false by default for greedy decoding', async () => {
    const payload = {
      task: 'text-generation',
      model: 'test/greedy-model',
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
      model: 'test/gen-opts-model',
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

describe('AI Inference streaming sink', () => {
  const payload = (tokenBuffer: boolean) => ({
    task: 'text-generation', model: TEST_MODEL, input: 'hello',
    options: { tokenBuffer, tokenBufferIntervalMs: 1000 },
  });
  const emit = (options: any, ...texts: string[]) => {
    for (const text of texts) options.streamer.config.callback_function(text);
  };

  it.each([false, true])('awaits async sink calls and propagates rejection (buffer=%s)', async (buffered) => {
    let rejectSink!: (error: Error) => void;
    const sink = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectSink = reject; }));
    mockGenerate.mockImplementationOnce(async (_input, options) => {
      emit(options, 'token');
      return 'generated';
    });
    const result = handleAiInference(payload(buffered), sink);
    await vi.waitFor(() => expect(sink).toHaveBeenCalledWith('token'));
    let settled = false;
    void result.finally(() => { settled = true; }).catch(() => undefined);
    await Promise.resolve();
    expect(settled).toBe(false);
    rejectSink(new Error('sink aborted'));
    await expect(result).rejects.toThrow('sink aborted');
  });

  it('does not emit queued chunks after an earlier async sink failure', async () => {
    let rejectFirst!: (error: Error) => void;
    const sink = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectFirst = reject; }))
      .mockResolvedValue(undefined);
    mockGenerate.mockImplementationOnce(async (_input, options) => {
      emit(options, 'first', 'queued');
      return 'generated';
    });
    const result = handleAiInference(payload(false), sink);
    await vi.waitFor(() => expect(sink).toHaveBeenCalledTimes(1));
    rejectFirst(new Error('first failed'));
    await expect(result).rejects.toThrow('first failed');
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it('flushes a buffered tail immediately when generation finishes', async () => {
    const sink = vi.fn();
    mockGenerate.mockImplementationOnce(async (_input, options) => {
      emit(options, 'hello', ' world');
      return 'generated';
    });
    await expect(handleAiInference(payload(true), sink)).resolves.toEqual({ output: 'generated' });
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith('hello world');
  });

  it('serializes timer flushes with the tail and waits for both', async () => {
    vi.useFakeTimers();
    try {
      const delivered: string[] = [];
      let releaseFirst!: () => void;
      const sink = vi.fn((text: string) => {
        delivered.push(text);
        if (text === 'first') return new Promise<void>((resolve) => { releaseFirst = resolve; });
      });
      let finishGeneration!: (output: string) => void;
      let streamerOptions!: any;
      mockGenerate.mockImplementationOnce((_input, options) => {
        streamerOptions = options;
        emit(options, 'first');
        const result = new Promise<string>((resolve) => { finishGeneration = resolve; });
        return result;
      });
      const result = handleAiInference(payload(true), sink);
      await vi.advanceTimersByTimeAsync(1000);
      expect(delivered).toEqual(['first']);
      emit(streamerOptions, ' second');
      finishGeneration('generated');
      await Promise.resolve();
      expect(delivered).toEqual(['first']);
      releaseFirst();
      await expect(result).resolves.toEqual({ output: 'generated' });
      expect(delivered).toEqual(['first', ' second']);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cleans the timer and drops a partial tail when generation fails', async () => {
    vi.useFakeTimers();
    try {
      const sink = vi.fn();
      mockGenerate.mockImplementationOnce(async (_input, options) => {
        emit(options, 'partial');
        throw new Error('generator failed');
      });
      await expect(handleAiInference(payload(true), sink)).rejects.toThrow('generator failed');
      expect(vi.getTimerCount()).toBe(0);
      expect(sink).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('AI Inference model allowlist (#11)', () => {
  it('exposes the registered models for operator tooling', () => {
    expect(listAiModels()).toContain(TEST_MODEL);
  });

  it('rejects an unknown model before any download', async () => {
    await expect(
      handleAiInference({ task: 'text-generation', model: 'evil/arbitrary-repo', input: 'hi' } as any),
    ).rejects.toThrow(/model not allowed: evil\/arbitrary-repo/);
    expect(mockPipeline).not.toHaveBeenCalled();
  });

  it('rejects a model that is not a non-empty string', async () => {
    await expect(
      handleAiInference({ task: 'text-generation', model: '', input: 'hi' } as any),
    ).rejects.toThrow(/model must be a non-empty string/);
    await expect(
      handleAiInference({ task: 'text-generation', model: { repo: 'x' }, input: 'hi' } as any),
    ).rejects.toThrow(/model must be a non-empty string/);
    expect(mockPipeline).not.toHaveBeenCalled();
  });

  it('validates registry entries at registration time', () => {
    expect(() => registerAiModels({ 'bad/entry': { repo: '', revision: 'r', maxBytes: 1 } })).toThrow(/repo/);
    expect(() =>
      registerAiModels({ 'bad/entry': { repo: 'x', revision: '', maxBytes: 1 } }),
    ).toThrow(/revision/);
    expect(() =>
      registerAiModels({ 'bad/entry': { repo: 'x', revision: 'r', maxBytes: 0 } }),
    ).toThrow(/maxBytes/);
    expect(() =>
      registerAiModels({ 'bad/entry': { repo: 'x', revision: 'r', maxBytes: 1, sha256: 'nope' } }),
    ).toThrow(/sha256/);
  });

  it('rejects an unsafe device', async () => {
    await expect(
      handleAiInference({ task: 'text-generation', model: TEST_MODEL, input: 'hi', options: { device: 'cuda' } } as any),
    ).rejects.toThrow(/device not allowed/);
    expect(mockPipeline).not.toHaveBeenCalled();
  });

  it('rejects an unsafe dtype (fp32/fp16 are not offered to tasks)', async () => {
    for (const dtype of ['fp32', 'fp16', 'int4']) {
      await expect(
        handleAiInference({ task: 'text-generation', model: TEST_MODEL, input: 'hi', options: { dtype } } as any),
      ).rejects.toThrow(/dtype not allowed/);
    }
    expect(mockPipeline).not.toHaveBeenCalled();
  });

  it('rejects malformed input before loading a model', async () => {
    await expect(
      handleAiInference({ task: 'text-generation', model: TEST_MODEL, input: 42 } as any),
    ).rejects.toThrow(/input must be a string/);
    await expect(
      handleAiInference({ task: 'text-generation', model: TEST_MODEL, input: [{ nope: true }] } as any),
    ).rejects.toThrow(/items must be strings/);
    await expect(
      handleAiInference({ task: 'text-generation', model: TEST_MODEL, input: [] } as any),
    ).rejects.toThrow(/1\.\./);
    await expect(
      handleAiInference({ task: 'text-generation', model: TEST_MODEL, input: 'x'.repeat(100_001) } as any),
    ).rejects.toThrow(/characters/);
    expect(mockPipeline).not.toHaveBeenCalled();
  });

  it('rejects out-of-range generation options', async () => {
    await expect(
      handleAiInference({
        task: 'text-generation',
        model: TEST_MODEL,
        input: 'hi',
        options: { max_new_tokens: 1e9 },
      } as any),
    ).rejects.toThrow(/max_new_tokens must be a number within/);
    await expect(
      handleAiInference({
        task: 'text-generation',
        model: TEST_MODEL,
        input: 'hi',
        options: { temperature: Number.NaN },
      } as any),
    ).rejects.toThrow(/temperature must be a number within/);
    await expect(
      handleAiInference({
        task: 'text-generation',
        model: TEST_MODEL,
        input: 'hi',
        options: { do_sample: 'yes' },
      } as any),
    ).rejects.toThrow(/do_sample must be a boolean/);
    expect(mockPipeline).not.toHaveBeenCalled();
  });
});