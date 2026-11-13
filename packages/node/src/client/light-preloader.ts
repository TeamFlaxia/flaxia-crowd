import { evaluateMobileLifecycle } from './mobile-lifecycle';

export interface LightPreloaderTarget {
  model: string;
  task: string;
  dtype: string;
}

export interface LightPreloaderOptions {
  /** Model id to keep warm. Defaults to the M2M100 translate model. */
  model?: string;
  task?: string;
  dtype?: string;
  /** Full list of models to keep warm; wins over `model`/`task`/`dtype`. */
  targets?: LightPreloaderTarget[];
  onPreloaded?: () => void;
  /**
   * Whether the device has enough memory headroom for a multi-hundred-MB
   * model. Preloading two translate models on a 4 GB phone commits ~1 GiB of
   * wasm memory that the page then cannot reclaim, so the preloader must stay
   * idle on constrained devices. Omitted = always allowed.
   */
  hasMemoryHeadroom?: () => boolean;
}

export type PreloadFn = (request: { task: string; model: string; dtype: string }) => Promise<void>;
/**
 * Check whether one preloader target is already resident. Must compare the
 * full cache identity (model + dtype), not just the model id: the same repo
 * preloaded as int8 does not satisfy a q4f16 ondeviceOnly task.
 */
export type IsPreloadedFn = (target: LightPreloaderTarget) => boolean;

/** Defaults mirror `LIGHT_INFERENCE_TRANSLATE_*` in `ai-inference.ts`. */
export const LIGHT_INFERENCE_TRANSLATE_MODEL = 'Xenova/m2m100_418M';
export const LIGHT_INFERENCE_TRANSLATE_TASK = 'translation';
export const LIGHT_INFERENCE_TRANSLATE_DTYPE = 'q4f16';

/** Flaxia's default translate model, mirroring `LIGHT_INFERENCE_PLAMO_*`. */
export const LIGHT_INFERENCE_PLAMO_TRANSLATE_MODEL = 'TeamFlaxia/plamo-3-translate-0.8b-onnx';
export const LIGHT_INFERENCE_PLAMO_TRANSLATE_TASK = 'text-generation';
export const LIGHT_INFERENCE_PLAMO_TRANSLATE_DTYPE = 'q4f16';

/**
 * Light Inference idle preloader.
 *
 * Keeps the translate `ai-inference` models resident so a later `ondeviceOnly`
 * task can serve instantly from this device. Runs only while the device is
 * online and unconstrained (no low battery / Save-Data / slow-2g). Consent
 * is Crowd's consent: when consent is anything other than `granted` the
 * preloader never runs.
 */
export class LightPreloader {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private idleHandle: number | null = null;
  private preloading = false;
  private stopped = false;
  private readonly targets: LightPreloaderTarget[];

  constructor(
    private readonly getConsentState: () => string,
    private readonly options: LightPreloaderOptions = {},
    private readonly isPreloaded: IsPreloadedFn = () => false,
    private readonly preload: PreloadFn = async () => {},
  ) {
    this.targets = options.targets ?? [
      {
        model: options.model ?? LIGHT_INFERENCE_TRANSLATE_MODEL,
        task: options.task ?? LIGHT_INFERENCE_TRANSLATE_TASK,
        dtype: options.dtype ?? LIGHT_INFERENCE_TRANSLATE_DTYPE,
      },
    ];
  }

  /** Schedule a preload at the next idle moment (no-op when already ready). */
  start(): void {
    if (this.stopped) return;
    if (this.getConsentState() !== 'granted') return;
    if (this.isUnconstrained() === false) return;
    if (!this.hasMemoryHeadroom()) return;
    if (!this.targets.some((target) => !this.isPreloaded(target))) return;
    if (this.preloading) return;

    const run = () => {
      this.idleHandle = null;
      void this.preloadNow();
    };
    if (typeof requestIdleCallback === 'function') {
      this.idleHandle = requestIdleCallback(run, { timeout: 2_000 });
    } else {
      this.timer = setTimeout(run, 1_000);
    }
  }

  /** Cancel any scheduled preload (e.g. on suspend / consent denial). */
  stop(): void {
    this.stopped = true;
    if (this.idleHandle !== null && typeof cancelIdleCallback === 'function') {
      cancelIdleCallback(this.idleHandle);
    }
    if (this.timer) clearTimeout(this.timer);
    this.idleHandle = null;
    this.timer = null;
  }

  private isUnconstrained(): boolean {
    try {
      const nav = navigator as Navigator & {
        connection?: { effectiveType?: string; saveData?: boolean };
      };
      const decision = evaluateMobileLifecycle(
        {
          hidden: document.hidden,
          pageHidden: document.hidden,
          online: navigator.onLine !== false,
          effectiveType: nav.connection?.effectiveType,
          saveData: nav.connection?.saveData,
        },
        undefined,
      );
      return !decision.constrained && !decision.suspend;
    } catch {
      return true;
    }
  }

  private hasMemoryHeadroom(): boolean {
    try {
      return this.options.hasMemoryHeadroom?.() !== false;
    } catch {
      // A throwing memory probe must never crash the client; treat it as
      // "no headroom" so the device stays safe.
      return false;
    }
  }

  private async preloadNow(): Promise<void> {
    if (this.stopped || this.preloading) return;
    if (this.getConsentState() !== 'granted') return;
    if (this.isUnconstrained() === false) return;
    if (!this.hasMemoryHeadroom()) return;
    this.preloading = true;
    try {
      for (const target of this.targets) {
        if (this.stopped || this.getConsentState() !== 'granted') return;
        if (this.isPreloaded(target)) continue;
        try {
          await this.preload({ task: target.task, model: target.model, dtype: target.dtype });
          this.options.onPreloaded?.();
        } catch {
          // Best effort per target: a failed preload only means ondeviceOnly
          // tasks for that model answer 500; keep warming the others.
        }
      }
    } finally {
      this.preloading = false;
    }
  }
}
