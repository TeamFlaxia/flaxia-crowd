import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ORCHESTRATOR_URL_STORAGE_KEY,
  getAllowedOrchestratorOrigins,
  parseOrchestratorOrigin,
  resolveOrchestratorUrl,
} from '../orchestrator';

describe('parseOrchestratorOrigin', () => {
  it('accepts a bare https origin', () => {
    expect(parseOrchestratorOrigin('https://orchestrator.example')).toBe('https://orchestrator.example');
  });

  it('accepts a bare http origin (local development)', () => {
    expect(parseOrchestratorOrigin('http://localhost:8787')).toBe('http://localhost:8787');
  });

  it('trims surrounding whitespace', () => {
    expect(parseOrchestratorOrigin('  https://orchestrator.example  ')).toBe('https://orchestrator.example');
  });

  it('normalizes to the origin', () => {
    expect(parseOrchestratorOrigin('https://orchestrator.example:443')).toBe('https://orchestrator.example');
  });

  it.each([
    ['', 'empty string'],
    [null, 'null'],
    [undefined, 'undefined'],
    ['not a url', 'garbage'],
    ['ftp://orchestrator.example', 'non-http scheme'],
    ['javascript:alert(1)', 'javascript scheme'],
    ['https://user:pass@orchestrator.example', 'embedded credentials'],
    ['https://orchestrator.example/crowd', 'path'],
    ['https://orchestrator.example/?x=1', 'query string'],
    ['https://orchestrator.example/#frag', 'fragment'],
  ])('rejects %s (%s)', (value: string | null | undefined, _label: string) => {
    expect(parseOrchestratorOrigin(value)).toBeNull();
  });
});

describe('getAllowedOrchestratorOrigins', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('is empty by default', () => {
    vi.stubEnv('VITE_ALLOWED_ORCHESTRATOR_ORIGINS', '');
    expect(getAllowedOrchestratorOrigins()).toEqual([]);
  });

  it('parses a comma-separated list and drops invalid entries', () => {
    vi.stubEnv(
      'VITE_ALLOWED_ORCHESTRATOR_ORIGINS',
      ' https://a.example , not-a-url ,http://localhost:8787,https://a.example',
    );
    expect(getAllowedOrchestratorOrigins()).toEqual(['https://a.example', 'http://localhost:8787']);
  });
});

describe('resolveOrchestratorUrl', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('returns null when nothing is configured', () => {
    vi.stubEnv('VITE_ORCHESTRATOR_URL', '');
    vi.stubEnv('VITE_ALLOWED_ORCHESTRATOR_ORIGINS', '');
    expect(resolveOrchestratorUrl()).toBeNull();
  });

  it('uses the build-time URL when no override is stored', () => {
    vi.stubEnv('VITE_ORCHESTRATOR_URL', 'https://orchestrator.example');
    vi.stubEnv('VITE_ALLOWED_ORCHESTRATOR_ORIGINS', '');
    expect(resolveOrchestratorUrl()).toBe('https://orchestrator.example');
  });

  it('returns null for an invalid build-time URL', () => {
    vi.stubEnv('VITE_ORCHESTRATOR_URL', 'https://orchestrator.example/with-a-path');
    vi.stubEnv('VITE_ALLOWED_ORCHESTRATOR_ORIGINS', '');
    expect(resolveOrchestratorUrl()).toBeNull();
  });

  it('ignores a stored override when the allowlist is empty', () => {
    vi.stubEnv('VITE_ORCHESTRATOR_URL', 'https://orchestrator.example');
    vi.stubEnv('VITE_ALLOWED_ORCHESTRATOR_ORIGINS', '');
    localStorage.setItem(ORCHESTRATOR_URL_STORAGE_KEY, 'https://attacker.example');
    expect(resolveOrchestratorUrl()).toBe('https://orchestrator.example');
  });

  it('ignores a stored override that is not allowlisted', () => {
    vi.stubEnv('VITE_ORCHESTRATOR_URL', 'https://orchestrator.example');
    vi.stubEnv('VITE_ALLOWED_ORCHESTRATOR_ORIGINS', 'https://orchestrator.example');
    localStorage.setItem(ORCHESTRATOR_URL_STORAGE_KEY, 'https://attacker.example');
    expect(resolveOrchestratorUrl()).toBe('https://orchestrator.example');
  });

  it('accepts an allowlisted stored override', () => {
    vi.stubEnv('VITE_ORCHESTRATOR_URL', 'https://orchestrator.example');
    vi.stubEnv('VITE_ALLOWED_ORCHESTRATOR_ORIGINS', 'http://localhost:8787');
    localStorage.setItem(ORCHESTRATOR_URL_STORAGE_KEY, 'http://localhost:8787');
    expect(resolveOrchestratorUrl()).toBe('http://localhost:8787');
  });

  it('accepts an allowlisted override even without a build-time URL', () => {
    vi.stubEnv('VITE_ORCHESTRATOR_URL', '');
    vi.stubEnv('VITE_ALLOWED_ORCHESTRATOR_ORIGINS', 'http://localhost:8787');
    localStorage.setItem(ORCHESTRATOR_URL_STORAGE_KEY, 'http://localhost:8787/');
    expect(resolveOrchestratorUrl()).toBe('http://localhost:8787');
  });

  it('ignores an override with a path even when the origin is allowlisted', () => {
    vi.stubEnv('VITE_ORCHESTRATOR_URL', 'https://orchestrator.example');
    vi.stubEnv('VITE_ALLOWED_ORCHESTRATOR_ORIGINS', 'https://orchestrator.example');
    localStorage.setItem(ORCHESTRATOR_URL_STORAGE_KEY, 'https://orchestrator.example/redirect');
    expect(resolveOrchestratorUrl()).toBe('https://orchestrator.example');
  });

  it('warns when it rejects a stored override', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('VITE_ORCHESTRATOR_URL', 'https://orchestrator.example');
    vi.stubEnv('VITE_ALLOWED_ORCHESTRATOR_ORIGINS', '');
    localStorage.setItem(ORCHESTRATOR_URL_STORAGE_KEY, 'https://attacker.example');
    resolveOrchestratorUrl();
    expect(warn).toHaveBeenCalledOnce();
  });
});