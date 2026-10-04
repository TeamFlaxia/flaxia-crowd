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
 * Hard ceiling on one hidden-state frame, header included. A payload is sized
 * by the model's hidden dim and the tokens it carries, so a real hop is a few
 * hundred KiB at most; anything past this is a corrupted or hostile frame and
 * must be rejected before `unpackHidden` allocates it.
 */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/** Whether a frame is past {@link MAX_FRAME_BYTES} and must not be decoded. */
export function isOversizedFrame(frame: ArrayBuffer): boolean {
  return frame.byteLength > MAX_FRAME_BYTES;
}

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

/** Check a decoded frame's payload against this slice before the engine sees it. */
function decodeHopPayload(decoded: DecodedFrame, engine: SwarmEngineAdapter, semantics: SwarmSemantics): PayloadFrame {
  let hidden: Float32Array;
  try {
    hidden = semantics.unpackHidden(decoded.payload);
  } catch (err) {
    return { kind: 'corrupt', reason: err instanceof Error ? err.message : String(err) };
  }
  const expected = engine.dim * decoded.header.tokens;
  if (hidden.length !== expected) {
    return { kind: 'corrupt', reason: `carried ${hidden.length} values, expected ${expected}` };
  }
  return { kind: 'ok', hidden };
}

/**
 * Read a frame that arrived while a hop is pending. A frame answering a
 * different request is stale: drop it and keep waiting for the right one, so a
 * straggler from an earlier round cannot resolve this round's hop. An oversized
 * frame joins the invalid-frame path instead of being decoded.
 */
function readHopFrame(
  frame: ArrayBuffer,
  pendingPos: number,
  engine: SwarmEngineAdapter,
  semantics: SwarmSemantics,
): HopFrame {
  if (isOversizedFrame(frame)) {
    return { kind: 'corrupt', reason: `frame is ${frame.byteLength} bytes, over the ${MAX_FRAME_BYTES} byte limit` };
  }
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
  /**
   * Whole-session budget in ms, from the coordinator. A hop that is still
   * unanswered when it runs out rejects instead of waiting forever, so the
   * controller can release the GPU buffers and the worker slot.
   */
  timeoutMs?: number;
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

  // The coordinator's budget covers the whole session; every hop must be
  // answered before it runs out. A peer that never answers then rejects the hop
  // instead of leaving the host awaiting it forever.
  const deadline =
    typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? Date.now() + options.timeoutMs
      : null;

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
      const remaining = deadline === null ? null : deadline - Date.now();
      if (remaining !== null && remaining <= 0) {
        reject(new Error(`swarm hop timed out after ${options.timeoutMs}ms`));
        return;
      }
      let timer: ReturnType<typeof setTimeout> | null = null;
      // Resolve/reject through `settle` so a hop that completes never leaves a
      // deadline timer behind to fire into the next round.
      const settle = (fn: () => void) => {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        fn();
      };
      pending = {
        pos,
        resolve: (value) => settle(() => resolve(value)),
        reject: (err) => settle(() => reject(err)),
      };
      if (remaining !== null) {
        timer = setTimeout(() => {
          timer = null;
          if (pending?.pos === pos) pending = null;
          reject(new Error(`swarm hop timed out after ${options.timeoutMs}ms`));
        }, remaining);
      }
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
  /**
   * Whole-session budget in ms, from the coordinator. A worker that never sees
   * the host's stop frame gives up once it is spent, so its slice (and GPU
   * device) is released with the session.
   */
  timeoutMs?: number;
}

/**
 * Run one middle slice until the host's stop frame arrives. Each hidden frame
 * is unpacked, run through this node's layers and forwarded around the ring.
 * Resolves once the stop frame has been forwarded; rejects if a frame cannot be
 * decoded (or is oversized), so a corrupt stream fails the session instead of
 * hanging it.
 */
export function runSwarmWorker(options: SwarmWorkerOptions): Promise<void> {
  const { engine, link, semantics } = options;
  engine.reset();

  return new Promise<void>((resolve, reject) => {
    let chain: Promise<void> = Promise.resolve();
    let stopped = false;
    const timeoutMs = options.timeoutMs;
    const timer =
      typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => {
            if (stopped) return;
            stopped = true;
            reject(new Error(`swarm worker timed out after ${timeoutMs}ms`));
          }, timeoutMs)
        : null;
    // Every outcome clears the deadline: a session that ends on the stop frame
    // must not leave a timer behind for the next task in this worker.
    const settle = (fn: () => void) => {
      if (timer !== null) clearTimeout(timer);
      fn();
    };

    link.onFrame((frame) => {
      if (stopped) return;
      if (isSwarmStopFrame(frame)) {
        stopped = true;
        link.send(frame);
        chain = chain.then(() => settle(resolve));
        return;
      }
      // Frames must run in order; serialize even if a handler is still running.
      chain = chain
        .then(async () => {
          if (stopped) return;
          if (isOversizedFrame(frame)) {
            throw new Error(
              `swarm frame is unusable: ${frame.byteLength} bytes exceeds the ${MAX_FRAME_BYTES} byte limit`,
            );
          }
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
          settle(() => reject(err instanceof Error ? err : new Error(String(err))));
        });
    });
  });
}
