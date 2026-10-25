// Stream the shared real-model fixture to disk; cache hits are verified too.
import { createWriteStream } from 'node:fs';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GENERATION_BASELINE, verifyGenerationModel } from './generation-baseline.mjs';
import { DEFAULT_CACHE } from './real-options.mjs';

export async function prepareGenerationModel(file, fetchModel = fetch) {
  const destination = path.resolve(file);
  try {
    await stat(destination);
    await verifyGenerationModel(destination);
    return destination;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.download-${randomUUID()}`;
  try {
    const response = await fetchModel(GENERATION_BASELINE.modelUrl, {
      signal: AbortSignal.timeout(600000),
    });
    if (!response.ok || !response.body) {
      throw new Error(`Model download failed: HTTP ${response.status}`);
    }
    let received = 0;
    const bounded = new Transform({
      transform(chunk, encoding, callback) {
        received += chunk.length;
        callback(
          received > GENERATION_BASELINE.bytes
            ? new Error('Model download exceeds baseline size')
            : null,
          chunk,
        );
      },
    });
    await pipeline(
      Readable.fromWeb(response.body),
      bounded,
      createWriteStream(temporary, { flags: 'wx' }),
    );
    await verifyGenerationModel(temporary);
    await rename(temporary, destination);
    return destination;
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = await prepareGenerationModel(process.argv[2] ?? process.env.MODEL ?? DEFAULT_CACHE);
  console.log(`Verified ${GENERATION_BASELINE.name} ${GENERATION_BASELINE.quantization}: ${file}`);
}
