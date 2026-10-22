#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { parseJsonLines, summarizeSamples } from './metrics.mjs';

const path = process.argv[2];
if (!path) {
  console.error('Usage: node scripts/benchmarks/summarize.mjs <samples.jsonl>');
  process.exit(2);
}

try {
  const samples = parseJsonLines(await readFile(path, 'utf8'));
  console.log(JSON.stringify({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    inputSamples: samples.length,
    groups: summarizeSamples(samples),
  }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
