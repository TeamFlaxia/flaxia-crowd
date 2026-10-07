import type { WorkloadType } from "@flaxia/sdk";

const log = (...args: unknown[]) => console.log("[flaxia-node]", ...args);

interface ActiveTask {
  id: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  worker: Worker;
  removeListener: () => void;
}

/** A task waiting for the worker, with the handle needed to settle or drop it. */
interface QueuedTask {
  id: string;
  job: () => void;
  reject: (error: Error) => void;
}

/** Swarm tasks exchange control messages and binary frames mid-task. */
export interface SwarmCallbacks {
  onFrame?: (frame: ArrayBuffer) => void;
  onMessage?: (message: unknown) => void;
}

/**
 * Executes tasks against a single Web Worker.
 *
 * Design notes:
 * - Tasks are serialized (1 node = 1 task at a time) so a worker restart on
 *   timeout never destroys another task's execution.
 * - Timeouts are a hard deadline from task start; heartbeats and token
 *   messages do NOT extend them, so a stuck task cannot hold a slot forever.
 * - terminate()/suspend() settles all pending promises and clears timers so a
 *   stale timeout can never kill a freshly resumed worker.
 */
export class WorkerPool {
  private worker: Worker | null = null;
  private defaultTimeoutMs: number;
  private workerUrl: string;
  private queue: QueuedTask[] = [];
  private active: ActiveTask | null = null;
  /** Control messages that arrived for a task that has not started yet. */
  private pendingControls: Array<{ taskId: string; message: unknown }> = [];
  private static readonly MAX_PENDING_CONTROLS = 64;
  private _lastCpuLoad = 0;

  constructor(workerUrl?: string, timeoutMs = 300000) {
    this.workerUrl = workerUrl || '/worker.js';
    this.defaultTimeoutMs = timeoutMs;
    this.initWorker();
  }

  private initWorker() {
    if (typeof Worker === 'undefined') return;
    const worker = new Worker(this.workerUrl, { type: 'module' });
    worker.onerror = (event: ErrorEvent) => {
      this.handleWorkerError(new Error(event.message || 'Worker error'));
    };
    worker.onmessageerror = () => {
      this.handleWorkerError(new Error('Worker message error'));
    };
    this.worker = worker;
  }

  run(
    id: string,
    workload: WorkloadType,
    payload: unknown,
    timeoutMs?: number,
    onToken?: (token: string) => void,
    config?: { maxCpuLoad?: number; fileSourceOrigins?: string[]; containerImageOrigins?: string[] },
    swarm?: SwarmCallbacks,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.worker) {
        reject(new Error('Worker not available'));
        return;
      }
      const job = () => this.execute(id, workload, payload, timeoutMs, onToken, config, resolve, reject, swarm);
      if (!this.active) {
        job();
      } else {
        log(`task queued id=${id} workload=${workload} (active task running)`);
        this.queue.push({ id, job, reject });
      }
    });
  }

  private execute(
    id: string,
    workload: WorkloadType,
    payload: unknown,
    timeoutMs: number | undefined,
    onToken: ((token: string) => void) | undefined,
    config: { maxCpuLoad?: number; fileSourceOrigins?: string[]; containerImageOrigins?: string[] } | undefined,
    resolve: (value: unknown) => void,
    reject: (error: Error) => void,
    swarm?: SwarmCallbacks,
  ) {
    const worker = this.worker;
    if (!worker) {
      reject(new Error('Worker not available'));
      this.dequeue();
      return;
    }

    const timeout = timeoutMs ?? this.defaultTimeoutMs;
    let settled = false;
    const startedAt = performance.now();
    log(`task start id=${id} workload=${workload} timeoutMs=${timeout}`);

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      const active = this.active;
      if (active) {
        clearTimeout(active.timer);
        active.removeListener();
      }
      this.active = null;
      // Whatever was still queued for this task can never be delivered.
      this.pendingControls = this.pendingControls.filter((c) => c.taskId !== id);
      fn();
      this.dequeue();
    };

    const handleMessage = (event: MessageEvent) => {
      const { id: resId, type, result, error, token, cpuLoad } = event.data;
      if (resId !== id) return;

      if (type === 'token') {
        onToken?.(token);
        return;
      }
      if (type === 'heartbeat') {
        if (typeof cpuLoad === 'number' && Number.isFinite(cpuLoad)) {
          this._lastCpuLoad = Math.min(1, Math.max(0, cpuLoad));
        }
        return;
      }
      if (type === 'swarm-frame') {
        swarm?.onFrame?.(event.data.frame as ArrayBuffer);
        return;
      }
      if (type === 'swarm-message') {
        swarm?.onMessage?.(event.data.message);
        return;
      }
      if (type === 'done') {
        log(`task done id=${id} workload=${workload} durationMs=${Math.round(performance.now() - startedAt)}`);
        settle(() => resolve(result));
      } else if (type === 'error') {
        log(`task failed id=${id} workload=${workload} error=${error}`);
        settle(() => reject(new Error(error)));
      } else {
        log(`task unknown-message id=${id} type=${String(type)}`);
        settle(() => reject(new Error(`Unknown message type: ${String(type)}`)));
      }
    };

    const removeListener = () => worker.removeEventListener('message', handleMessage);

    const timer = setTimeout(() => {
      // Terminate the stuck worker first, then settle. Because tasks are
      // serialized, only this task is affected; queued tasks run on the new worker.
      log(`task timeout id=${id} workload=${workload} (worker terminated after ${timeout}ms)`);
      this.cleanupWorker();
      settle(() => reject(new Error('TIMEOUT')));
    }, timeout);

    this.active = { id, resolve, reject, timer, worker, removeListener };
    worker.addEventListener('message', handleMessage);

    try {
      worker.postMessage({ id, workload, payload, timeoutMs: timeout, config });
      this.flushControls();
    } catch (err) {
      settle(() => reject(err instanceof Error ? err : new Error(String(err))));
    }
  }

  /** Hand over the control messages that were waiting for this task to start. */
  private flushControls() {
    if (this.pendingControls.length === 0) return;
    const mine = this.pendingControls.filter((c) => c.taskId === this.active?.id);
    this.pendingControls = this.pendingControls.filter((c) => c.taskId !== this.active?.id);
    for (const c of mine) this.postToActive({ type: 'swarm-control', message: c.message });
  }

  /**
   * Post a message to the active task's worker. Used by the signaling client to
   * push swarm control messages and hidden-state frames into a running session.
   */
  private postToActive(payload: Record<string, unknown>, transfer?: Transferable[]): boolean {
    if (!this.worker || !this.active) return false;
    try {
      this.worker.postMessage({ id: this.active.id, ...payload }, transfer ?? []);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Deliver a swarm control message to the task it names. A message that
   * arrives while that task is still queued is held until it starts; posting it
   * into whichever task happens to be running would hand it to the wrong
   * session (and drop the intended one).
   */
  sendControl(message: unknown, executionId?: string): boolean {
    const taskId = executionId ?? (message as { taskId?: unknown } | null)?.taskId;
    if (typeof taskId === 'string' && taskId !== this.active?.id) {
      if (!this.worker) return false;
      this.pendingControls.push({ taskId, message });
      if (this.pendingControls.length > WorkerPool.MAX_PENDING_CONTROLS) this.pendingControls.shift();
      return false;
    }
    return this.postToActive({ type: 'swarm-control', message });
  }

  sendFrame(frame: ArrayBuffer): boolean {
    return this.postToActive({ type: 'swarm-frame', frame }, [frame]);
  }

  /**
   * The coordinator settled this task elsewhere (timeout, a peer failed, the
   * plan was rejected): stop it.
   *
   * A queued task is dropped before it ever starts. A running task is asked to
   * stop and the slot is released only when the worker itself reports done or
   * error, so two tasks can never end up in the same worker.
   */
  abort(id: string, reason: string): boolean {
    const queued = this.queue.findIndex((task) => task.id === id);
    if (queued >= 0) {
      const [dropped] = this.queue.splice(queued, 1);
      this.pendingControls = this.pendingControls.filter((c) => c.taskId !== id);
      log(`task aborted before start id=${id} reason=${reason}`);
      dropped.reject(new Error(reason));
      return true;
    }
    if (this.active?.id !== id || !this.worker) return false;
    try {
      this.worker.postMessage({ id, type: 'abort', reason });
      log(`task abort sent id=${id} reason=${reason}`);
      return true;
    } catch {
      return false;
    }
  }

  private handleWorkerError(err: Error) {
    log(`worker error error=${err.message}`);
    const active = this.active;
    this.cleanupWorker();
    if (active) {
      clearTimeout(active.timer);
      this.active = null;
      active.reject(err);
      this.dequeue();
    }
  }

  private dequeue() {
    const next = this.queue.shift();
    if (next) next.job();
  }

  private cleanupWorker() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.initWorker();
  }

  terminate() {
    // Settle queued promises too: a dropped closure would leave its caller
    // awaiting a task that will never run.
    const queued = this.queue;
    this.queue = [];
    this.pendingControls = [];
    for (const task of queued) task.reject(new Error('TERMINATED'));
    if (this.active) {
      clearTimeout(this.active.timer);
      this.active.reject(new Error('TERMINATED'));
      this.active = null;
    }
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }

  resume() {
    if (!this.worker) {
      this.initWorker();
    }
  }

  get lastCpuLoad(): number {
    return this._lastCpuLoad;
  }
}
