# 02. Node WebSocket signaling

## 概要

Cloudflare Workers の WebSocket サポートを使い、`/crowd/signal` エンドポイントで
ノードの登録・認証・タスク配信・heartbeat・結果受信を行う。タスクは JSON
メッセージとして同じ WebSocket 上を流れ、WebRTC の Offer/Answer/ICE 交換や
DataChannel は使わない。

実装には Hono の `upgradeWebSocket` を使用する。

## ハンドシェイク（Issue #20）

ブラウザの `WebSocket` はリクエストヘッダを設定できないため、ノードトークンは
**サブプロトコル一覧**で送る。URL クエリの `?token=` はアクセスログ・Referer に
残るため、サーバーは 401 で拒否する。

```
GET /crowd/signal HTTP/1.1
Upgrade: websocket
Sec-WebSocket-Protocol: flaxia-node-v1, bearer.<base64url node token>

HTTP/1.1 101 Switching Protocols
Sec-WebSocket-Protocol: flaxia-node-v1
```

- トークンは `POST /crowd/nodes/register` の応答のもの。`nodeId` / `siteId` は
  署名済みトークン内の値だけを使う（クエリや本文で指定しても無視される）。
- `flaxia-node-v1` が無い、`bearer.` が無い/重複する、未知のサブプロトコルが
  混ざる場合は 401。
- 契約は `@flaxia/sdk` の `handshake.ts`（`buildNodeSignalProtocols` /
  `parseBearerSubprotocol`）が唯一の定義。ノード側の実装も同じ関数を使う。

## 接続フロー

```
[Node]                  [Worker: /crowd/signal]         [SDK Client]
  |                            |                             |
  |-- WS Connect (subprotocol)->|                            |
  |<- { type: "pong", ... } ---|                             |
  |                            |<-- POST /crowd/tasks -------|
  |<- { type: "task", taskId, |                             |
  |     workload, payload,    |                             |
  |     timeoutMs, attemptId }|                             |
  |-- { type: "progress" } --->|                             |
  |-- { type: "result", ------>|                             |
  |     taskId, attemptId,     |--- callback / polling ----->|
  |     payload }              |                             |
```

Coordinator は `task` を JSON で配信し、ノードは同じ試行の `attemptId` を
`progress` / `result` / `error` に付けて返す。ノードが処理を続けられない場合は
`{ type: "abort", taskId, error }` を受け取り、エラーを返送せずに停止する。

## WebSocketメッセージスキーマ

### Worker → Node

```typescript
// タスク割り当て
type TaskAssignMessage = {
  type: 'task'
  taskId: string
  workload: WorkloadType
  payload: unknown        // ワークロード固有データ
  timeoutMs: number
  /**
   * 配信ごとに発行される試行 ID（Issue #4）。
   * result / progress / error に同じ値を付けて返すこと。
   * 別の試行の ID や欠落したメッセージはコーディネーターが破棄する。
   */
  attemptId: string
}

// Ping（死活確認）
type PingMessage = {
  type: 'ping'
}

// タスク停止（エラーを返送しない）
type AbortMessage = {
  type: 'abort'
  taskId: string
  error: string
}
```

### Node → Worker

```typescript
// 処理結果（attemptId 必須。result はプレーンオブジェクトのみ受理）
type ResultMessage = {
  type: 'result'
  taskId: string
  payload: unknown
  attemptId: string
}

// 進捗トークン（1 件 4KB 以下、タスクごとに毎秒 50 件まで）
type ProgressMessage = {
  type: 'progress'
  taskId: string
  token: string
  attemptId: string
}

// 失敗
type ErrorMessage = {
  type: 'error'
  taskId: string
  error: string
  attemptId: string
}

// Pong（heartbeat 応答。resources は任意の自己申告テレメトリ）
type PongMessage = {
  type: 'pong'
  cpuLoad: number | null   // 0.0 - 1.0、未計測は null
  resources?: NodeResourceReport
}
```

## Durable Object との連携

Signaling ハンドラは `Coordinator` Durable Object に以下を委譲する：

- ノードの WebSocket 接続の保持
- タスク配置（どのノードにどのタスクを振るか）
- Ping/Pong による死活確認（30 秒間隔）
- 結果の受理と購読者へのトークン転送

## 実装上の注意

- `upgradeWebSocket` は Cloudflare Workers でのみ動作する。ローカルの
  `wrangler dev` では動くが、Node.js環境では動かない
- WebSocketのメッセージはすべて `JSON.stringify` / `JSON.parse` で扱う
- タイムアウト（`timeoutMs`）を超えたタスクは `TaskQueue` が自動で
  再キューイングする（`03-task-queue.md` 参照）
