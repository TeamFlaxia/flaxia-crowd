# 04. ノード登録・死活管理

## 概要

`NodeManager` Durable Object が接続中のブラウザノードを管理する。
WebSocket接続の保持、タスク割り当て、死活確認を担当する。

## Durable Object: NodeManager

### NodeRecord 型定義

```typescript
type NodeStatus = 'idle' | 'busy' | 'disconnected'

type NodeCapability = 'ai-inference' | 'image-process' | 'file-convert'

type NodeRecord = {
  id: string              // サーバー発行。クライアント指定は無視される
  status: NodeStatus
  connectedAt: number
  lastPongAt: number
  capabilities: NodeCapability[]
  cpuLoad: number         // 0.0 - 1.0（自己申告。有限数値以外は前回値を保持）
  currentTaskId?: string
  siteId?: string         // 署名済みノードトークン由来（リクエスト本文は使わない）
  wasmMemoryBytes?: number      // 16 GiB にクランプ
  maxStorageBufferBindingSize?: number // 同上
  warmModels?: WarmModelRange[] // 非負整数 / start < end / end <= 4096
  assignedCount?: number  // 累計割り当て数（公平性のタイブレーク）
}
```

### 内部ストレージ

```typescript
// WebSocket接続はメモリ上で保持（DO内）
private connections: Map<string, WebSocket>

// ノードメタはDO Storageに保存
`node:${nodeId}` → NodeRecord
`nodes:idle`     → nodeId[] (JSON)
```

### 公開メソッド

| メソッド | 説明 |
|---------|------|
| `registerNode(ws, capabilities)` | ノード登録・WebSocket保持 |
| `unregisterNode(nodeId)` | ノード切断処理 |
| `pickNode(workload)` | タスクに適したIDLEノードを選択 |
| `assignTask(nodeId, task)` | ノードにタスクメッセージを送信 |
| `handlePong(nodeId, cpuLoad)` | Pong受信・死活更新 |
| `getIdleNodes()` | IDLE状態のノード一覧 |

## ノード選択アルゴリズム

1. `capabilities` に対象 `workload` が含まれるノードに絞る
2. `lowMemory` ノードは heavy ワークロードから除外する
3. `allowedSites` があるタスクはトークン由来の `siteId` が一致するノードのみ
4. **累計割り当て数（`assignedCount`）が最も少ないノード**を選ぶ
5. 同率なら自己申告 `cpuLoad` を 0.25 刻みに量子化した値が低い順
6. さらに同率なら `connectedAt` が古い順（先着優先）

`cpuLoad` は検証できない自己申告値なので、主キーにはしない。
「割り当て数の少ないノード優先」により、負荷 0 を偽って申告しても
キューを独占できない（詳細は `07-trust-plane.md`）。

## ノード identity（Issue #5）

- `POST /crowd/nodes/register` は常に新しい UUID を発行し、トークンに
  `{ siteId, nodeId, capabilities, exp, ... }` を署名して束縛する。
  リクエストの `nodeId` は無視する。
- `/crowd/signal` はトークン内の `nodeId` / `siteId` だけを使う。
  同一 identity のソケットが既に生きている場合、トークンが証明された後にのみ
  旧ソケットを閉じる（正規ノードを黙って切断しない）。
- ノードトークンの TTL は 2 時間。ノードはトークンを永続化せず、
  再接続のたびに再登録する。

## 死活確認

```
Worker → Node: { type: 'ping' }   （30秒ごと）
Node → Worker: { type: 'pong', cpuLoad }

最後のPongから60秒経過 → disconnectedとしてunregister
```

Durable Objects の Alarm API で30秒ごとにPingを送る：

```typescript
async alarm() {
  await this.pingAll()
  await this.checkStaleNodes()
  await this.state.storage.setAlarm(Date.now() + 30_000)
}
```

## ノードトークン

`/crowd/signal` へのWebSocket接続時にサブプロトコルで認証する。

```
Sec-WebSocket-Protocol: flaxia-node-v1, bearer.<token>
```

- トークンは HMAC-SHA256 署名（KV 不要）。`?token=` は 401 で拒否する。
- `@flaxia/node` 初期化時に `/crowd/nodes/register` を叩いてトークンを取得
- トークンの有効期限は 2 時間。`localStorage` には保存せずメモリのみ保持し、
  ページ再読み込みや再接続のたびに再登録（＝ローテーション）する。
- ホスト選出はクランプ後の容量順だが、**異なる候補が 2 台以上**必要。
  1 台だけでは swarm を開始しない。
