# @flaxia/worker

Cloudflare Workers + Durable Objects による**オーケストレーター**実装。
ブラウザノードの Signaling サーバー、タスクキュー管理、ノード状態管理を担当します。

## アーキテクチャ

```
                  ┌──────────────────────────────────┐
                  │        Worker (Hono App)         │
                  │                                  │
  SDK Client ────→│  GET  /health                    │
  (タスク依頼者)   │  POST /crowd/tasks               │
                  │  GET  /crowd/tasks/:id            │
                  │  GET  /crowd/subscribe  (WS)     │
                  │  GET  /crowd/nodes               │
                  │                                  │
  Browser Node ───→│  GET  /crowd/signal    (WS)     │
  (計算ノード)      │  POST /crowd/tasks/:id/result   │
                  └────────┬─────────┬───────────────┘
                           │         │
                  ┌────────▼──┐ ┌───▼──────────┐
                  │ TaskQueue │ │ NodeManager  │
                  │ (DO)      │ │ (DO)         │
                  │           │ │              │
                  │ タスク管理 │ │ WebSocket    │
                  │ 割り当て │ │ ノード選定   │
                  │ リトライ  │ │ ハートビート │
                  │ タイムアウト│ │ 結果中継     │
                  └───────────┘ └──────────────┘
```

## エンドポイント

| Method | Path | 説明 |
|--------|------|------|
| `GET` | `/health` | ヘルスチェック（`OK` を返す） |
| `GET` | `/crowd/signal` | ノード接続用 WebSocket アップグレード |
| `GET` | `/crowd/subscribe` | タスク状態購読用 WebSocket アップグレード |
| `POST` | `/crowd/tasks` | タスク投入 |
| `GET` | `/crowd/tasks/:id` | タスク状態取得 |
| `POST` | `/crowd/tasks/:id/result` | ノードからの結果投稿 |
| `GET` | `/crowd/nodes` | 接続中ノード一覧 |

## Durable Objects

### TaskQueue

タスクのライフサイクルを管理します。

**状態遷移:**
```
pending ──→ processing ──→ done
                │              failed
                │
                └──→ pending (リトライ, max 3回)
```

**責務:**
- タスクの enqueue / 状態取得
- NodeManager への割り当て要求
- タイムアウト検出とリトライ
- Alarm による定期的なタイムアウトチェック（pending あれば2s, なければ10s）

### NodeManager

WebSocket 接続を管理し、タスク割り当てとノード健全性を監視します。

**責務:**
- ノードの WebSocket 接続受付（`/crowd/signal`）
- ノード選定（capability 一致 → CPU負荷最低 → 接続時間最古）
- Ping/Pong によるハートビート（30s間隔、60s応答なしで切断）
- タスク結果・進捗トークンの中継
- ノード切断時のタスク再割り当て or 失敗処理
- SDK クライアントへのタスク状態通知（`/crowd/subscribe`）

## データモデル

### TaskRecord

| フィールド | 型 | 説明 |
|-----------|-----|------|
| `id` | `string` | タスクID (UUID) |
| `status` | `'pending' \| 'assigning' \| 'processing' \| 'done' \| 'failed'` | 状態 |
| `workload` | `WorkloadType` | ワークロード種別 |
| `payload` | `TaskPayload` | 入力データ |
| `retryCount` | `number` | リトライ回数 |
| `timeoutMs` | `number` | タイムアウト（デフォルト30000） |
| `callbackUrl` | `string?` | 完了時コールバックURL |
| `result` | `unknown?` | 実行結果 |
| `error` | `string?` | エラーメッセージ |

### NodeRecord

| フィールド | 型 | 説明 |
|-----------|-----|------|
| `id` | `string` | ノードID |
| `status` | `'idle' \| 'busy' \| 'disconnected'` | 状態 |
| `capabilities` | `WorkloadType[]` | 対応ワークロード一覧 |
| `cpuLoad` | `number` | CPU負荷（0-1） |
| `currentTaskId` | `string?` | 実行中のタスクID |

## WebSocket プロトコル

### Node → Worker

| type | 説明 |
|------|------|
| `pong` | ハートビート応答（`cpuLoad` を含む） |
| `progress` | 中間トークン（AI推論のストリーミング出力） |
| `result` | タスク実行結果 |
| `error` | タスク実行エラー |

### Worker → Node

| type | 説明 |
|------|------|
| `ping` | ハートビート（30s間隔） |
| `task` | タスク割り当て（`taskId`, `workload`, `payload`） |

### Worker → SDK Client

| type | 説明 |
|------|------|
| `subscribed` | 購読開始 |
| `token` | 進捗トークン（ストリーミング） |
| `done` | タスク完了 |
| `error` | タスク失敗 |

## 開発

```bash
# ローカル開発
npm run dev

# デプロイ
npm run deploy

# テスト
npm run test
```

## 設定 (wrangler.toml)

| 設定 | 値 |
|------|-----|
| Worker名 | `flaxia-worker` |
| エントリ | `src/index.ts` |
| Durable Object | `TASK_QUEUE` (TaskQueue), `NODE_MANAGER` (NodeManager) |
| 互換性日付 | 2024-04-03 |

認証情報は `wrangler.toml` に書かず、Cloudflare Secrets で設定してください:

```bash
npx wrangler secret put API_KEYS
npx wrangler secret put NODE_TOKEN_SECRET
```

`API_KEYS` はカンマ区切りで複数キーを受け付けるため、`new,old` → `new` の2段階で無停止ローテーションできます。公開されたキーは必ず失効させ、ブラウザ向けの `VITE_*` 環境変数には秘密を入れないでください。
