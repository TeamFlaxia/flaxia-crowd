export interface MobileLifecycleSignals {
  hidden: boolean;
  pageHidden: boolean;
  online: boolean;
  batteryLevel?: number;
  batteryCharging?: boolean;
  effectiveType?: string;
  saveData?: boolean;
}

export interface MobileLifecycleDecision {
  suspend: boolean;
  constrained: boolean;
  maxCpuLoad?: number;
}

const LOW_BATTERY_LEVEL = 0.25;
const CRITICAL_BATTERY_LEVEL = 0.08;
const CONSERVATIVE_MAX_CPU_LOAD = 0.45;

/**
 * Convert optional browser lifecycle, network, and battery signals into a
 * bounded execution policy. Missing Battery/Network Information APIs are safe.
 */
export function evaluateMobileLifecycle(
  signals: MobileLifecycleSignals,
  configuredMaxCpuLoad?: number,
): MobileLifecycleDecision {
  const onBattery = signals.batteryCharging === false;
  const batteryLow = onBattery && typeof signals.batteryLevel === 'number' &&
    signals.batteryLevel <= LOW_BATTERY_LEVEL;
  const batteryCritical = onBattery && typeof signals.batteryLevel === 'number' &&
    signals.batteryLevel <= CRITICAL_BATTERY_LEVEL;
  const slowNetwork = signals.effectiveType === 'slow-2g' || signals.effectiveType === '2g';
  const constrained = batteryLow || slowNetwork || signals.saveData === true;

  return {
    suspend: signals.hidden || signals.pageHidden || !signals.online || batteryCritical,
    constrained,
    maxCpuLoad: constrained
      ? Math.min(configuredMaxCpuLoad ?? CONSERVATIVE_MAX_CPU_LOAD, CONSERVATIVE_MAX_CPU_LOAD)
      : configuredMaxCpuLoad,
  };
}
