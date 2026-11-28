# 01. FlaxiaClientクラス

## 概要

すべての操作の起点となるクライアントクラス。`fetch` と `WebSocket` のみを使用し、
実行時依存ゼロ。`src/client.ts` の実装が唯一の真実の源泉。

## 実際のクラス定義

```typescript
interface FlaxiaClientConfig {
  /** API キー（必須）。空文字なら AuthenticationError。 */
  apiKey: string
  /** オーケストレーター URL。既定は 'https://api.flaxia.crowd'。 */
  baseUrl?: string
}

interface SubmitTaskOptions {
  workload: WorkloadType
  payload: TaskPayload
  callbackUrl?: string
  /** タスク実行タイムアウト ms（1s..1h）。 */
  timeoutMs?: number
  priority?: 0 | 1 | 2 | 3
}

class FlaxiaClient {
  constructor(config: FlaxiaClientConfig)

  /** POST /crowd/tasks。投入結果（部分 TaskRecord）を返す。 */
  submit(options: SubmitTaskOptions): Promise<SubmitTaskResponse>

  /** GET /crowd/tasks/:id（所有者テナントのみ）。 */
  getTask(taskId: string): Promise<TaskRecord>

  /** キュー待ち・割り当て・拒否の統計（自テナントのみ）。 */
  getQueueStats(): Promise<TaskQueueStats>

  /** 完了/失敗まで待機。タイムアウトは FlaxiaError(POLLING_TIMEOUT)。 */
  waitForTask(taskId: string, intervalMs?: number, timeoutMs?: number): Promise<TaskRecord>

  /** トークンを自動解決して /crowd/subscribe を開く。 */
  subscribe(taskId: string, options?: SubscribeOptions): Promise<TaskSubscription>
}
```

`orchestratorUrl` / `requestTimeoutMs` / `submitAsync()` / `waitTimeoutMs` /
`pollIntervalMs` は存在しない。待ち時間は `waitForTask()` の引数で指定する。

`baseUrl` はホスト直下（`https://host`）でも `/crowd` 付きでも受け付け、
内部で正規化して `/crowd/tasks` などの実ルートに送信する。

## ストリームの流量制御

トークンごとに処理完了を ACK する。Coordinator は未 ACK が一定数に達すると
生成ノードを停止し、購読者が追いつくと再開する。ACK に対応しないクライアントも
サーバー側の固定上限で保護される。

```ts
const subscription = await client.subscribe(taskId);
subscription.onToken(async (token) => {
  await persistToken(token); // 完了後にACKされ、必要なら生成が再開する
});
subscription.onReset(({ epoch }) => console.log('retry', epoch));
subscription.onError((error) => console.error(error));
subscription.close();
```

## エラー

`submit()` は `ValidationError` / `AuthenticationError` / `FlaxiaError(SUBMIT_ERROR)`、
`getTask()` は `TaskNotFoundError` / `FlaxiaError(FETCH_ERROR)`、
`waitForTask()` は期限切れで `FlaxiaError(POLLING_TIMEOUT)` を投げる。
`subscribe()` はトークン不足で `FlaxiaError(SUBSCRIBE_UNAUTHORIZED)`、
接続失敗で `FlaxiaError(WS_CONNECT_ERROR)` となる。
詳細は [05-errors.md](05-errors.md)。

## APIキーと環境

API キーは Bearer トークンとして送信され、テナント ID は Worker 側で
`API_KEYS` 設定から導出される。クライアントからテナントを指定することはできない。
Node.js 18+、Cloudflare Workers、Deno、モダンブラウザの `fetch` / `WebSocket` で動作する。
