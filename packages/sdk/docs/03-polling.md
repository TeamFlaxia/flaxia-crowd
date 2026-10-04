# 03. 結果取得（ポーリング）

## 概要

`submit()` はタスク投入後、`GET /crowd/tasks/:id` を定期的に叩いて
結果が返るまで待つ。

## pollUntilDone() の実装

```typescript
private async pollUntilDone<T>(
  taskId: string,
  options: { waitTimeoutMs: number; pollIntervalMs: number }
): Promise<TaskResult<T>> {
  const deadline = Date.now() + options.waitTimeoutMs

  while (Date.now() < deadline) {
    const task = await this.getTask<T>(taskId)

    if (task.status === 'done') return task
    if (task.status === 'failed') {
      throw new FlaxiaCrowdError(
        task.error ?? 'Task failed',
        'TASK_FAILED',
        500
      )
    }

    // pending または processing → 待って再チェック
    const remaining = deadline - Date.now()
    const waitMs = Math.min(options.pollIntervalMs, remaining)
    if (waitMs <= 0) break
    await sleep(waitMs)
  }

  throw new FlaxiaTimeoutError(taskId)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
```

## getTask() の実装

```typescript
async getTask<T = unknown>(taskId: string): Promise<TaskResult<T>> {
  return this.request<TaskResult<T>>('GET', `/crowd/tasks/${taskId}`)
}
```

`GET /crowd/tasks/:id` は**タスクを投入した API キーのテナントのみ**が読める。
別テナントのキーでは 404 が返る（存在を伏せる）。応答には
`/crowd/subscribe` 用の短期 `subscribeToken` が含まれ、クライアントは
それをキャッシュして `subscribe()` で自動使用する。

## WebSocket 購読（推奨）

```typescript
const subscription = await client.subscribe(taskId) // トークンは自動取得
subscription.onToken((token) => process.stdout.write(token))
subscription.onDone((result) => console.log('done', result))
subscription.onError((error) => console.error(error))
```

トークンが取得できない場合（サーバーが発行しない・期限切れ）は
`SUBSCRIBE_UNAUTHORIZED` を投げるので、`waitForTask()` はポーリングへ
フォールバックする。

## ポーリング間隔の設計方針

デフォルト2秒。ユーザーが変更可能。

推奨値の目安：

| ワークロード | 推奨pollIntervalMs |
|------------|-------------------|
| ai-inference（軽量モデル） | 1000 |
| ai-inference（重量モデル） | 3000 |
| image-process | 1000 |
| file-convert | 5000 |

## getTask() のレスポンス型

```typescript
type TaskResult<T = unknown> = {
  taskId: string
  status: 'pending' | 'processing' | 'done' | 'failed'
  result?: T          // done時のみ
  error?: string      // failed時のみ
  processingMs?: number
  retryCount: number
  createdAt: number
  completedAt?: number
}
```

## キャンセル対応（将来）

Phase 1では実装しない。
将来的に `AbortSignal` を `submit()` に渡せるようにして、
`DELETE /crowd/tasks/:id` でキャンセルできる設計を想定。
