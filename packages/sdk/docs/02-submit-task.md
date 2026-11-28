# 02. タスク投入API

## 概要

`FlaxiaClient.submit()` が `POST /crowd/tasks` にタスクを投入する。
投入は即時レスポンスを返すだけであり、完了まで待つ場合は別途
`waitForTask()` を呼ぶ（[03-polling.md](03-polling.md)）。

## 実際のAPI（`src/client.ts` / `src/types.ts`）

```typescript
interface FlaxiaClientConfig {
  /** API キー（必須）。空文字は AuthenticationError。 */
  apiKey: string
  /** オーケストレーター URL。既定は 'https://api.flaxia.crowd'。 */
  baseUrl?: string
}

interface SubmitTaskOptions {
  workload: WorkloadType
  payload: TaskPayload
  /** 完了時に POST する Webhook URL（HTTPS かつ公開ホストのみ）。 */
  callbackUrl?: string
  /** タスクの実行タイムアウト ms（1,000..3,600,000）。待ち時間ではない。 */
  timeoutMs?: number
  /** スケジューリング優先度 0..3。 */
  priority?: 0 | 1 | 2 | 3
}

/** submit() の戻り値。完全な TaskRecord ではなく部分スナップショット。 */
interface SubmitTaskResponse {
  message: string
  taskId: string
  id: string            // taskId と同じ値
  status: TaskStatus
  createdAt: number     // unix ms
  /** /crowd/subscribe 用の短期トークン（既定 10 分）。 */
  subscribeToken?: string
  subscribeTokenExpiresAt?: number
}
```

`waitTimeoutMs` / `pollIntervalMs` / `submitAsync()` は**存在しない**。
待ち時間は `waitForTask(taskId, intervalMs, timeoutMs)` の引数で指定する。

## 使い方

```typescript
import { FlaxiaClient } from '@flaxia/sdk'

const client = new FlaxiaClient({ apiKey: process.env.FLAXIA_API_KEY! })

const submitted = await client.submit({
  workload: 'ai-inference',
  payload: {
    task: 'text-generation',
    model: 'Xenova/distilbert-base-uncased-finetuned-sst-2-english',
    input: 'This is amazing!',
  },
  timeoutMs: 60_000,
  priority: 2,
})

// submitted.taskId は文字列。結果は waitForTask() で取得する。
const task = await client.waitForTask(submitted.taskId)
if (task.status === 'done') console.log(task.result)
```

`submit()` は入力が空なら `ValidationError`、API キー不正なら `AuthenticationError`、
Worker が拒否した場合は `FlaxiaError`（`code: 'SUBMIT_ERROR'`、`status` は HTTP ステータス）を投げる。
`callbackUrl` は Worker で HTTPS・公開ホスト・既定ポート・署名シークレット設定済みか検証される。
`payload.allowedSites` は **未実装** のため、付けて投入すると `400`（unsupported）で拒否される。

## Webhookペイロード（コールバック受信側）

```typescript
// parseCrowdWebhook() が返す型（src/webhook.ts）
interface CrowdWebhookEvent<TResult = unknown> {
  taskId: string
  status: 'done' | 'failed'
  /** 結果のエンベロープ。実payloadは result.output（無い場合は result 自体）。 */
  result?: { output?: TResult; [key: string]: unknown }
  error?: string
}
```

Worker が送る生の本文には監査用の `nodeId` / `attemptId` も入るが、
`parseCrowdWebhook()` の戻り値には含まれない。監査に使うなら検証済みの
生の本文を別途記録すること。結果の取り出しには `extractCallbackOutput(event)` を使う。

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
- 署名は配送の真正性のみを示し、結果の正しさは保証しない。下流の意思決定に使う場合は
  再実行・サンプリング検証を組み合わせ、`nodeId` / `attemptId` を記録すること。
