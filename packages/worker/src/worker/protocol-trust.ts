export const PROTOCOL_FAULT_WINDOW_MS = 10 * 60_000;
export const PROTOCOL_QUARANTINE_MS = 10 * 60_000;
export const PROTOCOL_QUARANTINE_THRESHOLD = 3;
export const MAX_PROTOCOL_FAULTS_PER_NODE = 8;
export const MAX_TRACKED_PROTOCOL_NODES = 512;

export type ProtocolViolationKind = 'invalid-swarm-plan' | 'incomplete-swarm-plan';

export interface ProtocolFault {
  at: number;
  kind: ProtocolViolationKind;
}

export interface NodeProtocolTrust {
  faults: ProtocolFault[];
  quarantineUntil: number;
  lastFaultAt: number;
}

export type ProtocolTrustState = Record<string, NodeProtocolTrust>;

function cleanState(state: ProtocolTrustState | undefined, now: number): ProtocolTrustState {
  const cleaned: ProtocolTrustState = {};
  for (const [nodeId, value] of Object.entries(state ?? {}).slice(0, MAX_TRACKED_PROTOCOL_NODES * 2)) {
    if (!nodeId || nodeId.length > 128 || !value || !Array.isArray(value.faults)) continue;
    const faults = value.faults
      .filter((fault): fault is ProtocolFault => !!fault && Number.isFinite(fault.at) && fault.at <= now &&
        now - fault.at <= PROTOCOL_FAULT_WINDOW_MS &&
        (fault.kind === 'invalid-swarm-plan' || fault.kind === 'incomplete-swarm-plan'))
      .slice(-MAX_PROTOCOL_FAULTS_PER_NODE);
    const quarantineUntil = Number.isFinite(value.quarantineUntil) && value.quarantineUntil > now
      ? value.quarantineUntil
      : 0;
    if (!faults.length && !quarantineUntil) continue;
    cleaned[nodeId] = {
      faults,
      quarantineUntil,
      lastFaultAt: faults.length ? faults[faults.length - 1].at : Math.min(now, value.lastFaultAt || now),
    };
  }
  return cleaned;
}

export function isNodeProtocolQuarantined(state: ProtocolTrustState | undefined, nodeId: string, now: number): boolean {
  return !!cleanState(state, now)[nodeId]?.quarantineUntil;
}

/** Record only after the Coordinator has authenticated the current task/session/attempt. */
export function recordProtocolViolation(
  current: ProtocolTrustState | undefined,
  nodeId: string,
  kind: ProtocolViolationKind,
  now: number,
): { state: ProtocolTrustState; faultCount: number; quarantineUntil: number | null } {
  if (!nodeId || nodeId.length > 128 || !Number.isFinite(now)) {
    return { state: cleanState(current, now), faultCount: 0, quarantineUntil: null };
  }
  const state = cleanState(current, now);
  const entry = state[nodeId] ?? { faults: [], quarantineUntil: 0, lastFaultAt: now };
  const faults = [...entry.faults, { at: now, kind }].slice(-MAX_PROTOCOL_FAULTS_PER_NODE);
  const quarantineUntil = faults.length >= PROTOCOL_QUARANTINE_THRESHOLD
    ? Math.max(entry.quarantineUntil, now + PROTOCOL_QUARANTINE_MS)
    : entry.quarantineUntil;
  state[nodeId] = { faults, quarantineUntil, lastFaultAt: now };

  const entries = Object.entries(state);
  if (entries.length > MAX_TRACKED_PROTOCOL_NODES) {
    entries.sort((a, b) => Number(a[1].quarantineUntil > now) - Number(b[1].quarantineUntil > now) ||
      a[1].lastFaultAt - b[1].lastFaultAt);
    for (const [id] of entries.slice(0, entries.length - MAX_TRACKED_PROTOCOL_NODES)) delete state[id];
  }
  return { state, faultCount: faults.length, quarantineUntil: quarantineUntil > now ? quarantineUntil : null };
}
