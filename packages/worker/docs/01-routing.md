# 01. Honoルーティング追加方針

## 方針

既存の Flaxia SNS の Hono アプリに対して、`/crowd/` プレフィックス以下に
サブアプリをマウントする形で追加する。既存ルートへの影響はゼロ。

## 実装イメージ

```typescript
// src/index.ts（既存）に追記するだけ
import { crowdApp } from './crowd/index'

app.route('/crowd', crowdApp)
```

## crowdApp が持つルート一覧

| Method | Path | 説明 |
|--------|------|------|
| GET | `/crowd/signal` | WebSocket Upgradeエンドポイント（Signalingサーバー）。ノードトークン必須 |
| GET | `/crowd/subscribe` | WebSocket Upgrade（結果購読）。購読トークン必須 |
| POST | `/crowd/tasks` | タスク投入（@flaxia/sdk から呼ばれる） |
| GET | `/crowd/tasks/:id` | タスク状態取得（所有者テナントのみ） |
| POST | `/crowd/nodes/register` | ノード登録（@flaxia/node から呼ばれる）。nodeId はサーバー発行 |

## 認証方針

- `/crowd/tasks` への投入はAPIキー認証（`Authorization: Bearer <key>`）。
  `API_KEYS` は `key` または `key:tenantId`。テナントを省略したキーは
  キー由来の安定したテナント ID を持つ（キー同士は分離される）。
- `/crowd/signal` はノードトークン認証。トークンは
  `Sec-WebSocket-Protocol: flaxia-node-v1, bearer.<token>` で送る
  （`?token=` は 401 で拒否）。詳細は `07-trust-plane.md`。
- `/crowd/subscribe` は `flaxia-subscribe-v1` + `bearer.<subscribeToken>` 必須。
- ノードからの結果・進捗はすべて `/crowd/signal` の WebSocket 上で受け取り、
  現在の配信試行（attemptId）とソケットの一致を検証する。

## エラーレスポンス形式

すべてのエラーは以下の形式で統一する：

```json
{
  "error": "human readable message",
  "code": "TASK_NOT_FOUND"
}
```

## コードコード一覧

| code | 意味 |
|------|------|
| `UNAUTHORIZED` | 認証失敗 |
| `TASK_NOT_FOUND` | タスクIDが存在しない |
| `NODE_NOT_FOUND` | ノードIDが存在しない |
| `QUEUE_FULL` | キューが満杯 |
| `INVALID_PAYLOAD` | リクエストボディ不正 |
