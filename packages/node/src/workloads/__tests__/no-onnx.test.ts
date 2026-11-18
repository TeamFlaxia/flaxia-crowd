import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');

function sources(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) out.push(...sources(path));
    else if (path.endsWith('.ts') && !path.endsWith('.test.ts')) out.push(path);
  }
  return out;
}

describe('ONNX removal guard', () => {
  it('has no ONNX runtime or Transformers.js imports', () => {
    const offenders = sources(ROOT).filter((file) => {
      const text = readFileSync(file, 'utf8');
      return /from ['"](onnxruntime-web|@huggingface\/transformers)['"]/.test(text);
    });
    expect(offenders).toEqual([]);
  });
});
