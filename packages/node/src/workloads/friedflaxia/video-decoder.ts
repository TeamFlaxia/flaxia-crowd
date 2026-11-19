/**
 * MP4 video frame extraction for the browser node worker.
 *
 * `<video>`/`document` are unavailable in a Worker, so this module demuxes
 * MP4 with mp4box.js and decodes frames with WebCodecs. MP4 is the common
 * upload format for the Crowd vectors; unsupported containers fail closed.
 */

import { DataStream, Endianness, createFile, type Sample } from 'mp4box';
const DECODE_TIMEOUT_MS = 20_000;
const MAX_VIDEO_FRAMES = 16;

export interface DecodedVideo {
  frames: ImageBitmap[];
  duration: number;
  width: number;
  height: number;
}

type DecoderCtor = new (init: {
  output: (frame: any) => void;
  error: (error: Error) => void;
}) => {
  configure(config: Record<string, unknown>): void;
  decode(chunk: any): void;
  flush(): Promise<void>;
  close(): void;
  decodeQueueSize: number;
};

type ChunkCtor = new (init: {
  type: 'key' | 'delta';
  timestamp: number;
  duration?: number;
  data: Uint8Array;
}) => unknown;

function codecDescription(file: ReturnType<typeof createFile>, trackId: number): Uint8Array | undefined {
  const trak = file.getTrackById(trackId) as any;
  const entry = trak?.mdia?.minf?.stbl?.stsd?.entries?.[0];
  const box = entry?.avcC ?? entry?.hvcC ?? entry?.vvcC ?? entry?.av1C ?? entry?.vpcC;
  if (!box || typeof box.write !== 'function') return undefined;
  const stream = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
  box.write(stream);
  // Skip the 8-byte box header; WebCodecs wants the configuration payload.
  return new Uint8Array(stream.buffer, 8);
}

async function videoFrameBitmap(frame: any): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(frame);
  } catch {
    const width = frame.displayWidth || frame.codedWidth;
    const height = frame.displayHeight || frame.codedHeight;
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('vector-embed: no 2d canvas context for video frame');
    context.drawImage(frame, 0, 0);
    return canvas.transferToImageBitmap();
  }
}

function sampleTimes(duration: number, count: number): number[] {
  if (duration <= 0 || count <= 1) return [0];
  const step = duration / (count - 1);
  return Array.from({ length: count }, (_, index) => Math.min(duration, index * step));
}

/**
 * Decode at most `MAX_VIDEO_FRAMES` frames, evenly spaced over
 * the clip. Throws for non-MP4 input or when WebCodecs is unavailable.
 */
export async function decodeVideoFrames(bytes: Uint8Array): Promise<DecodedVideo> {
  const VideoDecoderCtor = (globalThis as any).VideoDecoder as DecoderCtor | undefined;
  const EncodedVideoChunkCtor = (globalThis as any).EncodedVideoChunk as ChunkCtor | undefined;
  if (!VideoDecoderCtor || !EncodedVideoChunkCtor) {
    throw new Error('vector-embed: WebCodecs VideoDecoder is not available');
  }

  const file = createFile();
  const samples: Sample[] = [];
  let trackId = -1;
  let timescale = 1;
  let duration = 0;
  let width = 0;
  let height = 0;
  let codec = '';
  let description: Uint8Array | undefined;
  let expectedSamples = Number.POSITIVE_INFINITY;
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  let resolveSamples!: () => void;
  let rejectSamples!: (error: Error) => void;
  const samplesReady = new Promise<void>((resolve, reject) => {
    resolveSamples = resolve;
    rejectSamples = reject;
  });

  file.onError = (module, message) => {
    rejectSamples(new Error(`vector-embed: MP4 parse failed (${module}): ${message}`));
  };

  file.onReady = (info) => {
    const track = info.videoTracks[0];
    if (!track) {
      rejectSamples(new Error('vector-embed: video has no video track'));
      return;
    }
    trackId = track.id;
    timescale = track.timescale || info.timescale || 1;
    duration = (track.duration || info.duration || 0) / timescale;
    width = track.video?.width ?? track.track_width ?? 0;
    height = track.video?.height ?? track.track_height ?? 0;
    codec = track.codec;
    expectedSamples = track.nb_samples || Number.POSITIVE_INFINITY;
    description = codecDescription(file, track.id);
    file.setExtractionOptions(track.id, null, {
      nbSamples: Math.max(1, Math.min(track.nb_samples || 1024, 4096)),
    });
    file.start();
    // Fragmented MP4s do not report nb_samples up front; resolve once the
    // extractor has had a chance to deliver samples.
    fallbackTimer = setTimeout(() => {
      if (samples.length > 0) resolveSamples();
    }, 2_000);
  };

  file.onSamples = (_id, _user, incoming) => {
    samples.push(...incoming);
    if (samples.length >= expectedSamples) {
      if (fallbackTimer !== null) clearTimeout(fallbackTimer);
      resolveSamples();
      return;
    }
    // Fragmented files report no total. Treat a quiet extractor as done.
    if (fallbackTimer !== null) clearTimeout(fallbackTimer);
    fallbackTimer = setTimeout(() => {
      if (samples.length > 0) resolveSamples();
    }, 500);
  };

  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer & { fileStart: number };
  buffer.fileStart = 0;
  try {
    file.appendBuffer(buffer as any, true);
    file.flush();
    await Promise.race([
      samplesReady,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('vector-embed: MP4 extraction timed out')), DECODE_TIMEOUT_MS),
      ),
    ]);
  } catch (error) {
    try {
      file.stop();
    } catch {}
    throw error;
  }

  if (trackId < 0 || samples.length === 0) {
    throw new Error('vector-embed: video contains no decodable samples');
  }

  const targets = sampleTimes(duration, MAX_VIDEO_FRAMES);
  let targetIndex = 0;
  const captured: Array<Promise<ImageBitmap>> = [];
  let decodeError: Error | null = null;

  const decoder = new VideoDecoderCtor({
    output: (frame: any) => {
      const seconds = frame.timestamp / 1_000_000;
      let selected = false;
      while (targetIndex < targets.length && seconds + 0.05 >= targets[targetIndex]) {
        targetIndex += 1;
        selected = true;
      }
      if (selected) {
        captured.push(
          videoFrameBitmap(frame).finally(() => frame.close()),
        );
      } else {
        frame.close();
      }
    },
    error: (error) => {
      decodeError = error;
    },
  });

  try {
    decoder.configure({
      codec,
      codedWidth: width || undefined,
      codedHeight: height || undefined,
      description,
      optimizeForLatency: true,
    });
  } catch (error) {
    decoder.close();
    throw error;
  }

  try {
    for (const sample of samples) {
      if (decodeError) break;
      if (!sample.data) continue;
      while (decoder.decodeQueueSize > 32) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      decoder.decode(
        new EncodedVideoChunkCtor({
          type: sample.is_sync ? 'key' : 'delta',
          timestamp: Math.round((sample.cts / timescale) * 1_000_000),
          duration: Math.round((sample.duration / timescale) * 1_000_000),
          data: sample.data,
        }),
      );
    }
    await decoder.flush();
  } finally {
    decoder.close();
  }
  if (decodeError) throw decodeError;

  const frames = (await Promise.all(captured)).filter((frame) => frame.width > 0);
  if (frames.length === 0) {
    throw new Error('vector-embed: video decoder produced no frames');
  }
  return { frames, duration, width, height };
}
