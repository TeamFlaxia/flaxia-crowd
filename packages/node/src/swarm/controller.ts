import type {
  SwarmChainNode,
  SwarmInferenceNodeInfo,
  SwarmInitMessage,
  SwarmMember,
  SwarmSlice,
  SwarmSliceMessage,
} from '@flaxia/sdk';
import type { SwarmEngineAdapter } from './adapter';
import { runSwarmHost, runSwarmWorker, SESSION_MAX_SEQ, type SwarmFrameLink, type SwarmSemantics } from './session';
import { findSwarmSliceProblem, type SwarmControlMessage } from './messages';

/** Bounds of a coordinator-supplied session budget. The crowd API already
 * enforces 1s .. 1h; a malformed payload falls back to the cap so a session can
 * never await forever. */
const MAX_SESSION_TIMEOUT_MS = 60 * 60 * 1000;

/** A usable session budget, clamped to the cap; anything else becomes the cap. */
function sessionTimeoutMs(value: unknown): number {
  const timeoutMs = Number(value);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return MAX_SESSION_TIMEOUT_MS;
  return Math.min(timeoutMs, MAX_SESSION_TIMEOUT_MS);
}

/**
 * Model and tokenizer access the controller needs. `plan` runs on the host
 * (it owns the metadata); `load` builds this node's engine slice. Both are
 * injected so the controller is testable without a GPU or a model server.
 */
export interface SwarmRuntime {
  plan(members: SwarmMember[], model: string): Promise<SwarmChainNode[]>;
  load(
    slice: SwarmSlice,
    model: string,
  ): Promise<{ engine: SwarmEngineAdapter; semantics: SwarmSemantics; warm?: boolean }>;
  /**
   * Total trunk layers of `model`, when the runtime can resolve them. The
   * controller validates a coordinator-supplied slice against this before the
   * (expensive) load, so an out-of-range range never reaches the engine.
   */
  resolveLayers?(model: string): Promise<number>;
}

export interface SwarmControllerOptions {
  /** First control message: `swarm-init` on the host, `swarm-slice` on a worker. */
  initial: SwarmInitMessage | SwarmSliceMessage;
  runtime: SwarmRuntime;
  /** Worker -> main: a JSON control message for the coordinator. */
  sendControl: (message: unknown) => void;
  /** Worker -> main: a binary hidden-state frame for the coordinator. */
  sendFrame: (frame: ArrayBuffer) => void;
  /** Worker -> main: a streamed token. */
  emitToken: (token: string) => void;
  onDone: (result: unknown) => void;
  onError: (error: string) => void;
}

/**
 * Drives one node's part of a swarm session inside the Web Worker: the host
 * plans the split then generates; a worker loads its slice and forwards frames.
 * All I/O is through injected callbacks, so `self` never leaks in here.
 *
 * The controller owns one engine for the life of the session and disposes it
 * when the session ends either way: a worker is reused for the next task, so an
 * undisposed slice would keep its GPU buffers (and device) resident.
 */
export class SwarmController {
  private frameHandler: ((frame: ArrayBuffer) => void) | null = null;
  private engine: SwarmEngineAdapter | null = null;
  private semantics: SwarmSemantics | null = null;
  private sessionId = '';
  private model = '';
  private chainLength = 1;
  private chain: SwarmChainNode[] = [];
  private slice: SwarmSlice | null = null;
  private hostWarm: boolean | undefined = undefined;
  private prompt: string | string[] = '';
  private maxNewTokens = 128;
  private sliceLoaded = false;
  private generationStarted = false;
  private settled = false;
  private timeoutMs = MAX_SESSION_TIMEOUT_MS;
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: SwarmControllerOptions) {}

  async start(): Promise<void> {
    if (this.settled) return;
    const initial = this.options.initial;
    this.timeoutMs = sessionTimeoutMs(initial.timeoutMs);
    this.armDeadline();
    try {
      if (initial.type === 'swarm-init') {
        this.sessionId = initial.sessionId;
        this.model = initial.model;
        this.chainLength = initial.members.length;
        this.prompt = initial.prompt;
        if (initial.maxNewTokens !== undefined) this.maxNewTokens = initial.maxNewTokens;
        const chain = await this.options.runtime.plan(initial.members, initial.model);
        this.chain = chain;
        this.options.sendControl({ type: 'swarm-plan', sessionId: initial.sessionId, chain });
        return;
      }
      await this.loadSlice(initial);
    } catch (err) {
      this.fail(err);
    }
  }

  async handleControl(message: SwarmControlMessage): Promise<void> {
    if (this.settled) return;
    if (message.sessionId !== this.sessionId) return;
    try {
      if (message.type === 'swarm-slice') {
        await this.loadSlice(message);
      } else if (message.type === 'swarm-start') {
        await this.startHost();
      } else if (message.type === 'swarm-error') {
        // The coordinator rejected the session (bad plan, failed member, ...):
        // settle immediately instead of waiting for the task timeout.
        this.fail(new Error(message.error || 'swarm session aborted by the coordinator'));
      }
    } catch (err) {
      this.fail(err);
    }
  }

  handleFrame(frame: ArrayBuffer): void {
    if (this.settled) return;
    this.frameHandler?.(frame);
  }

  /**
   * Stop the session because the coordinator settled the task elsewhere (or
   * because the session deadline passed). Exactly like a failure this disposes
   * the engine, so the GPU buffers and device do not stay resident on a device
   * the scheduler has already moved on from.
   */
  abort(reason: string): void {
    this.fail(new Error(reason));
  }

  private link(): SwarmFrameLink {
    return {
      send: (frame) => this.options.sendFrame(frame),
      onFrame: (handler) => {
        this.frameHandler = handler;
      },
    };
  }

  private async loadSlice(message: SwarmSliceMessage): Promise<void> {
    if (this.settled || this.sliceLoaded) return;
    // The slice decides the engine's layer range and whether it builds the
    // embedding/head, so it is validated (against the model's real layer count
    // when the runtime can resolve it) before any weight is fetched or any GPU
    // buffer is allocated.
    const problem = await this.findSliceProblem(message);
    if (problem) throw new Error(`swarm slice rejected: ${problem}`);

    this.sessionId = message.sessionId;
    this.model = message.model;
    this.chainLength = message.chainLength;
    this.slice = message.slice;

    const { engine, semantics, warm } = await this.options.runtime.load(message.slice, message.model);
    if (this.settled) {
      // The session was aborted while the slice was loading; do not leak it.
      engine.dispose();
      return;
    }
    this.engine = engine;
    this.semantics = semantics;
    this.hostWarm = warm;
    this.sliceLoaded = true;
    this.options.sendControl({ type: 'swarm-ready', sessionId: message.sessionId });

    if (message.role === 'worker') {
      // A worker just serves frames until the host's stop frame arrives.
      this.generationStarted = true;
      void runSwarmWorker({ engine, link: this.link(), semantics, timeoutMs: this.timeoutMs })
        .then(() => this.finish(emptyResult()))
        .catch((err) => this.fail(err));
    }
  }

  /** Why the coordinator's slice cannot drive this node, or null when it can. */
  private async findSliceProblem(message: SwarmSliceMessage): Promise<string | null> {
    let totalLayers: number | undefined;
    const resolveLayers = this.options.runtime.resolveLayers;
    if (resolveLayers) {
      totalLayers = await resolveLayers.call(this.options.runtime, message.model);
    }
    return findSwarmSliceProblem(message.slice, {
      role: message.role,
      index: message.index,
      chainLength: message.chainLength,
      totalLayers,
    });
  }

  private async startHost(): Promise<void> {
    if (this.generationStarted) return;
    const engine = this.engine;
    const semantics = this.semantics;
    if (!engine || !semantics) throw new Error('swarm host received start before loading its slice');
    if (!semantics.encodePrompt || !semantics.decodeTokens) {
      throw new Error('host semantics must provide encodePrompt and decodeTokens');
    }

    // `maxNewTokens` comes straight from the task payload. A non-number makes
    // the generation loop's `tokens.length < maxNewTokens` comparison false, so
    // the caller would get an empty completion it cannot tell apart from "the
    // model had nothing to say".
    const maxNewTokens = this.maxNewTokens;
    if (!Number.isInteger(maxNewTokens) || maxNewTokens < 1) {
      throw new Error(`swarm maxNewTokens must be a positive integer, got ${JSON.stringify(maxNewTokens)}`);
    }

    const promptTokens = semantics.encodePrompt(this.prompt);
    // The KV cache holds at most `maxSeq` positions: hand the engine more and
    // it would write past the cache instead of failing cleanly.
    const maxSeq = engine.maxSeq ?? SESSION_MAX_SEQ;
    if (promptTokens.length + maxNewTokens > maxSeq) {
      throw new Error(
        `swarm request needs ${promptTokens.length + maxNewTokens} tokens but the model context holds ${maxSeq}`,
      );
    }

    this.generationStarted = true;
    const startedAt = performance.now();
    const { tokens } = await runSwarmHost({
      chainLength: this.chainLength,
      promptTokens,
      maxNewTokens,
      engine,
      link: this.link(),
      semantics,
      timeoutMs: this.timeoutMs,
      eosIds: semantics.eosIds,
      onToken: (id) => this.options.emitToken(semantics.decodeTokens!([id])),
    });

    const decode = semantics.decodeTokens;
    this.finish({
      output: decode(tokens),
      tokens: tokens.map((id) => decode([id])),
      nodes: this.nodeInfos(),
      durationMs: Math.round(performance.now() - startedAt),
    });
  }

  /**
   * The chain this node planned (or, for a node that never saw the plan, its own
   * slice) as `SwarmInferenceNodeInfo`s. Only this node can report its own
   * warmth, so `warm` is filled in for the host entry alone.
   */
  private nodeInfos(): SwarmInferenceNodeInfo[] {
    const entries: Array<{ slice: SwarmSlice; host: boolean }> =
      this.chain.length > 0
        ? this.chain.map((node) => ({ slice: node.slice, host: node.role === 'host' }))
        : this.slice
          ? [{ slice: this.slice, host: true }]
          : [];
    return entries.map((entry) => {
      const info: SwarmInferenceNodeInfo = { layers: [entry.slice.start, entry.slice.end], host: entry.host };
      if (entry.host && this.hostWarm !== undefined) info.warm = this.hostWarm;
      return info;
    });
  }

  /**
   * Arm the coordinator's session budget. On expiry the session is settled
   * through `abort()`, the same path an external abort takes, so the engine's
   * GPU buffers are released and the worker pool can free the task slot instead
   * of waiting for its own (later) timeout.
   */
  private armDeadline(): void {
    this.clearDeadline();
    const timeoutMs = this.timeoutMs;
    this.deadlineTimer = setTimeout(() => {
      this.deadlineTimer = null;
      this.abort(`swarm session timed out after ${timeoutMs}ms`);
    }, timeoutMs);
  }

  private clearDeadline(): void {
    if (this.deadlineTimer !== null) {
      clearTimeout(this.deadlineTimer);
      this.deadlineTimer = null;
    }
  }

  /** Release the engine (and its GPU device) exactly once, at session end. */
  private teardown(): void {
    this.clearDeadline();
    this.frameHandler = null;
    const engine = this.engine;
    this.engine = null;
    this.semantics = null;
    if (!engine) return;
    try {
      engine.dispose();
    } catch {}
  }

  private finish(result: unknown): void {
    if (this.settled) return;
    this.settled = true;
    this.teardown();
    this.options.onDone(result);
  }

  private fail(err: unknown): void {
    if (this.settled) return;
    this.settled = true;
    this.teardown();
    this.options.onError(err instanceof Error ? err.message : String(err));
  }
}

function emptyResult() {
  return { output: '', tokens: [] as number[], nodes: [] as SwarmInferenceNodeInfo[], durationMs: 0 };
}
