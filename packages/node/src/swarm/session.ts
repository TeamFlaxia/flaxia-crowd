// Host/worker session loop derived from Nehanth/pooled
// (https://github.com/Nehanth/pooled), MIT, Copyright (c) 2026 Nehanth Narendrula.
// See vendor/pooled/VENDORED.md and vendor/pooled/LICENSE.
import {
  decodeSwarmFrame,
  encodeSwarmFrame,
  encodeSwarmStopFrame,
  isSwarmStopFrame,
} from '@flaxia/sdk';
import type { SwarmEngineAdapter } from './adapter';

/**
 * One swarm node's hidden-state link to the coordinator. Frames are opaque
 * ArrayBuffers (see `encodeSwarmFrame`); the coordinator relays them around the
 * chain without touching the payload.
 */
export interface SwarmFrameLink {
  send(frame: ArrayBuffer): void;
  onFrame(handler: (frame: ArrayBuffer) => void): void;
}

/**
 * The bits that depend on the model/tokenizer, injected so the session logic
 * stays testable without a GPU: how to pack a hidden state to bytes, how to
 * unpack it, and how to pick the next token from logits.
 */
export interface SwarmSemantics {
  /** Pack a hidden state to the f16 payload bytes carried by a frame. */
  packHidden(hidden: Float32Array): Uint8Array;
  /** Unpack a frame payload back to a hidden state. */
  unpackHidden(payload: Uint8Array): Float32Array;
  argmax(logits: Float32Array): number;
}

export interface SwarmHostOptions {
  /** Number of nodes in the chain, including this host. */
  chainLength: number;
  /** Prompt token ids; the host tokenizes before starting. */
  promptTokens: number[];
  /** Maximum tokens to generate. */
  maxNewTokens: number;
  engine: SwarmEngineAdapter;
  link: SwarmFrameLink;
  semantics: SwarmSemantics;
  /** Stop as soon as this id is sampled (it is not emitted). */
  eosIds?: Set<number>;
  /** Called with each generated token id as it is produced. */
  onToken?: (id: number) => void;
}

export interface SwarmHostResult {
  tokens: number[];
}

/**
 * Drive a generation across the chain. The host embeds each token, ships the
 * hidden state around the ring (each worker runs its slice and forwards), then
 * runs the LM head and samples locally. With `chainLength === 1` the host is the
 * whole model and no frames are sent.
 */
export async function runSwarmHost(options: SwarmHostOptions): Promise<SwarmHostResult> {
  const { engine, link, semantics, promptTokens, chainLength, maxNewTokens } = options;
  if (promptTokens.length === 0) throw new Error('swarm host requires at least one prompt token');

  engine.reset();

  let pending: ((hidden: Float32Array) => void) | null = null;
  link.onFrame((frame) => {
    if (isSwarmStopFrame(frame)) return;
    const decoded = decodeSwarmFrame(frame);
    if (!decoded) return;
    const hidden = semantics.unpackHidden(decoded.payload);
    const resolve = pending;
    pending = null;
    resolve?.(hidden);
  });

  const hop = (hidden: Float32Array, pos: number): Promise<Float32Array> => {
    if (chainLength <= 1) return Promise.resolve(hidden);
    return new Promise<Float32Array>((resolve) => {
      pending = resolve;
      link.send(encodeSwarmFrame({ requestId: pos, pos, tokens: 1 }, semantics.packHidden(hidden)));
    });
  };

  const chainOne = async (token: number, pos: number): Promise<Float32Array> => {
    const embedded = await engine.embedRun(token, pos);
    return hop(embedded, pos);
  };

  let logits: Float32Array | null = null;
  for (let i = 0; i < promptTokens.length; i++) {
    const hidden = await chainOne(promptTokens[i], i);
    if (i === promptTokens.length - 1) logits = await engine.headFromHidden(hidden);
  }
  if (!logits) throw new Error('swarm host produced no logits for the prompt');

  const tokens: number[] = [];
  let pos = promptTokens.length;
  let next = semantics.argmax(logits);

  while (tokens.length < maxNewTokens) {
    if (options.eosIds?.has(next)) break;
    tokens.push(next);
    options.onToken?.(next);
    if (tokens.length >= maxNewTokens) break;
    const hidden = await chainOne(next, pos++);
    logits = await engine.headFromHidden(hidden);
    next = semantics.argmax(logits);
  }

  if (chainLength > 1) link.send(encodeSwarmStopFrame());
  return { tokens };
}

export interface SwarmWorkerOptions {
  engine: SwarmEngineAdapter;
  link: SwarmFrameLink;
  semantics: SwarmSemantics;
}

/**
 * Run one middle slice until the host's stop frame arrives. Each hidden frame
 * is unpacked, run through this node's layers and forwarded around the ring.
 * Resolves once the stop frame has been forwarded.
 */
export function runSwarmWorker(options: SwarmWorkerOptions): Promise<void> {
  const { engine, link, semantics } = options;
  engine.reset();

  return new Promise<void>((resolve) => {
    let chain: Promise<void> = Promise.resolve();
    let stopped = false;

    link.onFrame((frame) => {
      if (stopped) return;
      if (isSwarmStopFrame(frame)) {
        stopped = true;
        link.send(frame);
        chain = chain.then(() => resolve());
        return;
      }
      const decoded = decodeSwarmFrame(frame);
      if (!decoded) return;
      // Frames must run in order; serialize even if a handler is still running.
      chain = chain.then(async () => {
        if (stopped) return;
        const hidden = semantics.unpackHidden(decoded.payload);
        const output = await engine.runHidden(hidden, decoded.header.pos);
        link.send(
          encodeSwarmFrame(
            { requestId: decoded.header.requestId, pos: decoded.header.pos, tokens: decoded.header.tokens },
            semantics.packHidden(output),
          ),
        );
      });
    });
  });
}
