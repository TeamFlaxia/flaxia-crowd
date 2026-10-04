# 02. ノードクライアント（Signaling接続管理）

## 概要

同意後、Signalingサーバー（Cloudflare Workers）にWebSocket接続し、
タスクの受信・実行・結果返送を管理する。

タスクのペイロードも結果も**すべてWebSocket上を流れる**。
WebRTC（DataChannel / offer / answer / ICE）は使用しない。

## 接続フロー

```
1. POST /crowd/nodes/register → ノードトークン取得（24時間有効）
   body: { siteId, nodeId, capabilities, wasmMemoryBytes, deviceMemory, swarm? }
2. WS  /crowd/signal?token=xxx → Signaling接続確立
3. ping / pong でハートビート
4. { type: 'task', taskId, workload, payload, timeoutMs? } を受信
5. WorkerPool で実行し { type: 'progress', taskId, token } を随時送信
6. { type: 'result', taskId, payload } または { type: 'error', taskId, error } を送信
```

## SignalingClient 実装方針

```typescript
class SignalingClient {
  private ws: WebSocket | null = null
  private nodeId: string | null = null
  private reconnectAttempts = 0
  private readonly MAX_RECONNECT_DELAY = 30_000

  async connect(): Promise<void>
  disconnect(): void
  private async obtainToken(): Promise<NodeToken | null>
  private send(message: Record<string, unknown>): void
  private scheduleReconnect(): void
}
```

## 再接続ロジック

指数バックオフ（最大30秒）で再接続を試みる：

```
1回目: 1秒後
2回目: 2秒後
3回目: 4秒後
…上限 30秒
```

ページのvisibility変化にも対応する：

```typescript
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    // バックグラウンドになったら停止（CPU・バッテリー節約）
    this.suspend()
  } else {
    // フォアグラウンドに戻ったら再開
    this.resume()
  }
})
```

## メッセージ種別

| type | 方向 | 内容 |
|------|------|------|
| `ping` / `pong` | 双方向 | ハートビート（`cpuLoad` を返す） |
| `task` | 受信 | 実行するワークロードと payload |
| `progress` | 送信 | ストリーミング途中のトークン |
| `result` | 送信 | 実行結果 |
| `error` | 送信 | 実行失敗（中断タスクでは送信しない） |
| `abort` | 受信 | 協調側からのタスク中断指示 |
| `swarm-init` / `swarm-slice` / `swarm-start` / `swarm-error` | 双方向 | swarm-inference のセッション制御 |

## タスク受信から実行までの流れ

```
SignalingClient: { type: 'task', taskId, workload, payload, timeoutMs } 受信
    ↓
WorkerPool.run(taskId, workload, payload, timeoutMs, onProgress)
    ↓
{ type: 'progress', taskId, token } 送信（onProgress 経由）
    ↓
{ type: 'result', taskId, payload } 送信
```

同一 `taskId` の重複配信（at-least-once）は `inflightTasks` で排除し、
二重実行しない。協調側から `abort` を受けたタスクは失敗として返送しない。

## エラーハンドリング

- トークン取得失敗 → 指数バックオフで再接続
- 実行タイムアウト → `{ type: 'error', taskId, error: 'TIMEOUT' }` を送信
- 実行例外 → `{ type: 'error', taskId, error: message }` を送信
- いずれの場合も協調側がリトライを判断する

## 同意との関係

`SignalingClient` は同意状態が `granted` のときだけ起動される（`initFlaxiaNode()`）。
同意レコードの検証と `start()` のゲートは
[01-consent-ui.md](./01-consent-ui.md) を参照。