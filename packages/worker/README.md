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
                  │  POST /crowd/nodes/register      │
                  │                                  │
  Browser Node ───→│  GET  /crowd/signal    (WS)     │
  (計算ノード)      │  （結果・進捗も同じ WS 上）      │
                  └────────────────┬─────────────────┘
                                   │
                          ┌────────▼─────────┐
                          │ Coordinator (DO) │
                          │                  │
                          │ タスク管理 / 割り当て │
                          │ 配信試行 (attempt) │
                          │ ノード選定 / 死活  │
                          │ swarm ブローカー   │
                          │ 購読・Webhook 通知 │
                          └──────────────────┘
```

## エンドポイント

| Method | Path | 認証 | 説明 |
|--------|------|------|------|
| `GET` | `/health` | - | ヘルスチェック（`OK` を返す） |
| `GET` | `/crowd/signal` | ノードトークン（`flaxia-node-v1` + `bearer.<token>`） | ノード接続用 WebSocket アップグレード |
| `GET` | `/crowd/subscribe` | 購読トークン（`flaxia-subscribe-v1` + `bearer.<token>`） | タスク状態購読用 WebSocket アップグレード |
| `POST` | `/crowd/tasks` | API キー | タスク投入（`subscribeToken` を返す） |
| `GET` | `/crowd/tasks/:id` | API キー（所有者テナントのみ） | タスク状態取得 |
| `POST` | `/crowd/nodes/register` | -（nodeId はサーバー発行） | ノード登録 |

信頼境界の全体像（テナント分離・配信試行・サイト allow-list・上限値・
Webhook 署名の意味）は `docs/07-trust-plane.md` を参照。

## Durable Objects

### Coordinator

タスクのライフサイクル、ノード接続、swarm セッション、購読、Webhook 通知を
1 つの Durable Object（`global-coordinator`）で管理します。

**状態遷移:**
```
pending ──→ processing ──→ done
                │              failed
                │
                └──→ pending (リトライ, max 3回)
```

**責務:**
- タスクの enqueue / 状態取得（テナント別キー）
- ノードの WebSocket 接続受付（`/crowd/signal`）と選定
- Ping/Pong によるハートビート（30s間隔、60s応答なしで切断）
- 配信試行（attemptId）の発行と結果・進捗の検証
- swarm セッションのブローカー（ホスト権限の検証）
- ノード切断時のタスク再割り当て or 失敗処理
- Alarm によるタイムアウト / pending TTL / 死活の定期チェック（30s）
- SDK クライアントへのタスク状態通知（`/crowd/subscribe`）と Webhook 署名配送

## データモデル

### TaskRecord

| フィールド | 型 | 説明 |
|-----------|-----|------|
| `id` | `string` | タスクID (UUID) |
| `status` | `'pending' \| 'assigning' \| 'processing' \| 'done' \| 'failed'` | 状態 |
| `workload` | `WorkloadType` | ワークロード種別 |
| `payload` | `TaskPayload` | 入力データ |
| `tenantId` | `string` | 所有テナント（API キーから解決） |
| `allowedSites` | `string[]?` | 実行を許可するノードサイト |
| `retryCount` | `number` | リトライ回数（最大 3） |
| `timeoutMs` | `number` | タイムアウト（1s..1h） |
| `callbackUrl` | `string?` | 完了時コールバックURL（要 `WEBHOOK_SIGNING_SECRET`） |
| `result` | `unknown?` | 実行結果（プレーンオブジェクトのみ、4 MiB 以下） |
| `error` | `string?` | エラーメッセージ |
| `resultNodeId` | `string?` | 結果を受理したノード（監査用） |
| `resultAttemptId` | `string?` | 結果を受理した配信試行（監査用） |

### NodeRecord

| フィールド | 型 | 説明 |
|-----------|-----|------|
| `id` | `string` | ノードID（サーバー発行、トークンに束縛） |
| `status` | `'idle' \| 'busy'` | 状態 |
| `capabilities` | `WorkloadType[]` | 対応ワークロード一覧 |
| `cpuLoad` | `number` | 自己申告の CPU 負荷（0-1、有限数値のみ採用） |
| `siteId` | `string?` | 署名済みトークン由来のサイト ID |
| `currentTaskId` | `string?` | 実行中のタスクID |
| `assignedCount` | `number?` | 累計割り当て数（公平性のタイブレーク） |

## WebSocket プロトコル

### Node → Worker

| type | 説明 |
|------|------|
| `pong` | ハートビート応答（`cpuLoad` を含む。不正値は無視） |
| `progress` | 中間トークン（`attemptId` 必須、4KB/秒間50件まで） |
| `result` | タスク実行結果（`attemptId` 必須） |
| `error` | タスク実行エラー（`attemptId` 必須。swarm はホストのみ） |
| `swarm-plan` / `swarm-ready` | swarm セッション制御（ホスト / メンバー） |
| `swarm-error` / `swarm-done` / `swarm-token` | swarm セッション（ホストのみ有効） |

### Worker → Node

| type | 説明 |
|------|------|
| `ping` | ハートビート（30s間隔） |
| `task` | タスク割り当て（`taskId`, `workload`, `payload`, `attemptId`） |
| `swarm-init` | swarm セッション開始（ホストへ。`attemptId` 付き） |
| `swarm-slice` / `swarm-start` | swarm スライス配布 / 開始 |
| `abort` | セッション中断（タイムアウト・ピア失敗など） |

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
| Durable Object | `COORDINATOR` (Coordinator) |
| 互換性日付 | 2024-04-03 |

必要に応じて `wrangler secret put` で環境変数を設定してください:

```bash
npx wrangler secret put NODE_TOKEN_SECRET       # ノード登録トークン署名
npx wrangler secret put SUBSCRIBE_TOKEN_SECRET  # /crowd/subscribe トークン署名
npx wrangler secret put WEBHOOK_SIGNING_SECRET  # Webhook 署名専用
```

`API_KEYS` は `key` または `key:tenantId` を受け付ける（テナント単位の分離）。
