import {
  decodeSwarmEnvelope,
  isSwarmInitMessage,
  isSwarmSliceMessage,
  MAX_SWARM_ENVELOPE_BYTES,
  signSwarmEnvelope,
  verifySwarmEnvelope,
} from '../../sdk/src/index';
import { SwarmController, type SwarmRuntime } from '../../node/src/swarm/controller';
import { isSwarmControlMessage } from '../../node/src/swarm/messages';

/** Same controller, hidden-state codec and hop authentication as browser nodes.
 * Native peers currently use Coordinator relay; peerReady=false selects it for
 * the entire chain, including browser members. One bridge lives for one attempt.
 */
export class NativeSwarmBridge {
  private controller?: SwarmController;
  private initial?: { taskId: string; attemptId: string; sessionId: string };
  private inboundKey?: string;
  private outboundKey?: string;
  private chainLength = 0;
  private outgoing = Promise.resolve();
  private settled = false;
  private pendingFrames = 0;

  constructor(
    private runtime: SwarmRuntime,
    private output: (value: unknown) => Promise<void>,
  ) {}

  private scoped(message: object) {
    return { ...message, ...this.initial };
  }

  // Ordered output is awaited at token boundaries; a slow parent stalls
  // generation instead of accumulating an unbounded stream in memory.
  private enqueue(message: unknown): Promise<void> {
    this.outgoing = this.outgoing.then(() => this.output(message));
    return this.outgoing;
  }

  async accept(value: any): Promise<void> {
    if (this.settled) return;
    if (value?.kind === 'frame') {
      if (
        !this.controller || typeof value.data !== 'string' ||
        value.data.length > Math.ceil(MAX_SWARM_ENVELOPE_BYTES / 3) * 4
      ) return;
      const bytes = Uint8Array.from(atob(value.data), (c) => c.charCodeAt(0));
      const envelope = decodeSwarmEnvelope(bytes.buffer);
      if (!envelope || envelope.sessionId !== this.initial?.sessionId) return;
      if (
        !this.inboundKey || !envelope.mac ||
        !await verifySwarmEnvelope(
          this.inboundKey,
          envelope.sessionId,
          envelope.frame,
          envelope.mac,
        )
      ) return;
      if (++this.pendingFrames > 2) throw new Error('too many pending swarm frames');
      this.controller.handleFrame(envelope.frame);
      return;
    }
    const message = value?.message;
    if (value?.kind !== 'control' || !isSwarmControlMessage(message)) return;
    if (!this.initial) {
      if (!isSwarmInitMessage(message) && !isSwarmSliceMessage(message)) return;
      const attemptId = (message as unknown as Record<string, unknown>).attemptId;
      if (
        typeof attemptId !== 'string' || !attemptId || attemptId.length > 128 ||
        message.taskId.length > 128 || message.sessionId.length > 128
      ) return;
      this.initial = { taskId: message.taskId, attemptId, sessionId: message.sessionId };
      if (message.type === 'swarm-slice') this.keys(message);
      const controller = new SwarmController({
        initial: message,
        runtime: this.runtime,
        sendControl: (control) => {
          const outgoing = this.scoped(control as object);
          void this.enqueue({
            kind: 'control',
            message: (control as any).type === 'swarm-ready'
              ? { ...outgoing, peerReady: false }
              : outgoing,
          });
        },
        sendFrame: (frame) => {
          this.outgoing = this.outgoing.then(async () => {
            if (!this.outboundKey || this.chainLength < 2) throw new Error('missing swarm hop key');
            const signed = new Uint8Array(
              await signSwarmEnvelope(this.outboundKey, this.initial!.sessionId, frame),
            );
            // Avoid spread on large frames (engine dimensions are model-defined).
            let binary = '';
            for (const byte of signed) binary += String.fromCharCode(byte);
            await this.output({ kind: 'frame', data: btoa(binary) });
            this.pendingFrames = Math.max(0, this.pendingFrames - 1);
          });
        },
        emitToken: (token) =>
          this.enqueue({ kind: 'control', message: this.scoped({ type: 'progress', token }) }),
        onDone: (result) => {
          this.settled = true;
          void this.enqueue({
            kind: 'control',
            message: this.scoped({ type: 'result', payload: result }),
          })
            .then(() => this.output({ kind: 'done' }));
        },
        onError: () => {
          this.settled = true;
          // Do not forward model URLs, engine errors or local paths to the server.
          void this.enqueue({
            kind: 'control',
            message: this.scoped({ type: 'error', error: 'SWARM_EXECUTION_FAILED' }),
          })
            .then(() => this.output({ kind: 'done' }));
        },
      });
      this.controller = controller;
      await controller.start();
      return;
    }
    if (
      message.taskId !== this.initial.taskId ||
      (message as unknown as Record<string, unknown>).attemptId !== this.initial.attemptId ||
      message.sessionId !== this.initial.sessionId
    ) return;
    if (message.type === 'swarm-slice') this.keys(message);
    // Starting generation must not block stdin processing: returned frames and
    // flow-resume messages drive the generation promise itself.
    void this.controller?.handleControl(message);
  }

  private keys(message: any): void {
    this.inboundKey = message.inboundKey;
    this.outboundKey = message.outboundKey;
    this.chainLength = message.chainLength;
  }
}
