import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildNodeSignalProtocols, parseBearerSubprotocol, NODE_SIGNAL_PROTOCOL } from '../handshake';
import type { NodeRegisterRequest } from '../types';

// This fixture is exercised over HTTP/WebSocket by the Rust integration tests.
const fixture = JSON.parse(readFileSync(new URL('../../../node-native/tests/fixtures/signaling.json', import.meta.url), 'utf8'));

describe('native node signaling contract', () => {
  it('uses SDK-compatible registration and bearer subprotocols', () => {
    const request: NodeRegisterRequest = { siteId: 'native-test', capabilities: [], fileSources: false };
    expect(fixture.registrationRequest).toEqual(request);
    expect(fixture.protocols).toEqual(buildNodeSignalProtocols('test-token'));
    expect(parseBearerSubprotocol(fixture.protocols.join(', '), NODE_SIGNAL_PROTOCOL))
      .toEqual({ protocol: NODE_SIGNAL_PROTOCOL, token: 'test-token' });
    expect(fixture.pong).toEqual({ type: 'pong', cpuLoad: null });
  });
});
