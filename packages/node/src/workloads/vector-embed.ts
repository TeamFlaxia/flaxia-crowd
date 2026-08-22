import type { VectorEmbedPayload, VectorEmbedResult } from '@flaxia/sdk';

let embeddingPipeline: any = null;

export const releaseCache = (): void => {
  embeddingPipeline = null;
};

export async function handleVectorEmbed(payload: VectorEmbedPayload): Promise<VectorEmbedResult> {
  const startTime = performance.now();

  if (!embeddingPipeline) {
    const loadStartedAt = performance.now();
    console.log('[flaxia-node] vector-embed: loading pipeline model=onnx-community/Qwen3-Embedding-0.6B-ONNX device=wasm');
    const { pipeline } = await import('@huggingface/transformers');
    try {
      embeddingPipeline = await pipeline(
        'feature-extraction',
        'onnx-community/Qwen3-Embedding-0.6B-ONNX',
        { device: 'wasm' } as any,
      );
    } catch (err) {
      console.error(
        `[flaxia-node] vector-embed: pipeline load FAILED error=${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
    console.log(
      `[flaxia-node] vector-embed: pipeline ready loadMs=${Math.round(performance.now() - loadStartedAt)}`,
    );
  }

  const modelStartedAt = performance.now();
  const result = await embeddingPipeline(payload.text, {
    pooling: 'mean',
    normalize: true,
  });

  const vector = Array.from(result.data) as number[];
  const duration = performance.now() - startTime;

  console.log(
    `[flaxia-node] vector-embed: done dims=${vector.length} modelMs=${Math.round(performance.now() - modelStartedAt)} totalMs=${Math.round(duration)} textLen=${payload.text.length}`,
  );

  return {
    vector,
    model: 'Qwen/Qwen3-Embedding-0.6B',
    dimensions: 1024,
    durationMs: Math.round(duration),
  };
}
