import type { SwarmChainNode, SwarmInitMessage, SwarmMember, SwarmSlice, SwarmSliceMessage } from '@flaxia/sdk';
import type { SwarmEngineAdapter } from './adapter';
import { runSwarmHost, runSwarmWorker, type SwarmFrameLink, type SwarmSemantics } from './session';
import type { SwarmControlMessage } from './messages';

/**
 * Model and tokenizer access the controller needs. `plan` runs on the host
 * (it owns the metadata); `load` builds this node's engine slice. Both are
 * injected so the controller is testable without a GPU or a model server.
 */
export interface SwarmRuntime {
  plan(members: SwarmMember[], model: string): Promise<SwarmChainNode[]>;
  load(slice: SwarmSlice, model: string): Promise<{ engine: SwarmEngineAdapter; semantics: SwarmSemantics }>;
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
 */
export class SwarmController {
  private frameHandler: ((frame: ArrayBuffer) => void) | null = null;
  private engine: SwarmEngineAdapter | null = null;
  private semantics: SwarmSemantics | null = null;
  private sessionId = '';
  private model = '';
  private chainLength = 1;
  private prompt: string | string[] = '';
  private maxNewTokens = 128;
  private sliceLoaded = false;
  private generationStarted = false;
  private settled = false;

  constructor(private readonly options: SwarmControllerOptions) {}

  async start(): Promise<void> {
    const initial = this.options.initial;
    try {
      if (initial.type === 'swarm-init') {
        this.sessionId = initial.sessionId;
        this.model = initial.model;
        this.chainLength = initial.members.length;
        this.prompt = initial.prompt;
        if (initial.maxNewTokens !== undefined) this.maxNewTokens = initial.maxNewTokens;
        const chain = await this.options.runtime.plan(initial.members, initial.model);
        this.options.sendControl({ type: 'swarm-plan', sessionId: initial.sessionId, chain });
        return;
      }
      await this.loadSlice(initial);
    } catch (err) {
      this.fail(err);
    }
  }

  async handleControl(message: SwarmControlMessage): Promise<void> {
    try {
      if (message.type === 'swarm-slice') {
        await this.loadSlice(message);
      } else if (message.type === 'swarm-start') {
        await this.startHost();
      }
    } catch (err) {
      this.fail(err);
    }
  }

  handleFrame(frame: ArrayBuffer): void {
    this.frameHandler?.(frame);
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
    if (this.sliceLoaded) return;
    this.sessionId = message.sessionId;
    this.model = message.model;
    this.chainLength = message.chainLength;

    const { engine, semantics } = await this.options.runtime.load(message.slice, message.model);
    this.engine = engine;
    this.semantics = semantics;
    this.sliceLoaded = true;
    this.options.sendControl({ type: 'swarm-ready', sessionId: message.sessionId });

    if (message.role === 'worker') {
      // A worker just serves frames until the host's stop frame arrives.
      this.generationStarted = true;
      void runSwarmWorker({ engine, link: this.link(), semantics })
        .then(() => this.finish(emptyResult()))
        .catch((err) => this.fail(err));
    }
  }

  private async startHost(): Promise<void> {
    if (this.generationStarted) return;
    const engine = this.engine;
    const semantics = this.semantics;
    if (!engine || !semantics) throw new Error('swarm host received start before loading its slice');
    if (!semantics.encodePrompt || !semantics.decodeTokens) {
      throw new Error('host semantics must provide encodePrompt and decodeTokens');
    }
    this.generationStarted = true;

    const startedAt = performance.now();
    const promptTokens = semantics.encodePrompt(this.prompt);
    const { tokens } = await runSwarmHost({
      chainLength: this.chainLength,
      promptTokens,
      maxNewTokens: this.maxNewTokens,
      engine,
      link: this.link(),
      semantics,
      eosIds: semantics.eosIds,
      onToken: (id) => this.options.emitToken(semantics.decodeTokens!([id])),
    });

    this.finish({
      output: semantics.decodeTokens(tokens),
      tokens,
      nodes: [],
      durationMs: Math.round(performance.now() - startedAt),
    });
  }

  private finish(result: unknown): void {
    if (this.settled) return;
    this.settled = true;
    this.options.onDone(result);
  }

  private fail(err: unknown): void {
    if (this.settled) return;
    this.settled = true;
    this.options.onError(err instanceof Error ? err.message : String(err));
  }
}

function emptyResult() {
  return { output: '', tokens: [] as number[], nodes: [], durationMs: 0 };
}
