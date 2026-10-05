# 02. ノードクライアント（Signaling接続管理）

## 概要

同意後、Signalingサーバー（Cloudflare Workers）にWebSocket接続し、
タスクの受信・実行・結果返送を管理する。

タスクのペイロードも結果も**すべてWebSocket上を流れる**。
WebRTC（DataChannel / offer / answer / ICE）は使用しない。

## 接続フロー

```
1. POST /crowd/nodes/register { siteId, capabilities, wasmMemoryBytes, swarm }
   → { token, nodeId, expiresAt }（nodeId はサーバー発行。リクエストの nodeId は無視される）
2. WS /crowd/signal
   Sec-WebSocket-Protocol: flaxia-node-v1, bearer.<token>
   → 101 Switching Protocols（Sec-WebSocket-Protocol: flaxia-node-v1）
3. タスク待機状態へ（task/attemptId を含む配信制御メッセージを受け取る）
```

### トークン輸送（Issue #20）

ブラウザの `WebSocket` はリクエストヘッダを設定できないため、トークンは
**サブプロトコル一覧**で送る。`?token=` はアクセスログ・Referer に残るので
worker が 401 で拒否する。

```typescript
import { buildNodeSignalProtocols } from '@flaxia/sdk'

const ws = new WebSocket('wss://host/crowd/signal', buildNodeSignalProtocols(token))
```

- トークンは `localStorage` に保存しない（メモリのみ）。ページ再読み込みや
  再接続のたびに再登録するため、TTL 2 時間のトークンが自然にローテーションされる。
- 旧バンドルが保存した `flaxia_node_token` は起動時に削除する。
- ハンドシェイクが完了する前に切断された場合（401 等）はキャッシュを捨て、
  次回は再登録する。

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

指数バックオフ（最大30秒）で再接続を試みる（1秒、2秒、4秒…上限30秒）。
ページのvisibility変化にも対応し、バックグラウンド時は停止、復帰時に再接続する。

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

## 配信試行（attemptId）は必須（Issue #4）

コーディネーターは配信ごとに新しい `attemptId` を発行し、現在の ID と配信を受けた
ソケットから届くメッセージだけを受理する。欠落・旧試行の `result` / `progress` / `error`
は状態を変えずに破棄される。swarm 制御メッセージもセッションの attempt に束縛される。

## エラーハンドリング

- 処理失敗・タイムアウトは `{ type: 'error', taskId, error, attemptId }` として報告する。
- `{ type: 'abort' }` を受信したタスクはローカルで停止し、失敗を報告しない。
- いずれの場合も Worker 側がリトライ（最大 3 回）を判断する。

## 同意との関係

`SignalingClient` は同意状態が `granted` のときだけ起動される（`initFlaxiaNode()`）。
同意レコードの検証と `start()` のゲートは
[01-consent-ui.md](./01-consent-ui.md) を参照。
