# 06. wrangler.toml / バインディングと Secret

## 概要

`packages/worker/wrangler.toml` が本番設定の解析元です。以前の
`TASK_QUEUE` / `NODE_MANAGER` DO と `CROWD_KV` は使われていません。
現在は単一の `COORDINATOR` Durable Object（SQLite バックエンド）が
タスクキュー・ノード登録・シグナリングを担います。

```toml
name = "flaxia-worker"
main = "src/index.ts"
compatibility_date = "2024-04-03"

[vars]
CORS_ORIGINS = "http://localhost:5173,http://localhost:5174,http://localhost:8787,https://flaxia.app,https://*.flaxia.app"
RATE_LIMIT_MAX = "100"
MAX_PAYLOAD_SIZE = "1048576"

[[durable_objects.bindings]]
name = "COORDINATOR"
class_name = "Coordinator"

[[migrations]]
tag = "v7"
new_sqlite_classes = ["Coordinator"]
```

## バインディング一覧

| 名前 | 種別 | 用途 |
|------|------|------|
| `COORDINATOR` | Durable Object (`Coordinator`) | キュー、ノード状態、WebSocket、レート制限 |
| `CORS_ORIGINS` | var | 許可オリジン（カンマ区切り、ワイルドカード可） |
| `RATE_LIMIT_MAX` | var | IP あたりの 1 分間のリクエスト上限 |
| `MAX_PAYLOAD_SIZE` | var | タスク取り込みのサイズ上限 |
| `TENANT_SCHEDULING_WEIGHTS` | 任意の var | テナント別公平キューの重み (JSON) |
| `WORKER_VERSION` / `WORKER_COMMIT_SHA` | 自動注入 | `scripts/deploy.mjs` がビルド情報として設定 |

`CROWD_KV` は不要です。ノード認証は KV レスの HMAC-SHA256 トークン方式です。

## 環境変数（secrets）

`Env` (`src/index.ts`) が読み取る Secret は 4 つです。すべて
`wrangler secret put` で設定し、`wrangler.toml` には書きません。

```bash
wrangler secret put API_KEYS                # タスク API 用。カンマ区切りで複数キーをローテーション可能
wrangler secret put NODE_TOKEN_SECRET       # ノード登録トークンの署名（必須）
wrangler secret put SUBSCRIBE_TOKEN_SECRET  # /crowd/subscribe トークンの署名（必須）
wrangler secret put WEBHOOK_SIGNING_SECRET  # Webhook 署名専用（callbackUrl を使うなら必須）
```

- `API_KEYS` は `wrangler.toml` に書かない。未設定ならタスク投入・取得は 401でfail closedする。
- `NODE_TOKEN_SECRET` を設定しない場合、`/crowd/nodes/register` は 503 を返し、ノードは接続できない。
- `SUBSCRIBE_TOKEN_SECRET` を設定しない場合、`/crowd/subscribe` は 503 を返す。
- `WEBHOOK_SIGNING_SECRET` を設定しない場合、`callbackUrl` 付きのタスク投入は
  400 で拒否される（無署名 Webhook を黙って送らないため）。
- 3 つの署名 Secret は用途ごとに分離する（1 つの漏洩が他へ波及しないように）。
- ローカル開発時は `wrangler.toml` と同じディレクトリに `.dev.vars` を作成し、
  `.dev.vars.example` をコピーして 4 つの値を記述する（`.dev.vars` は gitignore 対象）。

`API_KEYS` はテナント単位のアクセス制御に対応する:

```toml
[vars]
# 明示テナント: このキーは tenant-a のタスクだけを読み書きできる
API_KEYS = "fc_live_example_a:tenant-a,fc_live_example_b:tenant-b"
# テナント省略時は key-<sha256先頭16hex> が自動で割り当てられる（後方互換）
```

（本番では `[vars]` ではなく Secret として設定します。上記は形式の例です。）

### APIキーのローテーション

既存キーがリポジトリやブラウザbundleへ露出した場合は、その値を再利用しない。

1. 新しい高エントロピーなキーを生成する。
2. 移行期間だけ `API_KEYS=new_key,old_key` を Secret として設定する。
3. サーバー側クライアント／プロキシを `new_key` に切り替える。
4. 動作確認後、`API_KEYS=new_key` に更新して旧キーを失効させる。
5. `VITE_*` 等、ブラウザbundleへ展開される環境変数にAPIキーを置かない。

## ノード登録フロー（HMACトークン）

1. `POST /crowd/nodes/register` に `{ siteId, capabilities }` を送信 →
   `{ token, nodeId, expiresAt }` を返却（有効期限2時間）。
   リクエストの `nodeId` は**無視**され、常にサーバーが新しい UUID を発行する。
2. `WS /crowd/signal` に
   `Sec-WebSocket-Protocol: flaxia-node-v1, bearer.<token>` で接続。
   署名と期限を検証し、`nodeId` / `siteId` / `capabilities` はトークン内の値のみを使う。
   ワーカーは `/ws` へ内部リクエストを出し、`Coordinator` が DO に接続を引き継ぐ。

## デプロイ確認

```bash
npm run typecheck
npm test --workspaces --if-present
wrangler deploy --dry-run   # 差分確認
wrangler deploy             # 本番反映（`crowd-v*` タグでは CI が実行）
```

## ローカル開発

```bash
wrangler dev   # Durable Object はローカルエミュレートされる（KV は不要）
```

WebSocketのテスト：

```bash
# クエリのトークンは拒否される。サブプロトコルで渡すこと。
npx wscat -c "ws://localhost:8787/crowd/signal" \
  -s flaxia-node-v1 -s "bearer.<node-token>"
```
