import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildNodeSignalProtocols, parseBearerSubprotocol, NODE_SIGNAL_PROTOCOL } from '../handshake';
import type { ImageProcessPayload, NodeRegisterRequest } from '../types';

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

const imageFixture = JSON.parse(readFileSync(new URL('../../../node-native/tests/fixtures/image-process.json', import.meta.url), 'utf8'));

it('shares the image payload used by the SDK -> worker -> native integration', () => {
  const payload: ImageProcessPayload = {
    operation: 'resize', imageBase64: imageFixture.payload.imageBase64, mimeType: 'image/png',
    options: { width: 1, height: 1, outputFormat: 'png' },
  };
  expect(imageFixture.payload).toEqual(payload);
  expect(Buffer.from(payload.imageBase64, 'base64').length).toBe(imageFixture.expected.originalSizeBytes);
});
