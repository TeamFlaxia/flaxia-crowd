#!/usr/bin/env node
/**
 * Browser smoke test for MP4 video frame extraction.
 *
 * CI bundles `video-decoder.ts` with esbuild, serves it with a short CC0 MP4,
 * and runs the real WebCodecs decoder in Chrome. Kept out of the unit suite
 * because Node has no VideoDecoder.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';

const ROOT = resolve('dist-video');
const FIXTURE = resolve('packages/node/src/workloads/__tests__/fixtures/flower.mp4');
const PORT = 4173;

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mp4': 'video/mp4',
};

const server = createServer(async (request, response) => {
  try {
    const path = (request.url ?? '/').split('?')[0];
    if (path === '/flower.mp4') {
      const body = await readFile(FIXTURE);
      response.writeHead(200, { 'content-type': MIME['.mp4'], 'content-length': body.length });
      response.end(body);
      return;
    }
    if (path === '/' || path === '/index.html') {
      response.writeHead(200, { 'content-type': MIME['.html'] });
      response.end('<!doctype html><meta charset="utf-8"><title>video smoke</title>');
      return;
    }
    const name = path.replace(/^\//, '');
    if (!/^[a-z0-9._-]+$/i.test(name)) {
      response.writeHead(404);
      response.end();
      return;
    }
    const body = await readFile(resolve(ROOT, name));
    response.writeHead(200, {
      'content-type': MIME[extname(name)] ?? 'application/octet-stream',
      'content-length': body.length,
    });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end();
  }
});

await new Promise((ready) => server.listen(PORT, '127.0.0.1', ready));
let browser;
try {
  const playwright = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  browser = await playwright.chromium.launch({
    executablePath: process.env.CHROME || '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader'],
  });
  const page = await browser.newPage();
  page.on('console', (message) => console.log(`[page] ${message.text()}`));
  page.on('pageerror', (error) => console.error(`[page] ${error.message}`));
  await page.goto(`http://127.0.0.1:${PORT}/`);
  const result = await page.evaluate(async () => {
    const mod = await import('/video.js');
    const response = await fetch('/flower.mp4');
    const bytes = new Uint8Array(await response.arrayBuffer());
    const decoded = await mod.decodeVideoFrames(bytes);
    const frames = decoded.frames.map((frame) => [frame.width, frame.height]);
    for (const frame of decoded.frames) frame.close();
    return { duration: decoded.duration, width: decoded.width, height: decoded.height, frames };
  });
  console.log(JSON.stringify(result));
  if (!Array.isArray(result.frames) || result.frames.length < 1) {
    throw new Error('video smoke: no decoded frames');
  }
  if (result.frames.length > 16) {
    throw new Error(`video smoke: decoded ${result.frames.length} frames (max 16)`);
  }
  if (!result.frames.every(([width, height]) => width > 0 && height > 0)) {
    throw new Error('video smoke: decoded an empty frame');
  }
} finally {
  if (browser) await browser.close();
  await new Promise((closed) => server.close(closed));
}
