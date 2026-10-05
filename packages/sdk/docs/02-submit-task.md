# 02. タスク投入API

## 概要

`POST /crowd/tasks` にタスクを投入するロジック。

## TaskSubmitOptions 型定義

```typescript
type WorkloadType = 'ai-inference' | 'image-process' | 'file-convert'

type TaskSubmitOptions = {
  /** 実行するワークロードの種別 */
  workload: WorkloadType
  /** ワークロード固有のペイロード（04-types.md参照） */
  payload: AiInferencePayload | ImageProcessPayload | FileConvertPayload
  /**
   * タスク完了まで待つ最大時間 ms
   * デフォルト: 60000（60秒）
   * この時間を超えると FlaxiaTimeoutError が throw される
   */
  waitTimeoutMs?: number
  /**
   * ポーリング間隔 ms
   * デフォルト: 2000（2秒）
   */
  pollIntervalMs?: number
}

type TaskSubmitAsyncOptions = {
  workload: WorkloadType
  payload: unknown
  /**
   * 完了時にPOSTするURL（HTTPS必須）
   * 省略不可（非同期モードなのでコールバックがないと結果を受け取れない）
   */
  callbackUrl: string
}
```

## リクエスト・レスポンス

```typescript
// POST /crowd/tasks
// Request body
type SubmitRequest = {
  workload: WorkloadType
  payload: unknown
  callbackUrl?: string
  timeoutMs: number
}

// Response (200 OK)
type SubmitResponse = {
  taskId: string
  id: string
  status: 'pending'
  createdAt: number
  /** GET /crowd/subscribe に必要な短期トークン（既定 10 分）。 */
  subscribeToken?: string
  subscribeTokenExpiresAt?: number
}
```

## submit() の実装イメージ

```typescript
async submit<T>(options: TaskSubmitOptions): Promise<TaskResult<T>> {
  // 1. タスク投入
  const { taskId } = await this.request<SubmitResponse>('POST', '/crowd/tasks', {
    workload: options.workload,
    payload: options.payload,
    timeoutMs: options.waitTimeoutMs ?? 60_000,
  })

  // 2. ポーリングで結果待ち（03-polling.md参照）
  return this.pollUntilDone<T>(taskId, {
    waitTimeoutMs: options.waitTimeoutMs ?? 60_000,
    pollIntervalMs: options.pollIntervalMs ?? 2_000,
  })
}
```

## submitAsync() の実装イメージ

```typescript
async submitAsync(options: TaskSubmitAsyncOptions): Promise<{ id: string }> {
  if (!options.callbackUrl.startsWith('https://')) {
    throw new FlaxiaValidationError('callbackUrl must be HTTPS')
  }

  const { taskId } = await this.request<SubmitResponse>('POST', '/crowd/tasks', {
    workload: options.workload,
    payload: options.payload,
    callbackUrl: options.callbackUrl,
    timeoutMs: 300_000,  // 非同期なので長めに設定
  })

  return { id: taskId }
}
```

## Webhookペイロード（コールバック受信側）

```typescript
// callbackUrl に届くPOSTのbody
type WebhookPayload = {
  taskId: string
  status: 'done' | 'failed'
  result?: unknown
  error?: string
  /** 結果を出したノード（監査用）。 */
  nodeId?: string
  /** 受理した配信試行（監査用）。 */
  attemptId?: string
}
```

### 検証（必須）

署名対象は **`<timestamp>.<nonce>.<raw body>`**（body は受信した生の文字列。
再シリアライズしないこと）。

| ヘッダー | 値 |
|---------|-----|
| `X-Flaxia-Signature` | `sha256=<base64url(HMAC-SHA256(secret, signingString))>` |
| `X-Flaxia-Timestamp` | unix 秒 |
| `X-Flaxia-Nonce` | 配信ごとのランダム値 |

secret は worker の `WEBHOOK_SIGNING_SECRET`（`NODE_TOKEN_SECRET` とは別物）。
worker 側は secret 未設定なら `callbackUrl` 付きタスクを 400 で拒否するため、
無署名の Webhook は届かない。

```typescript
import { readCrowdWebhookHeaders, verifyCrowdWebhook, createMemoryReplayGuard } from '@flaxia/sdk'

const replayGuard = createMemoryReplayGuard() // 本番は共有ストアを実装する

app.post('/api/crowd/webhook', async (c) => {
  const body = await c.req.text() // 生の本文
  const result = await verifyCrowdWebhook({
    secret: c.env.WEBHOOK_SIGNING_SECRET,
    body,
    ...readCrowdWebhookHeaders(c.req.raw.headers),
    replayGuard,
  })
  if (!result.ok) return c.text(`invalid webhook: ${result.reason}`, 401)
  // result.payload は検証済み。result.payload.result を参照する。
  return c.json({ received: true })
})
```

- タイムスタンプ許容は既定 300 秒（`toleranceSeconds` で変更可）。
- nonce は必須。`replayGuard` を渡すと同一 nonce の再送を `replayed_nonce` で拒否する。
- 既に検証済みの本文は従来どおり `parseCrowdWebhook()` でパースできる。
- **署名は配送の真正性のみを示し、結果の正しさは保証しない**。
  ノードは実行した値をそのまま報告するため、下流の意思決定に使う場合は
  再実行・サンプリング検証を組み合わせ、`nodeId` / `attemptId` を記録すること。
