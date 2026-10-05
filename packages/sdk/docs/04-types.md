# 04. 共有型定義

## 概要

`@flaxia/sdk` が公開する型定義。
`@flaxia/node` および `@flaxia/worker` と**スキーマを厳密に合わせること**。
型定義を変更した場合は必ず3パッケージ同時に更新する。

## WorkloadType

```typescript
type WorkloadType =
  | 'ai-inference'
  | 'image-process'
  | 'file-convert'   // Phase 2
```

## ワークロード別ペイロード型

### ai-inference

```typescript
type AiInferencePayload = {
  /**
   * Transformer.jsのpipelineタスク名
   * 例: 'text-classification', 'translation_en_to_fr', 'summarization'
   *     'text-generation', 'token-classification', 'question-answering'
   */
  task: string
  /**
   * HuggingFaceモデル名
   * 例: 'Xenova/distilbert-base-uncased-finetuned-sst-2-english'
   * 制限: 量子化済みモデル（quantized）のみ受け付ける
   * 制限: モデルサイズ 500MB 以下
   */
  model: string
  /** テキスト入力（単一または配列） */
  input: string | string[]
  /** pipeline()に渡すオプション */
  options?: Record<string, unknown>
}

type AiInferenceResult = {
  output: unknown   // モデル・タスクによって形式が異なる
}
```

### image-process

```typescript
type ImageProcessPayload = {
  operation: 'resize' | 'grayscale' | 'compress' | 'thumbnail'
  /**
   * 画像データ（Base64エンコード）
   * 制限: 10MB以下
   */
  imageBase64: string
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp'
  options: {
    width?: number        // resize / thumbnail
    height?: number       // resize / thumbnail
    quality?: number      // compress: 0.0 - 1.0
    outputFormat?: 'jpeg' | 'png' | 'webp'
  }
}

type ImageProcessResult = {
  imageBase64: string
  mimeType: string
  originalSizeBytes: number
  resultSizeBytes: number
}
```

### file-convert（Phase 2 予約）

```typescript
// Phase 2で定義予定
type FileConvertPayload = {
  operation: 'pdf-to-text' | 'markdown-to-html'
  fileBase64: string
  mimeType: string
  options?: Record<string, unknown>
}
```

## ルーティングヒント（全ペイロード共通）

`TaskPayload` は全ワークロード共通で以下のフィールドを受け付ける
（`TaskPayloadRouting`）。

```typescript
type TaskPayloadRouting = {
  /**
   * 実行を許可するノードサイト ID の allow-list。
   * 指定時は署名済みノードトークンの siteId が一致するノードだけに割り当て、
   * 期限までに候補が現れなければタスクを失敗させる。
   *
   * 注意: 実行するノードはペイロードそのものを読める。allow-list は
   * 「どのサイトに渡すか」を絞るだけで、内容の秘匿は保証しない。
   */
  allowedSites?: string[]
}
```

## TaskRecord（API 応答）

| フィールド | 型 | 説明 |
|-----------|-----|------|
| `tenantId` | `string` | 所有テナント（API キーから解決）。他テナントからは 404 |
| `allowedSites` | `string[]?` | サイト allow-list の写し |
| `resultNodeId` | `string?` | 結果を受理したノード（監査用） |
| `resultAttemptId` | `string?` | 結果を受理した配信試行（監査用） |
| `subscribeToken` | `string?` | API 応答のみ。`/crowd/subscribe` 用の短期トークン |
| `subscribeTokenExpiresAt` | `number?` | 上記の有効期限（unix ms） |

## WebSocket ハンドシェイク（`handshake.ts`）

ブラウザの `WebSocket` はヘッダを設定できないため、トークンは
サブプロトコル一覧で運ぶ。worker と node はこのモジュールだけを契約として使う。

```typescript
const NODE_SIGNAL_PROTOCOL = 'flaxia-node-v1'
const SUBSCRIBE_PROTOCOL = 'flaxia-subscribe-v1'
const BEARER_SUBPROTOCOL_PREFIX = 'bearer.'

buildNodeSignalProtocols(token) // ['flaxia-node-v1', 'bearer.<token>']
buildSubscribeProtocols(token)  // ['flaxia-subscribe-v1', 'bearer.<token>']
parseBearerSubprotocol(header, protocol) // サーバー側の検証（重複・未知・過大を拒否）
buildWsUrl(baseUrl, path, params)
```

## swarm 計画の上限

```typescript
const MIN_SWARM_NODES = 2
const MAX_SWARM_NODES = 16
const MAX_SWARM_LAYERS = 1024        // 総層数の上限
const MAX_SWARM_SLICE_LAYERS = 256   // 1 ノードあたりの上限
```

`isValidSwarmChain()` は連続性・全被覆に加えてこれらの上限と
整数スライスを検査する（`end: 1e9` のような計画を拒否する）。

## 型のバージョン管理方針

型定義に破壊的変更が生じた場合：
- ペイロードに `version` フィールドを追加（デフォルト省略時は `'v1'`）
- Worker側でバージョン別にdispatchする
- 旧バージョンは最低3ヶ月は維持する
