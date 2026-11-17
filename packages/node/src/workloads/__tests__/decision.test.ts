import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  class FakeTensor {
    type: string;
    data: any;
    dims: number[];

    constructor(type: string, data: any, dims: number[]) {
      this.type = type;
      this.data = data;
      this.dims = dims;
    }

    to(type: string): FakeTensor {
      if (type === this.type) return this;
      if (type === 'float32') return new FakeTensor('float32', Float32Array.from(this.data), this.dims);
      return new FakeTensor(type, this.data, this.dims);
    }
  }

  const TOKEN_IDS: Record<string, number> = {
    '<|reserved_7|>': 700,
    '<|reserved_8|>': 800,
    '<|reserved_9|>': 900,
    '<|reserved_10|>': 1000,
    '<|reserved_11|>': 1100,
    '<|mask|>': 1200,
  };

  return {
    FakeTensor,
    TOKEN_IDS,
    state: {
      sessions: {} as Record<string, any>,
      loadCalls: [] as Array<Record<string, any>>,
      processorCalls: [] as unknown[][],
      failDevices: new Set<string>(),
    },
  };
});

const FakeTensor = h.FakeTensor;
const TOKEN_IDS = h.TOKEN_IDS;
const state = h.state;

const autoModel = vi.fn(async (_repo: string, options: Record<string, any>) => {
  state.loadCalls.push(options);
  if (state.failDevices.has(String(options.device))) {
    throw new Error(`simulated ${options.device} load failure`);
  }
  return state.sessions[String(options.model_file_name)];
});

const autoProcessor = vi.fn(async () =>
  Object.assign(
    async (images: unknown[]) => {
      state.processorCalls.push(images);
      return {
        pixel_values: new FakeTensor('float32', new Float32Array(768), [1, 1, 768]),
        pixel_attention_mask: new FakeTensor('int64', new BigInt64Array(1), [1, 1]),
        spatial_shapes: new FakeTensor('int64', new BigInt64Array([2n]), [1, 2]),
      };
    },
    { dispose: vi.fn() },
  ),
);

vi.mock('@huggingface/transformers', () => ({
  env: { backends: { onnx: { wasm: {} as Record<string, unknown> } } },
  Tensor: FakeTensor,
  AutoConfig: {
    from_pretrained: async () => ({
      max_length: 16384,
      image_text_length: 896,
      audio_text_length: 15360,
      temperatures: { 'choice:2': 2, choice: 1, noul: 1, score: 1 },
    }),
  },
  AutoTokenizer: {
    from_pretrained: async () => ({
      bos_token_id: 1,
      convert_tokens_to_ids: (token: string) => TOKEN_IDS[token],
      encode: (text: string) => Array.from(text).map((char) => (char.codePointAt(0) ?? 0) % 100 + 10),
    }),
  },
  AutoProcessor: { from_pretrained: autoProcessor },
  AutoModel: { from_pretrained: autoModel },
  loadImage: vi.fn(),
  loadAudio: vi.fn(),
  loadVideo: vi.fn(),
  TextStreamer: class {},
}));

vi.mock('../../executor/egress-guard', () => ({
  fetchGuarded: vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    contentType: 'image/png',
    bytes: new Uint8Array([120, 0]),
    byteLength: 1,
    url: 'https://example.com/photo.png',
  }),
}));

import {
  answerQuestion,
  encodePrompt,
  escapePromptText,
  renderOptions,
  resolvePromptTokens,
  temperatureKey,
} from '../d1-omni/prompt';
import { handleDecision, releaseCache } from '../decision';
import {
  buildInterleavedText,
  handleVectorEmbed,
  MAX_VECTOR_EMBED_AUDIO_SAMPLES,
  MAX_VECTOR_EMBED_VIDEO_FRAMES,
  releaseCache as releaseVectorEmbedCache,
} from '../vector-embed';

const tokenizer = {
  bos_token_id: 1,
  convert_tokens_to_ids: (token: string) => TOKEN_IDS[token],
  encode: (text: string) => Array.from(text).map((char) => (char.codePointAt(0) ?? 0) % 100 + 10),
};

function fakeSession(run: (inputs: Record<string, any>) => any) {
  return Object.assign(vi.fn(run), { dispose: vi.fn() });
}

function installSessions(options: {
  decision?: (inputs: Record<string, any>) => any;
  embedDimensions?: number;
  prefixLength?: number;
  audioLength?: number;
} = {}) {
  const dimensions = options.embedDimensions ?? 4;
  state.sessions.embed_tokens = fakeSession((inputs) => {
    const [, length] = inputs.input_ids.dims;
    return {
      inputs_embeds: new FakeTensor('float16', new Float32Array(1 * length * dimensions), [1, length, dimensions]),
    };
  });
  state.sessions.decision = fakeSession(
    options.decision ??
      ((inputs) => {
        const [batch, markers] = inputs.marker_pos.dims;
        const logits = new Float32Array(batch * markers);
        for (let row = 0; row < batch; row++) logits[row * markers] = 2;
        return { logits: new FakeTensor('float32', logits, [batch, markers]) };
      }),
  );
  state.sessions.vision_encoder = fakeSession(() => {
    const length = options.prefixLength ?? 2;
    return {
      image_features: new FakeTensor('float32', new Float32Array(length * dimensions), [length, dimensions]),
    };
  });
  state.sessions.audio_encoder = fakeSession(() => {
    const length = options.audioLength ?? 3;
    return {
      audio_embeds: new FakeTensor('float32', new Float32Array(length * dimensions), [1, length, dimensions]),
    };
  });
  return state.sessions;
}

function setWebGpu(available: boolean): void {
  Object.defineProperty(navigator, 'gpu', { value: available ? {} : undefined, configurable: true });
}

beforeEach(() => {
  state.loadCalls.length = 0;
  state.processorCalls.length = 0;
  state.failDevices.clear();
  setWebGpu(false);
  releaseCache();
  releaseVectorEmbedCache();
  installSessions();
});

describe('d1-omni prompt encoding', () => {
  const tokens = resolvePromptTokens(tokenizer);

  it('escapes reserved-token syntax so a state cannot forge a delimiter', () => {
    expect(escapePromptText('a <|mask|> b')).toBe('a <¦mask¦> b');
  });

  it('renders choice, score and noul options like prompt.py', () => {
    expect(
      renderOptions({ type: 'choice', instructions: 'x', criteria: { game: 'Game', none: '' } }),
    ).toEqual(['game: Game', 'none']);
    expect(renderOptions({ type: 'score', instructions: 'x', criteria: ['low', 'high'] })).toEqual([
      'level 0: low',
      'level 1: high',
    ]);
    expect(renderOptions({ type: 'noul', instructions: 'x' })).toEqual([
      'false: no, the statement does not hold',
      'true: yes, the statement holds',
    ]);
    expect(renderOptions({ type: 'noul', instructions: 'x' }, { false: 'no', true: 'yes' })).toEqual([
      'false: no',
      'true: yes',
    ]);
    expect(renderOptions({ type: 'noul', instructions: 'x' }, null, true)).toEqual([
      'false: no',
      'true: yes',
    ]);
    expect(
      renderOptions({ type: 'choice', instructions: 'x', criteria: { a: 'A', b: 'B' } }, null, true),
    ).toEqual(['option_000: A', 'option_001: B']);
  });

  it('places every marker on a real <mask> token', () => {
    const { ids, markers } = encodePrompt(
      tokenizer,
      tokens,
      'state text',
      { type: 'choice', instructions: 'pick', criteria: { a: 'A', b: 'B' } },
      512,
    );
    expect(ids[0]).toBe(1);
    expect(ids).toContain(700);
    expect(markers).toHaveLength(2);
    for (const marker of markers) {
      expect(ids[marker]).toBe(1200);
    }
  });

  it('buckets temperatures by option count and type', () => {
    expect(
      temperatureKey({ type: 'choice', instructions: 'x', criteria: { a: 'A', b: 'B' } }),
    ).toBe('choice:2');
    expect(
      temperatureKey({
        type: 'choice',
        instructions: 'x',
        criteria: { a: 'A', b: 'B', c: 'C', d: 'D' },
      }),
    ).toBe('choice:3-5');
    expect(temperatureKey({ type: 'noul', instructions: 'x' })).toBe('noul:2');
  });
});

describe('d1-omni answer extraction', () => {
  it('maps choice logits to the winning option and distribution', () => {
    const answer = answerQuestion(
      { type: 'choice', instructions: 'x', criteria: { a: 'A', b: 'B' } },
      [0, 3],
      2,
    );
    expect(answer.choice).toBe('b');
    expect(answer.confidence).toBeGreaterThan(0.8);
    expect(answer.probabilities?.a).toBeCloseTo(1 - (answer.confidence ?? 0));
  });

  it('reverses noul probabilities to expose P(yes)', () => {
    const answer = answerQuestion({ type: 'noul', instructions: 'x' }, [0, 3]);
    expect(answer.noul).toBeGreaterThan(0.9);
  });

  it('returns an expected level for score questions', () => {
    const answer = answerQuestion(
      { type: 'score', instructions: 'x', criteria: ['low', 'mid', 'high'] },
      [0, 0, 2],
      1,
      false,
    );
    expect(answer.score).toBeGreaterThan(1.5);
    expect(answer.levelProbabilities).toHaveLength(3);
    expect(answer.legend).toEqual(['low', 'mid', 'high']);
  });
});

describe('decision payload validation', () => {
  it('rejects images and audio in one call (model limit)', async () => {
    await expect(
      handleDecision({
        task: 'decision',
        model: 'LiquidAI/d1-omni-600M',
        decision: {
          state: '今日はレトロゲーム会',
          questions: {
            trend: { type: 'choice', instructions: 'x', criteria: { a: 'A', b: 'B' } },
          },
          imageUrls: ['https://example.com/a.png'],
          audioUrl: 'https://example.com/a.wav',
        },
      }),
    ).rejects.toThrow(/images or audio/);
  });

  it('rejects non-https media URLs', async () => {
    await expect(
      handleDecision({
        task: 'decision',
        model: 'LiquidAI/d1-omni-600M',
        decision: {
          state: 'x',
          questions: {
            trend: { type: 'choice', instructions: 'x', criteria: { a: 'A', b: 'B' } },
          },
          imageUrls: ['http://example.com/a.png'],
        },
      }),
    ).rejects.toThrow(/https/);
  });

  it('rejects empty questions and null state without media', async () => {
    await expect(
      handleDecision({ task: 'decision', model: 'LiquidAI/d1-omni-600M', decision: { state: 'x', questions: {} } }),
    ).rejects.toThrow(/questions/);
    await expect(
      handleDecision({
        task: 'decision',
        model: 'LiquidAI/d1-omni-600M',
        decision: {
          state: null,
          questions: { trend: { type: 'choice', instructions: 'x', criteria: { a: 'A', b: 'B' } } },
        },
      }),
    ).rejects.toThrow(/needs at least one image/);
  });

  it('requires criteria for choice and levels for score', async () => {
    await expect(
      handleDecision({
        task: 'decision',
        model: 'LiquidAI/d1-omni-600M',
        decision: { state: 'x', questions: { trend: { type: 'choice', instructions: 'x' } } },
      }),
    ).rejects.toThrow(/criteria/);
    await expect(
      handleDecision({
        task: 'decision',
        model: 'LiquidAI/d1-omni-600M',
        decision: { state: 'x', questions: { urgency: { type: 'score', instructions: 'x' } } },
      }),
    ).rejects.toThrow(/levels/);
  });

  it('rejects an unregistered decision model before any download', async () => {
    await expect(
      handleDecision({
        task: 'decision',
        model: 'evil/not-registered',
        decision: { state: 'x', questions: { t: { type: 'noul', instructions: 'x' } } },
      }),
    ).rejects.toThrow(/model must be/);
    expect(state.loadCalls).toHaveLength(0);
  });
});

describe('d1-omni engine', () => {
  const questions = {
    trend: {
      type: 'choice' as const,
      instructions: 'pick a tag',
      criteria: { game: 'game', music: 'music' },
    },
  };

  it('loads WASM-safe split graphs with pinned external data', async () => {
    await handleDecision({
      task: 'decision',
      model: 'LiquidAI/d1-omni-600M',
      decision: { state: 'retro games', questions },
    });

    expect(state.loadCalls).toHaveLength(2);
    for (const call of state.loadCalls) {
      expect(call.device).toBe('wasm');
      expect(call.use_external_data_format).toBe(true);
    }
    const embed = state.loadCalls.find((call) => call.model_file_name === 'embed_tokens');
    const decision = state.loadCalls.find((call) => call.model_file_name === 'decision');
    expect(embed?.dtype).toBe('fp16');
    expect(decision?.dtype).toBe('q8');
  });

  it('answers a text question and applies the configured temperature', async () => {
    const result = await handleDecision({
      task: 'decision',
      model: 'LiquidAI/d1-omni-600M',
      decision: { state: 'retro games', questions },
    });

    expect(result.answers?.trend.choice).toBe('game');
    expect(result.inputTokens).toBeGreaterThan(0);
    expect(result.durationMs).toBeDefined();
  });

  it('feeds an image prefix into the decision graph', async () => {
    let decisionInputs: Record<string, any> | null = null;
    installSessions({
      prefixLength: 2,
      decision: (inputs) => {
        decisionInputs = inputs;
        return { logits: new FakeTensor('float32', new Float32Array([2, 0]), [1, 2]) };
      },
    });
    const { loadImage } = (await import('@huggingface/transformers')) as unknown as {
      loadImage: ReturnType<typeof vi.fn>;
    };
    loadImage.mockResolvedValue({ width: 32, height: 32 });

    const result = await handleDecision({
      task: 'decision',
      model: 'LiquidAI/d1-omni-600M',
      decision: {
        state: 'photo',
        questions,
        imageUrls: ['https://example.com/photo.png'],
      },
    });

    expect(result.answers?.trend.choice).toBe('game');
    expect(state.processorCalls).toHaveLength(1);
    expect(decisionInputs).not.toBeNull();
    expect(decisionInputs!.prefix_len.data[0]).toBe(2n);
    expect(decisionInputs!.inputs_embeds.dims[1]).toBe(
      decisionInputs!.attention_mask.dims[1],
    );
    expect(state.loadCalls.some((call) => call.model_file_name === 'vision_encoder')).toBe(true);
  });

  it('pads short audio and uses the audio prefix', async () => {
    let decisionInputs: Record<string, any> | null = null;
    installSessions({
      audioLength: 3,
      decision: (inputs) => {
        decisionInputs = inputs;
        return { logits: new FakeTensor('float32', new Float32Array([2, 0]), [1, 2]) };
      },
    });

    const result = await handleDecision({
      task: 'decision',
      model: 'LiquidAI/d1-omni-600M',
      decision: {
        state: null,
        questions,
        audioUrl: 'https://example.com/voice.wav',
      },
    });

    expect(result.answers?.trend.choice).toBe('game');
    expect(decisionInputs!.prefix_len.data[0]).toBe(3n);
    expect(state.loadCalls.some((call) => call.model_file_name === 'audio_encoder')).toBe(true);
  });

  it('falls back to WASM when WebGPU session creation fails', async () => {
    setWebGpu(true);
    state.failDevices.add('webgpu');

    await handleDecision({
      task: 'decision',
      model: 'LiquidAI/d1-omni-600M',
      decision: { state: 'retro games', questions },
    });

    expect(state.loadCalls.some((call) => call.device === 'webgpu')).toBe(true);
    expect(state.loadCalls.some((call) => call.device === 'wasm')).toBe(true);
  });

  it('disposes sessions on releaseCache', async () => {
    await handleDecision({
      task: 'decision',
      model: 'LiquidAI/d1-omni-600M',
      decision: { state: 'retro games', questions },
    });
    const embed = state.sessions.embed_tokens;
    const decision = state.sessions.decision;

    releaseCache();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(embed.dispose).toHaveBeenCalledTimes(1);
    expect(decision.dispose).toHaveBeenCalledTimes(1);
  });
});

describe('vector-embed multimodal helpers', () => {
  it('appends missing placeholders without duplicating existing ones', () => {
    const out = buildInterleavedText('今日の写真 <|image|>', { images: 2, videos: 0, audio: 0 });
    expect(out.split('<|image|>').length - 1).toBe(2);
    expect(buildInterleavedText('x', { images: 0, videos: 1, audio: 1 })).toContain('<|video|>');
    expect(buildInterleavedText('x', { images: 0, videos: 1, audio: 1 })).toContain('<|audio|>');
  });
});

describe('decision/vector-embed media decode caps', () => {
  async function stubEmbeddingModel(): Promise<void> {
    const transformers = (await import('@huggingface/transformers')) as unknown as {
      AutoModel: { from_pretrained: ReturnType<typeof vi.fn> };
      AutoProcessor: { from_pretrained: ReturnType<typeof vi.fn> };
    };
    transformers.AutoModel.from_pretrained.mockResolvedValue(
      Object.assign(async () => ({ sentence_embedding: { data: new Float32Array(768) } }), { dispose: vi.fn() }),
    );
    transformers.AutoProcessor.from_pretrained.mockResolvedValue(
      Object.assign(async () => ({}), { dispose: vi.fn() }),
    );
  }

  it('rejects a decision image that decodes above the pixel cap', async () => {
    const transformers = (await import('@huggingface/transformers')) as unknown as {
      loadImage: ReturnType<typeof vi.fn>;
    };
    transformers.loadImage.mockResolvedValue({ width: 8192, height: 8192 });

    await expect(
      handleDecision({
        task: 'decision',
        model: 'LiquidAI/d1-omni-600M',
        decision: {
          state: 'x',
          questions: { trend: { type: 'choice', instructions: 'x', criteria: { a: 'A', b: 'B' } } },
          imageUrls: ['https://example.com/photo.png'],
        },
      }),
    ).rejects.toThrow(/pixel limit/);
  });

  it('rejects a vector-embed image that decodes above the pixel cap', async () => {
    const transformers = (await import('@huggingface/transformers')) as unknown as {
      loadImage: ReturnType<typeof vi.fn>;
    };
    await stubEmbeddingModel();
    transformers.loadImage.mockResolvedValue({ width: 8192, height: 8192 });

    releaseVectorEmbedCache();
    await expect(
      handleVectorEmbed({
        text: 'hello',
        imageUrls: ['https://example.com/photo.png'],
      }),
    ).rejects.toThrow(/pixel limit/);
    releaseVectorEmbedCache();
  });

  it('rejects vector-embed audio above the sample cap', async () => {
    const transformers = (await import('@huggingface/transformers')) as unknown as {
      loadAudio: ReturnType<typeof vi.fn>;
    };
    await stubEmbeddingModel();
    transformers.loadAudio.mockResolvedValue(new Float32Array(MAX_VECTOR_EMBED_AUDIO_SAMPLES + 1));

    releaseVectorEmbedCache();
    await expect(
      handleVectorEmbed({
        text: 'hello',
        audioUrl: 'https://example.com/a.wav',
      }),
    ).rejects.toThrow(/sample limit/);
    releaseVectorEmbedCache();
  });

  it('bounds vector-embed video frame sampling before decoding', async () => {
    const transformers = (await import('@huggingface/transformers')) as unknown as {
      loadVideo: ReturnType<typeof vi.fn>;
    };
    await stubEmbeddingModel();
    transformers.loadVideo.mockResolvedValue({ frames: [], duration: 0 });

    releaseVectorEmbedCache();
    await handleVectorEmbed({
      text: 'hello',
      videoUrl: 'https://example.com/v.mp4',
    });

    expect(transformers.loadVideo).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ num_frames: MAX_VECTOR_EMBED_VIDEO_FRAMES }),
    );
    releaseVectorEmbedCache();
  });
});

describe('vector-embed releaseCache', () => {
  it('disposes the loaded model and processor instead of leaving them to GC', async () => {
    const disposeModel = vi.fn();
    const disposeProcessor = vi.fn();
    const transformers = (await import('@huggingface/transformers')) as unknown as {
      AutoModel: { from_pretrained: ReturnType<typeof vi.fn> };
      AutoProcessor: { from_pretrained: ReturnType<typeof vi.fn> };
    };
    const model = Object.assign(async () => ({ sentence_embedding: { data: new Float32Array(768) } }), {
      dispose: disposeModel,
    });
    const processor = Object.assign(async () => ({}), { dispose: disposeProcessor });
    transformers.AutoModel.from_pretrained.mockResolvedValue(model);
    transformers.AutoProcessor.from_pretrained.mockResolvedValue(processor);

    const { handleVectorEmbed, releaseCache: releaseVectorCache } = await import('../vector-embed');
    await handleVectorEmbed({ text: 'hello' });
    expect(disposeModel).not.toHaveBeenCalled();

    releaseVectorCache();

    expect(disposeModel).toHaveBeenCalledTimes(1);
    expect(disposeProcessor).toHaveBeenCalledTimes(1);
  });
});
