# 05. エラーハンドリング

## 実際のエラークラス（`src/errors.ts`）

```
Error
└── FlaxiaError                        基底（message / code / status）
    ├── AuthenticationError            code: AUTH_ERROR, status: 401
    ├── TaskNotFoundError              code: TASK_NOT_FOUND, status: 404
    ├── ValidationError                code: VALIDATION_ERROR, status: 400
    └── OndeviceUnavailableError       code: ONDEVICE_UNAVAILABLE, status: 500
```

`FlaxiaCrowdError` / `FlaxiaTimeoutError` / `FlaxiaValidationError` /
`FlaxiaNetworkError` は**存在しない**。時間切れや HTTP エラーは `FlaxiaError` の
`code` / `status` で表現する。

```typescript
class FlaxiaError extends Error {
  constructor(message: string, public code: string, public status?: number)
}

new AuthenticationError()                    // 'Invalid API Key', AUTH_ERROR, 401
new TaskNotFoundError(taskId)                // 'Task not found: <id>', TASK_NOT_FOUND, 404
new ValidationError(message)                 // VALIDATION_ERROR, 400
new OndeviceUnavailableError(message, detail) // ONDEVICE_UNAVAILABLE, 500
```

## 実在する `code` / `status`

| code | status | 発生箇所 |
|------|--------|---------|
| `AUTH_ERROR` | 401 | `FlaxiaClient` の API キー未指定、`AuthenticationError` |
| `VALIDATION_ERROR` | 400 | `submit()` の引数不正、`ValidationError` |
| `TASK_NOT_FOUND` | 404 | `getTask()` / `waitForTask()` が 404 を受け取った場合 |
| `ONDEVICE_UNAVAILABLE` | 500 | on-device 専用実行が不可能な場合 |
| `SUBMIT_ERROR` | Worker の HTTP ステータス | `submit()` が非 2xx を受け取った場合 |
| `FETCH_ERROR` | Worker の HTTP ステータス | `getTask()` / `getQueueStats()` の非 2xx |
| `POLLING_TIMEOUT` | 408 | `waitForTask()` が期限までに端末状態へ到達しなかった場合 |
| `SUBSCRIBE_UNAUTHORIZED` | 401 | `subscribe()` にトークンが無い場合 |
| `WS_CONNECT_ERROR` | 0 | WebSocket 接続失敗 |

Worker が返す JSON の `{ error: string }` は `message` としてそのまま使われる。
`status` は HTTP ステータス（`FetchError` 相当の通信障害では NetworkError ではなく
`FlaxiaError` の `FETCH_ERROR` となる）。

## 使い方

```typescript
import { FlaxiaClient, FlaxiaError, TaskNotFoundError } from '@flaxia/sdk'

const client = new FlaxiaClient({ apiKey: process.env.FLAXIA_API_KEY! })

try {
  const submitted = await client.submit({
    workload: 'ai-inference',
    payload: { task: 'text-generation', model: 'm', input: 'hi' },
  })
  const task = await client.waitForTask(submitted.taskId)
  if (task.status === 'failed') console.error(task.error)
  else console.log(task.result)
} catch (err) {
  if (err instanceof TaskNotFoundError) {
    console.error('タスクが見つからない:', err.message)
  } else if (err instanceof FlaxiaError) {
    console.error('Flaxia エラー:', err.code, err.status, err.message)
  } else {
    throw err
  }
}
```

## タイムアウト後の結果確認

`waitForTask()` が `POLLING_TIMEOUT` を投げてもタスク自体は Worker 上で継続している
可能性がある。`taskId` を保存しておけば後から `getTask()` で確認できる。

```typescript
const savedTaskId = submitted.taskId
const task = await client.getTask(savedTaskId)
if (task.status === 'done') console.log(task.result)
```

Webhook の検証エラー（`verifyCrowdWebhook()` の `result.reason`）は別体系であり、
`FlaxiaError` ではない（[02-submit-task.md](02-submit-task.md) 参照）。
