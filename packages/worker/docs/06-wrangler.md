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

[[d1_databases]]
binding = "DB"
database_name = "flaxia-crowd-keys"
database_id = "9ef5f678-2e15-4026-aa57-4e4f9659efcc"
migrations_dir = "./migrations"

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
| `DB` | D1 (`flaxia-crowd-keys`) | 登録済み API キーの SHA-256 ハッシュとテナント ID |
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

## D1 による API キー登録（追加ホストなど）

`API_KEYS` Secret を書き換えずにキーを追加できる。`api_keys` テーブルには
キー自身ではなく **`SHA-256(キーの UTF-8 バイト)` の小文字 64 桁 hex** だけを保存する
（`security.ts` の `resolveTenantIdFromDb` と同じ形式。`sha256=` プレフィックスや
base64 は付けない）。Worker は受け取った Bearer トークンを同じ方法でハッシュ化して照合する。

スキーマは `migrations/0001_api_keys.sql` にあり、Wrangler が期待する
`0001_<name>.sql` の命名に従う。デプロイ workflow が `wrangler deploy` の前に
`npx wrangler d1 migrations apply flaxia-crowd-keys --remote` を実行する。
適用済みマイグレーションは D1 の `d1_migrations` テーブルに記録され、SQL 自体も
`CREATE TABLE IF NOT EXISTS` なので再実行は冪等である。手動で適用する場合も同じ
コマンドを `packages/worker` で実行する。

登録手順（以下は `packages/worker` をカレントディレクトリとして実行する）:

```bash
# キーは argv に渡さない。シェル履歴に残したくない場合は read -s を使う（bash）。
read -rsp 'API key: ' API_KEY; echo
API_KEY="$API_KEY" node scripts/add-api-key.mjs --tenant tenant-b --execute
```

- `API_KEY` 環境変数が無い場合は stdin から読む。例:
  `printf '%s' "$API_KEY" | node scripts/add-api-key.mjs --tenant tenant-b --execute`
- `--execute` を外すと INSERT 文を標準出力するだけで、D1 は変更しない。
  出力にはハッシュとテナント ID のみが含まれ、生キーは決して表示されない。
- `--tenant` を省略すると既定値は `key-<ハッシュの先頭 16 桁>` になる。これは
  `API_KEYS` にテナントを明示しなかったレガシーキーと同じ安定 ID で、
  キーごとに別テナントになる（安全な既定値）。

登録結果の確認（ハッシュだけが表示されるので安全）:

```bash
npx wrangler d1 execute flaxia-crowd-keys --remote \
  --command "SELECT key_hash, tenant_id FROM api_keys WHERE tenant_id = 'tenant-b';"
# 期待値の確認: printf '%s' "$API_KEY" | sha256sum
```

`key_hash` は小文字 64 桁の hex（`sha256sum` の出力と同じ値）、`tenant_id` は
指定したテナント（または既定の `key-...`）になる。

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
