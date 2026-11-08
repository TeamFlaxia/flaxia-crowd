import test from "node:test";
import assert from "node:assert/strict";
import {
  CACHE_ROOT,
  DEFAULT_CACHE,
  PINNED_MODEL_URL,
  resolveRealSpikeOptions,
} from "./real-options.mjs";

test("uses the pinned model and cache defaults", () => {
  assert.deepEqual(resolveRealSpikeOptions(), {
    modelUrl: PINNED_MODEL_URL,
    cachePath: DEFAULT_CACHE,
  });
});

test("allows cache files only below the scoped temporary directory", () => {
  assert.equal(
    resolveRealSpikeOptions(undefined, `${CACHE_ROOT}/models/qwen.gguf`).cachePath,
    `${CACHE_ROOT}/models/qwen.gguf`,
  );
  assert.throws(() => resolveRealSpikeOptions(undefined, "/tmp/other/model.gguf"), /inside/);
  assert.throws(() => resolveRealSpikeOptions(undefined, `${CACHE_ROOT}/../outside.gguf`), /inside/);
});

test("rejects URLs outside the pinned model registry entry", () => {
  assert.throws(() => resolveRealSpikeOptions("http://127.0.0.1/model.gguf"), /pinned/);
  assert.throws(() => resolveRealSpikeOptions(`${PINNED_MODEL_URL}?redirect=1`), /pinned/);
});
