# 02. WebRTC Signalingサーバー

## 概要

Cloudflare Workers の WebSocket サポートを使い、
`/crowd/signal` エンドポイントで WebRTC の Offer/Answer/ICE 交換を仲介する。

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
[Node]                  [Worker: Signaling]            [SDK Client]
  |                            |                             |
  |-- WS Connect (subprotocol)->|                            |
  |<- { type: "hello", nodeId }|                             |
  |                            |<-- POST /crowd/tasks -------|
  |<- { type: "task", taskId, |                             |
  |     offer: RTCSessionDesc }|                             |
  |-- { type: "answer",  ----->|                             |
  |     taskId, answer }       |                             |
  |-- { type: "ice", --------->|                             |
  |     taskId, candidate }    |                             |
  |                            |--- callback / polling ----->|
  |-- { type: "result", ------>|                             |
  |     taskId, payload }      |-- { status: done, result }->|
```

## WebSocketメッセージスキーマ

### Worker → Node

```typescript
// 接続確立時
type HelloMessage = {
  type: 'hello'
  nodeId: string
}

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
```

### Node → Worker

```typescript
// Answer返却
type AnswerMessage = {
  type: 'answer'
  taskId: string
  answer: RTCSessionDescriptionInit
}

// ICE Candidate
type IceCandidateMessage = {
  type: 'ice'
  taskId: string
  candidate: RTCIceCandidateInit
}

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

// 失敗（ホストのみ。swarm メンバーの失敗はホストへ中継される）
type ErrorMessage = {
  type: 'error'
  taskId: string
  error: string
  attemptId: string
}

// Pong
type PongMessage = {
  type: 'pong'
  nodeId: string
  cpuLoad: number   // 0.0 - 1.0
}
```

## Durable Object との連携

Signalingハンドラは `NodeManager` Durable Object に以下を委譲する：

- ノードのWebSocket接続の保持
- タスク割り当て（どのノードにどのタスクを振るか）
- Ping/Pongによる死活確認（30秒間隔）

## swarm セッションの権限（Issue #4）

- `swarm-plan` / `swarm-ready` / `swarm-error` / `swarm-done` / `swarm-token` は
  セッション ID とメンバーシップを検証する。
- 結果（`result`）とセッションの失敗（`error` / `swarm-error`）を確定できるのは
  **ホストのみ**。メンバーの失敗は `swarm-error`（`fromNodeId` 付き）として
  ホストへ中継され、ホストが中断を決める。メンバーが他メンバーのタスクを
  直接失敗させることはできない。
- ホストが提案するレイヤ計画は連続性・全被覆に加え、整数スライス・
  総層数 1024 以下・1 ノード 256 層以下を検査する。違反は `swarm-error` を返し、
  タスクを恒久失敗させる（`end: 1e9` による GPU OOM を防ぐ）。

## 実装上の注意

- `upgradeWebSocket` は Cloudflare Workers でのみ動作する。ローカルの
  `wrangler dev` では動くが、Node.js環境では動かない
- WebSocketのメッセージはすべて `JSON.stringify` / `JSON.parse` で扱う
- タイムアウト（`timeoutMs`）を超えたタスクは `TaskQueue` が自動で
  再キューイングする（`03-task-queue.md` 参照）
