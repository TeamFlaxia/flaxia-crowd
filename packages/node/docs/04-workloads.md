# 04. ワークロード別実装

## Phase 1 対応ワークロード

| workload | 実装方式 | 難易度 | 優先度 |
|----------|---------|--------|--------|
| `ai-inference` | Transformer.js v4 | 低 | 最高 |
| `image-process` | OffscreenCanvas | 低 | 高 |
| `container` | container2wasm | 中 | 中 |
| `file-convert` | WASM (予定) | 高 | Phase 2 |
| `swarm-inference` | WebGPU + レイヤー分割 (pooled) | 高 | Phase 2 |

---

## ai-inference（Transformer.js）

Transformer.js v4 を使用し、WebWorker 内で推論を行う。WebGPU が利用可能な場合は自動的に適用される。

---

## image-process（OffscreenCanvas）

ブラウザ標準の `OffscreenCanvas` を使用して、メインスレッドをブロックせずに高速な画像処理を行う。
リサイズ、グレースケール変換、圧縮などをサポート。

```typescript
// src/workloads/image-process.ts
export async function handleImageProcess(payload: ImageProcessPayload): Promise<ImageProcessResult> {
  // OffscreenCanvas + createImageBitmap による高速処理
}
```

---

## container（container2wasm / Linux Container）

Linux コンテナを WASM 上で実行する汎用ワークロード。`container2wasm` を用いて RISC-V 等のエミュレーションを行う。

```typescript
// src/workloads/container.ts
import { runContainer } from '../executor/container-executor'

export async function handleContainer(payload: ContainerPayload): Promise<ContainerResult> {
  // 指定された WASM イメージ上でコマンドを実行
  return await runContainer(payload)
}
```

**特徴:**
- 既存の Linux ツールをそのまま利用可能（ImageMagick, libvips, ffmpeg等）
- 処理速度はネイティブ WASM に劣るが、柔軟性が極めて高い
- カーネルレベルでの強力なサンドボックス化

---

## ワークロード追加時のルール

1. `packages/sdk/src/types.ts` にペイロードと結果の型を定義
2. `packages/node/src/workloads/` に実装ファイルを追加
3. `packages/node/src/worker/main.worker.ts` の dispatch に追加
4. `WorkloadType` 型（SDK）を更新
