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

## 同期タスク投入 (submit)
結果が返るまで待機します。

```typescript
const result = await client.submit({
  workload: 'ai-inference',
  payload: {
    task: 'sentiment-analysis',
    text: 'Great product!',
  },
  waitTimeoutMs: 30000, // 30秒
})
```

## 非同期タスク投入 (submitAsync)
結果をWebhookで受け取ります。

```typescript
await client.submitAsync({
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
const result = await client.submit({
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
        // ブラウザノードは Range ヘッダー付きの cross-origin fetch が
        // CORS preflight で拒否されるため、ホスト側の署名付き range proxy を
        // 指定します。ノードは ccRangeOrigins に含まれる origin だけを許可します。
        fetchUrl: 'https://flaxia.app/api/crowd/cc-range?...&sig=...',
      },
    ],
  },
  callbackUrl: 'https://flaxia.app/api/crowd/webhook?type=cc-extract&...',
  timeoutMs: 60_000,
})
```

結果は `documents[]` で返ります。各要素には `title`, `text`, `excerpt`, `lang`,
`publishedAt`, `canonicalUrl`, `httpStatus` が入り、失敗したレコードは `error` を持ちます。
`fetchUrl` を省略した場合は `https://data.commoncrawl.org` を直接取得しますが、
ブラウザでは CORS のため通常は失敗します（Node.js のテスト用途向け）。

## EmbeddingGemma 2 テキスト埋め込み (embed-gemma)

マルチリンガル（100+言語）・マルチモーダル対応の EmbeddingGemma 2 を、
テキスト専用（270M）でノードに実行させます。

```typescript
const result = await client.submit({
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
```

- ONNX: `onnx-community/embeddinggemma-2-ONNX`（vision/audio encoder は無効化）
- WebGPU があるノードは `q8`、WASM フォールバックは `fp16`（量子化モデルの
  `GatherBlockQuantized` カーネルが WASM にないため）
- 1タスク最大32テキスト、1テキスト4,000文字、合計100,000文字
- 結果は `vectors[]`（入力順）。`dimensions` で MRL 切り詰め＋再正規化済み
- prefix はホスト側で付与します（query / document で異なる）
