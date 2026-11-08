# 依頼者向けSDKガイド (@flaxia/sdk)

タスクの投入から結果取得までを行うためのクライアントライブラリです。

## クライアント初期化

```typescript
import { FlaxiaClient } from '@flaxia/sdk'

const client = new FlaxiaClient({
  apiKey: process.env.FLAXIA_API_KEY,
  // オプション: APIエンドポイント変更など
})
```

## タスク投入 (submit)

`submit()` はタスクを作成して `taskId` を返します。結果は `waitForTask()` で待つか、`callbackUrl`（Webhook）で受け取ります。

```typescript
const { taskId } = await client.submit({
  workload: 'ai-inference',
  payload: {
    task: 'sentiment-analysis',
    model: 'Xenova/distilbert-base-uncased-finetuned-sst-2-english',
    input: 'Great product!',
  },
})

const task = await client.waitForTask(taskId, 2000, 60_000)
if (task.status === 'done') {
  console.log(task.result)
}
```

## Webhook で結果を受け取る

```typescript
await client.submit({
  workload: 'image-process',
  payload: { /*...*/ },
  callbackUrl: 'https://api.your-service.com/webhook/flaxia',
})
```

## エラーハンドリング
- `FlaxiaTimeoutError`: タイムアウトが発生した場合
- `FlaxiaValidationError`: パラメータが不正な場合

## Common Crawl 抽出 (cc-extract)

CDX インデックスで見つけた WARC レコードを、ボランティアノードに取得・抽出させる workload です。
1タスクあたり最大3レコード、合計4MiBまでです。

```typescript
const { taskId } = await client.submit({
  workload: 'cc-extract',
  payload: {
    crawl: 'CC-MAIN-2026-43',
    records: [
      {
        url: 'https://example.com/article',
        warcFilename:
          'crawl-data/CC-MAIN-2026-43/segments/1700000000000.0/warc/CC-MAIN-20260101000000-20260101010000-00000.warc.gz',
        offset: 1024,
        length: 16384,
        // ブラウザノードは Range ヘッダー付きの cross-origin fetch を
        // 直接読めないため、ホスト側の署名付き range proxy を指定します。
        // ノードは ccRangeOrigins に含まれる origin だけを許可します。
        fetchUrl: 'https://flaxia.app/api/crowd/cc-range?...&sig=...',
      },
    ],
  },
  callbackUrl: 'https://flaxia.app/api/crowd/webhook?type=cc-extract&...',
  timeoutMs: 60_000,
})

const task = await client.waitForTask(taskId, 2000, 90_000)
const result = task.result as {
  documents: Array<{
    url: string
    title: string
    text: string
    excerpt: string
    lang?: string
    publishedAt?: string
    canonicalUrl?: string
    contentType: string
    httpStatus: number
    truncated: boolean
    error?: string
  }>
  durationMs: number
}
```

結果は `documents[]` で返ります。各要素には `title`, `text`, `excerpt`, `lang`,
`publishedAt`, `canonicalUrl`, `httpStatus` が入り、失敗したレコードは `error` を持ちます。
`fetchUrl` を省略した場合は `https://data.commoncrawl.org` を直接取得しますが、
ブラウザでは CORS のため通常は失敗します（Node.js のテスト用途向け）。

抽出対象は `WARC-Type: response` のレコードのみです。`resource` と `revisit`
（重複排除されたレコード）は未対応で、該当レコードは `error` を返します。

`fetchUrl` を使う場合、range proxy は次の CORS ヘッダーを返す必要があります。

- `Access-Control-Allow-Origin`（埋め込み先サイトの origin）
- `Access-Control-Expose-Headers: Content-Range`（ノードは offset を検証します）
- 必要に応じて `Access-Control-Allow-Headers: Range`

ノードはリダイレクトを追いません。proxy はリダイレクトせず、署名付き URL の
パス・range・有効期限を検証してください。

## EmbeddingGemma 2 テキスト埋め込み (embed-gemma)

マルチリンガル（100+言語）・マルチモーダル対応の EmbeddingGemma 2 を、
テキスト専用（270M）でノードに実行させます。

```typescript
const { taskId } = await client.submit({
  workload: 'embed-gemma',
  payload: {
    texts: [
      'task: search result | query: 東京の天気',
      'title: 天気予報 | text: 明日の東京は晴れです。',
    ],
    dimensions: 512, // 768 | 512 | 256 | 128 (MRL)
  },
  timeoutMs: 120_000,
})

const task = await client.waitForTask(taskId, 2000, 150_000)
const result = task.result as {
  vectors: number[][]
  model: string
  dimensions: number
  durationMs: number
}
```

- ONNX: `onnx-community/embeddinggemma-2-ONNX`（vision/audio encoder は無効化）
- WebGPU があるノードは `q8`、WASM フォールバックは `fp16`（量子化モデルの
  `GatherBlockQuantized` カーネルが WASM にないため）
- 1タスク最大32テキスト、1テキスト4,000文字、合計100,000文字
- 結果は `vectors[]`（入力順）。`dimensions` で MRL 切り詰め＋再正規化済み
- prefix はホスト側で付与します（query / document で異なる）
- WASM フォールバックは WebGPU より大幅に遅いため、大きなバッチは
  タイムアウトし得ます。まず小さいバッチで実測してください。
