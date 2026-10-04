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

// Response (202 Accepted)
type SubmitResponse = {
  taskId: string
  status: 'pending'
  estimatedWaitMs?: number  // キューの状況から推定
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
// callbackUrl に届くPOSTのbody（parseCrowdWebhook() が正規化する形）
type WebhookPayload = {
  taskId: string
  status: 'done' | 'failed'
  result?: { output?: unknown; [key: string]: unknown }
  error?: string
}
```

### 署名ヘッダー

```
X-Flaxia-Signature: sha256=<hmac>
X-Flaxia-Timestamp: <unix秒>
X-Flaxia-Nonce:     <推測不能な一意値>
```

`<hmac>` は `HMAC-SHA256(webhookSecret, "<timestamp>.<nonce>.<rawBody>")` の
16進表記。`rawBody` は受信した生のリクエストボディであり、再シリアライズした
JSON ではない。

### 受信側の実装

`@flaxia/sdk` の `verifyCrowdWebhook()`（PR "worker trust plane" で追加）で
署名・タイムスタンプ許容幅（例: ±5分）・nonce のリプレイガードをまとめて検証し、
成功したボディだけを `parseCrowdWebhook()` に渡す。`taskId` はホストが投入時に
永続化した対応表をサーバー側で引くために使い、リクエストで渡された ID を
そのまま信用しない。未認証の呼び出し元には `204 No Content` などの最小限の
応答だけを返す。
