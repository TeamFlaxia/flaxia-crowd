import { describe, it, expect } from 'vitest';
import {
  BEARER_SUBPROTOCOL_PREFIX,
  MAX_BEARER_TOKEN_CHARS,
  NODE_SIGNAL_PROTOCOL,
  SUBSCRIBE_PROTOCOL,
  buildNodeSignalProtocols,
  buildSubscribeProtocols,
  buildWsUrl,
  parseBearerSubprotocol,
} from '../handshake';

describe('WebSocket subprotocol handshake', () => {
  it('offers the named protocol plus one bearer entry', () => {
    expect(buildNodeSignalProtocols('tok')).toEqual([NODE_SIGNAL_PROTOCOL, 'bearer.tok']);
    expect(buildSubscribeProtocols('tok')).toEqual([SUBSCRIBE_PROTOCOL, 'bearer.tok']);
    expect(BEARER_SUBPROTOCOL_PREFIX).toBe('bearer.');
  });

  it('round-trips a token through the header', () => {
    const header = buildNodeSignalProtocols('node-token').join(', ');
    expect(parseBearerSubprotocol(header, NODE_SIGNAL_PROTOCOL)).toEqual({
      protocol: NODE_SIGNAL_PROTOCOL,
      token: 'node-token',
    });
  });

  it('accepts a differently ordered header', () => {
    expect(parseBearerSubprotocol(`bearer.tok, ${NODE_SIGNAL_PROTOCOL}`, NODE_SIGNAL_PROTOCOL))
      .toEqual({ protocol: NODE_SIGNAL_PROTOCOL, token: 'tok' });
  });

  it('rejects a header without the expected protocol or bearer entry', () => {
    expect(parseBearerSubprotocol(null, NODE_SIGNAL_PROTOCOL)).toBeNull();
    expect(parseBearerSubprotocol('', NODE_SIGNAL_PROTOCOL)).toBeNull();
    expect(parseBearerSubprotocol('bearer.tok', NODE_SIGNAL_PROTOCOL)).toBeNull();
    expect(parseBearerSubprotocol(NODE_SIGNAL_PROTOCOL, NODE_SIGNAL_PROTOCOL)).toBeNull();
    expect(parseBearerSubprotocol(`${NODE_SIGNAL_PROTOCOL}, bearer.`, NODE_SIGNAL_PROTOCOL)).toBeNull();
  });

  it('rejects duplicate, unexpected or oversized entries', () => {
    // A duplicate bearer entry would make the token ambiguous.
    expect(parseBearerSubprotocol(`${NODE_SIGNAL_PROTOCOL}, bearer.a, bearer.b`, NODE_SIGNAL_PROTOCOL)).toBeNull();
    expect(parseBearerSubprotocol(`${NODE_SIGNAL_PROTOCOL}, bearer.a, other-v1`, NODE_SIGNAL_PROTOCOL)).toBeNull();
    const huge = `${NODE_SIGNAL_PROTOCOL}, bearer.${'x'.repeat(MAX_BEARER_TOKEN_CHARS + 1)}`;
    expect(parseBearerSubprotocol(huge, NODE_SIGNAL_PROTOCOL)).toBeNull();
  });

  it('does not confuse the node and subscribe protocols', () => {
    const header = buildNodeSignalProtocols('tok').join(', ');
    expect(parseBearerSubprotocol(header, SUBSCRIBE_PROTOCOL)).toBeNull();
  });

  it('builds ws URLs from either base form', () => {
    expect(buildWsUrl('https://api.flaxia.crowd', '/crowd/subscribe', { taskId: 't1' }))
      .toBe('wss://api.flaxia.crowd/crowd/subscribe?taskId=t1');
    expect(buildWsUrl('http://localhost:8787/', 'crowd/signal'))
      .toBe('ws://localhost:8787/crowd/signal');
    expect(buildWsUrl('https://host', '/crowd/subscribe', { taskId: 't1', missing: undefined }))
      .toBe('wss://host/crowd/subscribe?taskId=t1');
  });
});