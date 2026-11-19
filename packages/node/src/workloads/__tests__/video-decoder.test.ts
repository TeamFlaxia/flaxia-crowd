import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeVideoFrames } from '../friedflaxia/video-decoder';

const fixture = join(__dirname, 'fixtures', 'flower.mp4');

class FakeVideoDecoder {
  static instances: FakeVideoDecoder[] = [];
  private output: (frame: any) => void;
  private error: (error: Error) => void;
  decodeQueueSize = 0;
  config: Record<string, unknown> | null = null;

  constructor(init: { output: (frame: any) => void; error: (error: Error) => void }) {
    this.output = init.output;
    this.error = init.error;
    FakeVideoDecoder.instances.push(this);
  }

  configure(config: Record<string, unknown>) {
    this.config = config;
  }

  decode(chunk: { timestamp: number }) {
    this.output({ timestamp: chunk.timestamp, close: () => {} });
  }

  async flush() {}
  close() {}
}

class FakeChunk {
  timestamp: number;
  constructor(init: Record<string, any>) {
    this.timestamp = init.timestamp;
  }
}

describe('MP4 video frame extraction', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeVideoDecoder.instances = [];
  });

  it('demuxes MP4 and selects at most 16 evenly spaced frames', async () => {
    vi.stubGlobal('VideoDecoder', FakeVideoDecoder);
    vi.stubGlobal('EncodedVideoChunk', FakeChunk);
    vi.stubGlobal('createImageBitmap', async () => ({ width: 320, height: 180, close: () => {} }));
    const bytes = new Uint8Array(readFileSync(fixture));
    const decoded = await decodeVideoFrames(bytes);
    expect(decoded.frames.length).toBeGreaterThan(0);
    expect(decoded.frames.length).toBeLessThanOrEqual(16);
    expect(decoded.duration).toBeGreaterThan(0);
    expect(FakeVideoDecoder.instances[0].config?.codec).toMatch(/^avc1/);
  });
});
