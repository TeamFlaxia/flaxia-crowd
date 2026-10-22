import { describe, expect, it } from 'vitest';
import { resolveOrchestratorUrl } from '../orchestrator-config';

describe('resolveOrchestratorUrl', () => {
  it('accepts an explicitly configured HTTPS origin and normalizes a trailing slash', () => {
    expect(resolveOrchestratorUrl('https://crowd.example.test/', false)).toBe('https://crowd.example.test');
  });

  it('allows loopback HTTP only during development', () => {
    expect(resolveOrchestratorUrl('http://localhost:8787', true)).toBe('http://localhost:8787');
    expect(resolveOrchestratorUrl('http://localhost:8787', false)).toBeNull();
  });

  it.each([
    undefined,
    '',
    'javascript:alert(1)',
    'http://attacker.example',
    'https://user:password@crowd.example.test',
    'https://crowd.example.test/path',
    'https://crowd.example.test/?token=secret',
    'https://crowd.example.test/#fragment',
  ])('rejects invalid coordinator configuration: %s', (value) => {
    expect(resolveOrchestratorUrl(value, false)).toBeNull();
  });
});
