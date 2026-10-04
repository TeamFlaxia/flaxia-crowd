# 02. ノードクライアント（Signaling接続管理）

## 概要

同意後、Signalingサーバー（Cloudflare Workers）にWebSocket接続し、
タスクの受信・WebRTC接続の確立を管理する。

## 接続フロー

```
1. POST /crowd/nodes/register { siteId, capabilities, wasmMemoryBytes, swarm }
   → { token, nodeId, expiresAt }（nodeId はサーバー発行。リクエストの nodeId は無視される）
2. WS  /crowd/signal
   Sec-WebSocket-Protocol: flaxia-node-v1, bearer.<token>
   → 101 Switching Protocols（Sec-WebSocket-Protocol: flaxia-node-v1）
3. タスク待機状態へ（タスクは { type: 'task', taskId, workload, payload, timeoutMs, attemptId } で届く）
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
  private readonly MAX_RECONNECT = 5

  async connect(orchestratorUrl: string, siteId: string): Promise<void>
  disconnect(): void
  private onMessage(event: MessageEvent): void
  private scheduleReconnect(): void
}
```

## 再接続ロジック

指数バックオフで最大5回まで再接続を試みる：

```
1回目: 1秒後
2回目: 2秒後
3回目: 4秒後
4回目: 8秒後
5回目: 16秒後
→ 諦める（ユーザーには通知しない・サイレント）
```

ページのvisibility変化にも対応する：

```typescript
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    // バックグラウンドになったら切断（CPU節約）
    this.disconnect()
  } else {
    // フォアグラウンドに戻ったら再接続
    this.connect(...)
  }
})
```

## WebRTCPeer 実装方針

```typescript
class WebRTCPeer {
  private pc: RTCPeerConnection
  private dataChannel: RTCDataChannel | null = null

  // Workerからofferを受け取りanswerを生成
  async handleOffer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit>

  // DataChannelでタスクのpayloadを受け取り・結果を返す
  private onDataChannel(channel: RTCDataChannel): void
}
```

## ICE設定

```typescript
const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  // TURNはPhase 2で追加検討
]
```

## タスク受信から実行までの流れ

```
SignalingClient: { type: 'task', taskId, workload, payload, timeoutMs, attemptId } 受信
    ↓
attemptId を保持（タスクごと）
    ↓
WorkerExecutor.run(workload, payload) 呼び出し
    ↓
進捗: { type: 'progress', taskId, token, attemptId } 送信
    ↓
完了: { type: 'result', taskId, payload, attemptId } 送信
失敗: { type: 'error', taskId, error, attemptId } 送信
```

### 配信試行（attemptId）は必須（Issue #4）

コーディネーターは配信ごとに新しい `attemptId` を発行し、
**(a) 現在の attemptId を持つ** **(b) その配信を受け取ったソケットから届く**
メッセージだけを受理する。したがって:

- `result` / `progress` / `error` には必ず受信した `attemptId` を付ける。
  欠落・旧試行の ID は状態を変えずに破棄される。
- 再配信（再接続時のレジューム）では新しい attemptId が届く。古い ID での
  報告は無視されるので、常に最後に受け取った値を使う。
- swarm では `swarm-init` の `attemptId` をセッションの結果・進捗・エラーに使う。
  `swarm-token` / `swarm-done` などの制御メッセージにも同じ値を付与する。

## エラーハンドリング

- 処理失敗 → `{ type: 'error', taskId, error, attemptId }` を送信
- 処理タイムアウト → 同上（`error: 'TIMEOUT'`）
- いずれの場合もWorker側がリトライ（最大 3 回）を処理する
- `{ type: 'abort' }` を受信したタスクはローカルで停止し、失敗を報告しない
  （コーディネーターが既に再キューしている可能性があるため）
