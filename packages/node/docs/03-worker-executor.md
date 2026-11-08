# 03. WebWorkerでの処理実行

## 概要

実際の処理はメインスレッドをブロックしないよう、すべて**WebWorker内**で実行する。
メインスレッドはSignaling・UI・CPU監視のみ担当する。

## WorkerPool 設計

```typescript
class WorkerPool {
  private worker: Worker | null = null

  async run(workload: WorkloadType, payload: unknown): Promise<unknown>
  terminate(): void
}
```

Phase 1では並列実行はしない（1ノード1タスク）。
Workerは1つだけ起動し、タスクが来るたびにメッセージを送る。

## Worker内部の構造

```
src/worker/main.worker.ts
  ↓ 動的import
src/workloads/ai-inference.ts   （Transformer.js）
src/workloads/image-process.ts  （OffscreenCanvas）
src/workloads/file-convert.ts   （WASM）
```

## メッセージプロトコル（メインスレッド ↔ Worker）

### メインスレッド → Worker

```typescript
type WorkerRequest = {
  id: string            // リクエストID（タスクIDと同じ）
  workload: WorkloadType
  payload: unknown
  timeoutMs: number
}
```

### Worker → メインスレッド

```typescript
type WorkerResponse =
  | { id: string; type: 'progress'; percent: number }
  | { id: string; type: 'done'; result: unknown; processingMs: number }
  | { id: string; type: 'error'; error: string }
```

## タイムアウト処理

```typescript
// WorkerPool.run() 内
const timeoutId = setTimeout(() => {
  this.worker?.terminate()
  this.worker = null
  reject(new Error('TIMEOUT'))
}, payload.timeoutMs)
```

タイムアウト時はWorkerをterminateして再生成する。

## Viteでのビルド設定

```typescript
// vite.config.ts
import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.ts',
      formats: ['es', 'umd'],
    },
    rollupOptions: {
      // Worker用エントリーを別チャンクに分離
      input: {
        index: 'src/index.ts',
        worker: 'src/worker/main.worker.ts',
      }
    }
  }
})
```

WorkerのURLは `new Worker(new URL('./worker/main.worker.ts', import.meta.url))` で参照する。
Viteがworkerを自動的に別バンドルに分離してくれる。
# ストリーミング時のバッファ上限

- 通常の`TextStreamer`経路は非同期token sinkの待ち行列を64件・256K文字に制限する。
  生成APIが同期コールバックしか提供しないため、上限を超えるほどsinkが遅れた場合は
  生成を中断してメモリ増加を防ぐ。
- Swarmのactivationは各トークンにつき1往復を完了してから次を生成する。完全な
  activation envelopeは最大8 MiB。DataChannelは16 KiBずつ送信し、送信待ち量が
  256 KiBを超えたら低水位まで待つ。再構成中のactivationは最大2件。
- 購読者ACKによる停止・再開はSwarmではトークン境界に伝播する。通常の生成では
  token sinkを停止し、上限に達した場合は前述の中断契約を適用する。
