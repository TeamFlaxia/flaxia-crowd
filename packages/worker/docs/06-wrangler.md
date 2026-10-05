# 06. wrangler.toml 追記内容

## 概要

既存の `wrangler.toml` に以下のセクションを**追記**する。
既存設定は一切変更しない。

## 追記内容

```toml
# ───────────────────────────────────────────
# Flaxia Crowd — 追記分
# ───────────────────────────────────────────

[[durable_objects.bindings]]
name = "TASK_QUEUE"
class_name = "TaskQueue"

[[durable_objects.bindings]]
name = "NODE_MANAGER"
class_name = "NodeManager"

[[migrations]]
tag = "v2-crowd"
new_classes = ["TaskQueue", "NodeManager"]

[[kv_namespaces]]
binding = "CROWD_KV"
id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"  # wrangler kv:namespace create CROWD_KV で取得

# ノードトークン・タスク結果の保存に使用
```

## バインディング一覧

| バインディング名 | 種別 | 用途 |
|----------------|------|------|
| `TASK_QUEUE` | Durable Object | タスクキュー管理 |
| `NODE_MANAGER` | Durable Object | ノード接続管理 |
| `CROWD_KV` | KV Namespace | トークン・結果キャッシュ |

## 環境変数（secrets）

以下は `wrangler secret put` で設定する（wrangler.tomlには書かない）：

```bash
wrangler secret put API_KEYS                # タスクAPI用。カンマ区切りで複数キーをローテーション可能
wrangler secret put NODE_TOKEN_SECRET       # ノード登録トークンの署名（必須）
wrangler secret put SUBSCRIBE_TOKEN_SECRET  # /crowd/subscribe トークンの署名（必須）
wrangler secret put WEBHOOK_SIGNING_SECRET  # Webhook 署名専用（callbackUrl を使うなら必須）
```

- `API_KEYS` は `wrangler.toml` に書かない。未設定ならタスク投入・取得は401でfail closedする。
- `NODE_TOKEN_SECRET` を設定しない場合、`/crowd/nodes/register` は503を返し、ノードは接続できない。
- `SUBSCRIBE_TOKEN_SECRET` を設定しない場合、`/crowd/subscribe` は503を返す。
- `WEBHOOK_SIGNING_SECRET` を設定しない場合、`callbackUrl` 付きのタスク投入は
  400 で拒否される（無署名 Webhook を黙って送らないため）。
- 3 つの secret は用途ごとに分離する（1 つの漏洩が他へ波及しないように）。
- ローカル開発時は `wrangler.toml` と同じディレクトリに `.dev.vars` を作成し
  `API_KEYS=...` や `NODE_TOKEN_SECRET=...` などを記述する。

`API_KEYS` はテナント単位のアクセス制御に対応する:

```toml
[vars]
# 明示テナント: このキーは tenant-a のタスクだけを読み書きできる
API_KEYS = "fc_live_example_a:tenant-a,fc_live_example_b:tenant-b"
# テナント省略時は key-<sha256先頭16hex> が自動で割り当てられる（後方互換）
```

### APIキーのローテーション

既存キーがリポジトリやブラウザbundleへ露出した場合は、その値を再利用しない。

1. 新しい高エントロピーなキーを生成する。
2. 移行期間だけ `API_KEYS=new_key,old_key` を Secret として設定する。
3. サーバー側クライアント／プロキシを `new_key` に切り替える。
4. 動作確認後、`API_KEYS=new_key` に更新して旧キーを失効させる。
5. `VITE_*` 等、ブラウザbundleへ展開される環境変数にAPIキーを置かない。

## ノード登録フロー（HMACトークン）

ノード認証はKV不要のHMAC-SHA256署名トークン方式。

1. `POST /crowd/nodes/register` に `{ siteId, capabilities }` を送信 →
   `{ token, nodeId, expiresAt }` を返却（有効期限2時間）。
   リクエストの `nodeId` は**無視**され、常にサーバーが新しい UUID を発行する。
2. `WS /crowd/signal` に
   `Sec-WebSocket-Protocol: flaxia-node-v1, bearer.<token>` で接続。
   署名と期限を検証し、`nodeId` / `siteId` はトークン内の値のみを使う。

## KV Namespace の作成コマンド

```bash
# 本番
wrangler kv:namespace create CROWD_KV

# ローカル開発用（preview）
wrangler kv:namespace create CROWD_KV --preview
```

作成後に表示される `id` を `wrangler.toml` の該当箇所に記入する。

## デプロイ確認

```bash
wrangler deploy --dry-run   # 差分確認
wrangler deploy             # 本番反映
```

## ローカル開発

```bash
wrangler dev   # Durable Objects・KVともにローカルエミュレートされる
```

WebSocketのテスト：

```bash
# クエリのトークンは拒否される。サブプロトコルで渡すこと。
npx wscat -c "ws://localhost:8787/crowd/signal" \
  -s flaxia-node-v1 -s "bearer.<node-token>"
```
