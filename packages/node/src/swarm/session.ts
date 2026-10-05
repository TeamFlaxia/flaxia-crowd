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
  /** Tokenize the prompt (host only). */
  encodePrompt?(text: string | string[]): number[];
  /** Detokenize generated ids (host only). */
  decodeTokens?(ids: number[]): string;
  /** Stop as soon as this id is sampled (host only). */
  eosIds?: Set<number>;
}

/**
 * Ceiling on prompt + generated tokens a session may use. Enough context for
 * chat prompts; KV memory grows with this on the attention layers the node
 * holds, so keep it modest for crowd devices. A model with a smaller native
 * context lowers it further when the slice is created.
 */
export const SESSION_MAX_SEQ = 4096;

/**
 * Outcome of reading an inbound frame while a hop is pending. The three cases
 * must stay distinct: a frame that answers a different request is stale (drop
 * it and keep waiting for the right one), a frame that answers this request but
 * does not decode is corrupt (fail the session rather than feed the engine a
 * bogus state), and anything decodable is handed back as the hidden state.
 */
/** A frame that answered the pending hop: either usable or unusable. */
type PayloadFrame = { kind: 'corrupt'; reason: string } | { kind: 'ok'; hidden: Float32Array };

/** A frame that arrived while a hop is pending. */
type HopFrame = { kind: 'stale' } | PayloadFrame;

type DecodedFrame = NonNullable<ReturnType<typeof decodeSwarmFrame>>;

/** KV-cache bound for a frame: the engine's own limit when it declares one. */
function frameMaxSeq(engine: SwarmEngineAdapter): number {
  const maxSeq = engine.maxSeq;
  if (typeof maxSeq === 'number' && Number.isInteger(maxSeq) && maxSeq > 0) return maxSeq;
  return SESSION_MAX_SEQ;
}

/** Check a decoded frame's payload against this slice before the engine sees it. */
function decodeHopPayload(decoded: DecodedFrame, engine: SwarmEngineAdapter, semantics: SwarmSemantics): PayloadFrame {
  const { pos, tokens } = decoded.header;
  // `pos` is attacker-controlled in a hostile session: without this bound a peer
  // could make the engine write outside its KV cache (GPU device loss).
  const maxSeq = frameMaxSeq(engine);
  if (!Number.isInteger(tokens) || tokens < 1) {
    return { kind: 'corrupt', reason: `carried ${tokens} token columns` };
  }
  if (!Number.isInteger(pos) || pos < 0 || pos + tokens > maxSeq) {
    return { kind: 'corrupt', reason: `position ${pos}+${tokens} is outside the ${maxSeq}-token context` };
  }

  let hidden: Float32Array;
  try {
    hidden = semantics.unpackHidden(decoded.payload);
  } catch (err) {
    return { kind: 'corrupt', reason: err instanceof Error ? err.message : String(err) };
  }
  const expected = engine.dim * tokens;
  if (hidden.length !== expected) {
    return { kind: 'corrupt', reason: `carried ${hidden.length} values, expected ${expected}` };
  }
  // f16 NaN/Inf survive the length check and would poison every downstream
  // layer, so reject them before the engine merges the state.
  for (let i = 0; i < hidden.length; i++) {
    if (!Number.isFinite(hidden[i])) {
      return { kind: 'corrupt', reason: `carried a non-finite value at index ${i}` };
    }
  }
  return { kind: 'ok', hidden };
}

/**
 * Read a frame that arrived while a hop is pending. A frame answering a
 * different request is stale: drop it and keep waiting for the right one, so a
 * straggler from an earlier round cannot resolve this round's hop.
 */
function readHopFrame(
  frame: ArrayBuffer,
  pendingPos: number,
  engine: SwarmEngineAdapter,
  semantics: SwarmSemantics,
): HopFrame {
  const decoded = decodeSwarmFrame(frame);
  if (!decoded) return { kind: 'corrupt', reason: 'malformed frame header' };
  // `requestId` echoes the position the hop was sent for.
  if (decoded.header.pos !== pendingPos || decoded.header.requestId !== pendingPos) return { kind: 'stale' };
  return decodeHopPayload(decoded, engine, semantics);
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
  onToken?: (id: number) => unknown;
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

  let pending: { pos: number; resolve: (hidden: Float32Array) => void; reject: (err: Error) => void } | null = null;
  link.onFrame((frame) => {
    if (isSwarmStopFrame(frame)) return;
    const wait = pending;
    if (!wait) return;
    const read = readHopFrame(frame, wait.pos, engine, semantics);
    if (read.kind === 'stale') return;
    pending = null;
    if (read.kind === 'corrupt') {
      wait.reject(new Error(`swarm hop failed: ${read.reason}`));
      return;
    }
    wait.resolve(read.hidden);
  });

  const hop = (hidden: Float32Array, pos: number): Promise<Float32Array> => {
    if (chainLength <= 1) return Promise.resolve(hidden);
    return new Promise<Float32Array>((resolve, reject) => {
      pending = { pos, resolve, reject };
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
    await options.onToken?.(next);
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
 * Resolves once the stop frame has been forwarded; rejects if a frame cannot be
 * decoded, so a corrupt stream fails the session instead of hanging it.
 */
export function runSwarmWorker(options: SwarmWorkerOptions): Promise<void> {
  const { engine, link, semantics } = options;
  engine.reset();

  return new Promise<void>((resolve, reject) => {
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
      // Frames must run in order; serialize even if a handler is still running.
      chain = chain
        .then(async () => {
          if (stopped) return;
          const decoded = decodeSwarmFrame(frame);
          if (!decoded) throw new Error('swarm frame has a malformed frame header');
          const read = decodeHopPayload(decoded, engine, semantics);
          if (read.kind === 'corrupt') throw new Error(`swarm frame is unusable: ${read.reason}`);
          const output = await engine.runHidden(read.hidden, decoded.header.pos);
          link.send(
            encodeSwarmFrame(
              { requestId: decoded.header.requestId, pos: decoded.header.pos, tokens: decoded.header.tokens },
              semantics.packHidden(output),
            ),
          );
        })
        .catch((err) => {
          stopped = true;
          reject(err instanceof Error ? err : new Error(String(err)));
        });
    });
  });
}
