# ワーカーオーケストレータガイド (@flaxia/worker)

タスクのキューイング、マッチング、ライフサイクル管理を担当する Cloudflare Workers ベースのオーケストレーターです。

## 主な役割

- **Coordinator Durable Object**: `COORDINATOR` バインディングの単一クラス
  `Coordinator` が、タスクキュー、ノードの WebSocket シグナリング
  (`/ws`)、購読 (`/subscribe`)、レート制限、ハートビートをすべて担当します。
  `TaskQueue` / `NodeManager` という別の DO は存在しません。
- **Signaling**: ワーカー側 (`src/crowd/index.ts`) が HMAC トークンを検証し、
  署名済みの `nodeId` / `capabilities` / エキスパート能力を DO へ渡します。
- **配置**: アイドルノードのキャッシュ (ベースモデルと LoRA アダプタは別エントリ)
  と負荷を見て、Theia の `expert` タスクは能力を登録したノードにのみ送ります。

## 開発・デプロイ設定 (wrangler.toml)

`packages/worker/wrangler.toml` に必要な設定はすべて含まれています。`CROWD_KV`
は使いません（ノードトークンは KV 不要の HMAC 方式）。

```toml
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

Secret は `wrangler secret put` で設定します（`.dev.vars.example` も参照）。

```bash
wrangler secret put API_KEYS
wrangler secret put NODE_TOKEN_SECRET
wrangler secret put SUBSCRIBE_TOKEN_SECRET
wrangler secret put WEBHOOK_SIGNING_SECRET
```

## タスクのライフサイクル

1. **pending**: SDK から投入され、キューに入る。
2. **processing**: ノードへ配信され、実行中。`attemptId` とリザベーションで
   現在の配送だけが完了/失敗を報告できる。
3. **done**: 結果が確定し、購読者と webhook に配信される。
4. **failed**: 失敗が確定する。一時的な失敗（タイムアウト・切断）は
   最大 3 回まで pending に戻して再配置し、恒久的な失敗は即座に確定する。

`ASSIGNING` という状態はありません。割り当ては `pending` → `processing` の
遷移として同じポーリング内で行われます。

## タイムアウトと pending TTL

- 実行タイムアウトはタスクの `timeoutMs`（未指定時は SDK のワークロード既定値、
  `theia-inference` は 30 分、他は 60 秒）です。
- pending の期限は `min(timeoutMs, workload cap)` です。通常の cap は 5 分ですが、
  `theia-inference` は LoRA エキスパートを持つノードを待つため cap が 30 分
  （Theia 側のデフォルトタイムアウトと同じ）です。短い `timeoutMs` は尊重されます。
- 期限内に適格ノードが現れない場合は「`No eligible node picked up <workload>
  before its N-minute queue deadline`」という理由で**恒久失敗**にします。
  再キューしても同じノードプールに当たるだけなので再試行しません。
- `alarm()` は 30 秒ごとに processing のタイムアウトと pending の期限を巡回し、
  60 秒以上 pong のないノードを stale として削除します。

Theia の pending TTL は `pendingTtlMs()` / `THEIA_MAX_PENDING_TTL_MS`
(`src/worker/Coordinator.ts`) とテストで固定しています。変更するときは
`docs/theia-integration.md` も合わせて更新してください。

## 冗長化方針

「1 タスク 1 ノード」の構成です。リトライ回数（最大 3 回）は `Coordinator` が
管理し、タイムアウト時は試行 generation を進めて再キューイングします。
結果は attempt id とソケットで束縛されるため、古い試行の遅延メッセージは
タスクを確定できません。
