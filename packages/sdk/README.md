# @flaxia/sdk

Flaxia Crowd の**タスク依頼者向けSDK**。型定義は全パッケージ（worker・node）の単一の真実の源泉です。

## インストール

```bash
npm install @flaxia/sdk
```

依存関係はゼロ（`fetch` のみ使用）。

## 使い方

```typescript
import { FlaxiaClient } from '@flaxia/sdk'

const client = new FlaxiaClient({
  apiKey: 'fc_live_xxxxxxxxxxxx',
})

const task = await client.submit({
  workload: 'ai-inference',
  payload: {
    task: 'text-classification',
    model: 'Xenova/distilbert-base-uncased-finetuned-sst-2-english',
    input: 'This is amazing!',
  },
})

// 結果をポーリング
const result = await client.waitForTask(task.id)
console.log(result)
```

## API

### FlaxiaClient

| メソッド | 引数 | 戻り値 | 説明 |
|---------|------|--------|------|
| `submit()` | `SubmitTaskOptions` | `Promise<TaskRecord>` | タスクを投入し、即座に taskId を返す |
| `getTask()` | `taskId: string` | `Promise<TaskRecord>` | タスクの状態を取得 |
| `waitForTask()` | `taskId, intervalMs?, timeoutMs?` | `Promise<TaskRecord>` | 完了するまでポーリング（デフォルト: 2s間隔, 60sタイムアウト） |

### 対応ワークロード

| 型 | 説明 |
|----|------|
| `ai-inference` | HuggingFace Transformers.js によるAI推論 |
| `image-process` | OffscreenCanvas を用いた画像処理（resize, grayscale, compress, thumbnail） |
| `file-convert` | ファイル変換（Phase 2） |
| `container` | container2wasm を用いたLinuxコンテナ実行 |

### Error クラス

| クラス | HTTP Status | code |
|--------|------------|------|
| `AuthenticationError` | 401 | `AUTH_ERROR` |
| `TaskNotFoundError` | 404 | `TASK_NOT_FOUND` |
| `ValidationError` | 400 | `VALIDATION_ERROR` |
| `FlaxiaError` | 可変 | 可変（基本クラス） |

## 型定義

`@flaxia/sdk` は以下の型を提供し、`@flaxia/worker` と `@flaxia/node` が参照します:

- `WorkloadType` —  workload 種別のユニオン型
- `AiInferencePayload / AiInferenceResult` — AI推論のペイロード/結果
- `ImageProcessPayload / ImageProcessResult` — 画像処理のペイロード/結果
- `ContainerPayload / ContainerResult` — コンテナ実行のペイロード/結果
- `FileConvertPayload` — ファイル変換のペイロード
- `TaskPayload` — 全ペイロードのユニオン型
- `TaskRecord` — 完全なタスクオブジェクト（状態・結果・エラー等）
- `NodeConfig` — ノード設定（`@flaxia/node` が使用）

## ランタイム契約

型だけでなく、worker / node / ホストで共有すべき**実行時の契約**も `@flaxia/sdk` が単一の真実の源泉として提供します。各パッケージでワークロード一覧や重み判定を再定義しないでください。

```typescript
import {
  WORKLOAD_TYPES,          // プロトコル上の全ワークロード
  ROUTABLE_WORKLOADS,      // オーケストレーターが投入可能な実装済みワークロード
  HEAVY_WORKLOADS,         // 低メモリノードに割り当ててはいけない重い処理
  DEFAULT_WORKLOAD_TIMEOUT_MS,
  isWorkloadType,
  isRoutableWorkload,
  isHeavyWorkload,
  defaultTimeoutFor,
  parseCrowdWebhook,
  extractCallbackOutput,
  buildCallbackUrl,
  callbackTypeFromUrl,
  resolveNsfwTags,
} from '@flaxia/sdk'
```

| ヘルパー | 用途 |
|---------|------|
| `WORKLOAD_TYPES` / `isWorkloadType` | 信頼できない入力の検証 |
| `ROUTABLE_WORKLOADS` / `isRoutableWorkload` | オーケストレーターの投入可否チェック |
| `HEAVY_WORKLOADS` / `isHeavyWorkload` | 低メモリノードへのルーティング抑止 |
| `buildCallbackUrl` / `callbackTypeFromUrl` | ホスト側 Webhook URL の生成・判別 |
| `parseCrowdWebhook` / `extractCallbackOutput` | Webhook ボディの検証と結果抽出 |
| `resolveNsfwTags` | NudeNet 検出結果からコンテンツタグへの変換 |

`moe-inference` はプロトコル型として宣言済みですが、ノード実装が無いため `ROUTABLE_WORKLOADS` には含まれません。`swarm-inference` は複数ノードでモデルのレイヤーを分割して1件の生成ジョブを処理するワークロードで、WebGPU と（`NodeConfig.allowModelDownload` による）モデル重みのダウンロード同意が前提です。
