import { evaluateMobileLifecycle } from './mobile-lifecycle';

export interface LightPreloaderOptions {
  /** Model id to keep warm. Defaults to the M2M100 translate model. */
  model?: string;
  task?: string;
  dtype?: string;
  onPreloaded?: () => void;
}

export type PreloadFn = (request: { task: string; model: string; dtype: string }) => Promise<void>;
export type IsPreloadedFn = (model: string) => boolean;

/** Defaults mirror `LIGHT_INFERENCE_TRANSLATE_*` in `ai-inference.ts`. */
export const LIGHT_INFERENCE_TRANSLATE_MODEL = 'Xenova/m2m100_418M';
export const LIGHT_INFERENCE_TRANSLATE_TASK = 'translation';
export const LIGHT_INFERENCE_TRANSLATE_DTYPE = 'q4f16';

/**
 * Light Inference idle preloader.
 *
 * Keeps one small `ai-inference` model resident so a later `ondeviceOnly`
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
  private readonly model: string;
  private readonly task: string;
  private readonly dtype: string;

  constructor(
    private readonly getConsentState: () => string,
    private readonly options: LightPreloaderOptions = {},
    private readonly isPreloaded: IsPreloadedFn = () => false,
    private readonly preload: PreloadFn = async () => {},
  ) {
    this.model = options.model ?? LIGHT_INFERENCE_TRANSLATE_MODEL;
    this.task = options.task ?? LIGHT_INFERENCE_TRANSLATE_TASK;
    this.dtype = options.dtype ?? LIGHT_INFERENCE_TRANSLATE_DTYPE;
  }

  /** Schedule a preload at the next idle moment (no-op when already ready). */
  start(): void {
    if (this.stopped) return;
    if (this.getConsentState() !== 'granted') return;
    if (this.isUnconstrained() === false) return;
    if (this.isPreloaded(this.model)) return;
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

  private async preloadNow(): Promise<void> {
    if (this.stopped || this.preloading) return;
    if (this.getConsentState() !== 'granted') return;
    if (this.isUnconstrained() === false) return;
    if (this.isPreloaded(this.model)) return;
    this.preloading = true;
    try {
      await this.preload({ task: this.task, model: this.model, dtype: this.dtype });
      this.options.onPreloaded?.();
    } catch {
      // Best effort: a failed preload only means ondeviceOnly tasks answer 500.
    } finally {
      this.preloading = false;
    }
  }
}
