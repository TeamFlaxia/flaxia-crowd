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
  private queue: Array<() => void> = [];
  private active: ActiveTask | null = null;
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
    config?: { maxCpuLoad?: number },
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.worker) {
        reject(new Error('Worker not available'));
        return;
      }
      const job = () => this.execute(id, workload, payload, timeoutMs, onToken, config, resolve, reject);
      if (!this.active) {
        job();
      } else {
        log(`task queued id=${id} workload=${workload} (active task running)`);
        this.queue.push(job);
      }
    });
  }

  private execute(
    id: string,
    workload: WorkloadType,
    payload: unknown,
    timeoutMs: number | undefined,
    onToken: ((token: string) => void) | undefined,
    config: { maxCpuLoad?: number } | undefined,
    resolve: (value: unknown) => void,
    reject: (error: Error) => void,
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
    } catch (err) {
      settle(() => reject(err instanceof Error ? err : new Error(String(err))));
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
    if (next) next();
  }

  private cleanupWorker() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.initWorker();
  }

  terminate() {
    this.queue = [];
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
