# 03. 結果取得（ポーリング／購読）

## 実際のAPI（`src/client.ts`）

| メソッド | 戻り値 | 説明 |
|---------|--------|------|
| `getTask(taskId)` | `Promise<TaskRecord>` | 1 回だけ状態を取得（所有者テナントのみ） |
| `waitForTask(taskId, intervalMs = 2000, timeoutMs = 60000)` | `Promise<TaskRecord>` | 完了または失敗まで待つ |
| `subscribe(taskId, options?)` | `Promise<TaskSubscription>` | トークンストリームと完了結果を WebSocket で購読 |
| `getQueueStats()` | `Promise<TaskQueueStats>` | 自テナントの待ち時間・キュー統計 |

`pollUntilDone()` は `FlaxiaClient` の**非公開**メソッドであり、利用者が呼ぶ API ではない。
`waitTimeoutMs` / `pollIntervalMs` / `FlaxiaTimeoutError` は存在しない。

## waitForTask() の挙動

```typescript
const submitted = await client.submit({ workload: 'ai-inference', payload: { /* ... */ } })

// 第2引数 = ポーリング間隔 ms（既定 2000）、第3引数 = 全体の待ち時間 ms（既定 60000）
const task = await client.waitForTask(submitted.taskId, 2000, 60_000)

if (task.status === 'done') {
  console.log(task.result)
} else if (task.status === 'failed') {
  console.error(task.error)
}
```

- まず `subscribe()` を試み、トークンが取れない／接続できない場合はポーリングへ
  フォールバックする。WebSocket を使える場合はトークンを読み捨てて ACK し、
  完了またはエラー通知で購読を閉じる。
- 正常系では `status === 'done'` または `status === 'failed'` の `TaskRecord` を返す。
  **失敗は例外ではなく `TaskRecord.error` で表現される**。
- 時間内に端末状態へ到達しない場合は `FlaxiaError`
  （`code: 'POLLING_TIMEOUT'`、`status: 408`、`message: 'Task polling timed out'`）を投げる。
  タスク自体は Worker 上で継続している可能性があるため、`taskId` を保存して
  後から `getTask()` で確認できる。

`intervalMs` / `timeoutMs` の推奨値（ワークロードごとの既定値ではない）：

| ワークロード | `intervalMs` の目安 |
|------------|-------------------|
| ai-inference（軽量モデル） | 1000 |
| ai-inference（重量モデル） | 3000 |
| embed-gemma / vector-embed | 2000 |
| theia-inference（LoRA） | 3000 |

## getTask()

```typescript
const task = await client.getTask(taskId)
console.log(task.status, task.result, task.error)
```

`GET /crowd/tasks/:id` は**タスクを投入した API キーのテナントのみ**が読める。
別テナントのキーでは 404 が返り、`TaskNotFoundError` が投げられる（存在を伏せる）。
応答には `/crowd/subscribe` 用の短期 `subscribeToken` が含まれ、
クライアントはそれをキャッシュして `subscribe()` で自動使用する。

`TaskRecord` の主なフィールド：

```typescript
type TaskRecord = {
  id: string
  status: 'pending' | 'assigning' | 'processing' | 'done' | 'failed'
  workload: WorkloadType
  payload: TaskPayload
  createdAt: number
  tenantId: string
  result?: unknown       // done 時のみ
  error?: string         // failed 時のみ
  resultNodeId?: string  // 監査用
  resultAttemptId?: string
  subscribeToken?: string
  subscribeTokenExpiresAt?: number
}
```

## WebSocket 購読（ストリーミング）

```typescript
const subscription = await client.subscribe(taskId)
subscription.onToken((token) => process.stdout.write(token))
subscription.onReset((reset) => console.log('retry epoch', reset.epoch))
subscription.onDone((result) => console.log('done', result))
subscription.onError((error) => console.error(error))

// 不要になったら明示的に閉じる
subscription.close()
```

購読トークンは `submit()` の応答、`getTask()` の応答、
または `options.subscribeToken` から取得する。トークンが得られない場合は
`FlaxiaError`（`code: 'SUBSCRIBE_UNAUTHORIZED'`、`status: 401`）を投げる。
接続失敗は `FlaxiaError`（`code: 'WS_CONNECT_ERROR'`）となる。

## エラー（実在するクラス名）

- `AuthenticationError`（`AUTH_ERROR` / 401）：API キーが空／無効
- `ValidationError`（`VALIDATION_ERROR` / 400）：`submit()` の引数不正
- `TaskNotFoundError`（`TASK_NOT_FOUND` / 404）：自テナントにタスクが存在しない
- `OndeviceUnavailableError`（`ONDEVICE_UNAVAILABLE` / 500）：on-device 実行条件を満たさない
- `FlaxiaError`（基底）：`SUBMIT_ERROR` / `FETCH_ERROR` / `POLLING_TIMEOUT` /
  `SUBSCRIBE_UNAUTHORIZED` / `WS_CONNECT_ERROR` などの `code` と `status` を持つ

## キャンセル

`AbortSignal` や `DELETE /crowd/tasks/:id` は未実装。
`waitForTask()` がタイムアウトしても `taskId` を保持し、必要なら `getTask()` で
最終状態を確認する運用を取る。
