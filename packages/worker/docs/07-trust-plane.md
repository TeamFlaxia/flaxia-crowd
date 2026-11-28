# 07. トラストプレーン（テナント・試行・サイト・上限）

セキュリティ修正（Issue #3 / #4 / #5 / #6 / #10 / #13 / #14 / #20 / #21）で導入した
信頼境界の契約をまとめる。実装は `src/crowd/index.ts`（Worker 境界）と
`src/worker/Coordinator.ts`（Durable Object）にある。

## 1. テナント分離（Issue #3）

- `API_KEYS` は `key` または `key:tenantId` のカンマ区切り。
  テナントを書かない既存キーは `key-` + SHA-256(key) の先頭 16 hex を
  テナント ID として自動導出する。**既存キーはそのまま動く**が、
  キー同士は互いのタスクを読めない。
- タスクは `task:<tenantId>:<taskId>` に保存し、`taskindex:<taskId>` →
  `tenantId` は内部の逆引き専用（ノードの結果メッセージがタスクを解決するため）。
  REST の読み取りは必ず `task:<tenantId>:<taskId>` を直接引くため、
  他テナントのタスクは存在しないのと同じ 404 になる。
- `POST /crowd/tasks` は呼び出し元テナントを記録し、
  `GET /crowd/tasks/:id` / `/crowd/subscribe` / Webhook はすべてそのテナントに閉じる。

## 2. サイト allow-list（NOT IMPLEMENTED）

- **未実装**。ノードの `siteId` は署名済みノードトークンから取り出す
  （`/crowd/signal` が `site` として DO に渡す）が、サイト所有の証明は存在しない。
  そのため `payload.allowedSites` を付けたタスクは Coordinator が
  割り当てず、キュー TTL 後に恒久失敗していた。
- 現在は `POST /crowd/tasks` の検証で `allowedSites` 付きの投入を
  **`400`（`unsupported (NOT IMPLEMENTED)`）で即時拒否**する。キューに積まれない。
  `TaskRecord.allowedSites` は古いレコードとの互換のためだけに残っている。

### 残存リスク（重要）

ボランティアノードは**実行するペイロードそのものを読める**。仮に allow-list が
存在しても「どのサイトのノードに渡すか」を絞るだけで、渡したノードが内容を見る
ことを防ぐものではない。機密性が必要な入力はホスト側で暗号化し、信頼できる
ノードのみを登録する運用（`CORS_ORIGINS` と `siteId` の管理）で担保すること。

## 3. 配信試行（attempt）と結果の真正性（Issue #4 / #21）

- タスク配信（`task`）にはコーディネーター生成の
  `attemptId` が必ず入る。再配信・リトライのたびに新しい値へ更新し、
  直前の試行は退役（`attempt:<taskId>` を削除）する。
- `result` / `error` / `progress` は
  **(a) 現在の `attemptId` を持つ**、**(b) その配信を受け取ったソケットから届く**
  の両方を満たす場合のみ受理する。それ以外は状態を一切変更せず破棄する。
- `result` は「プレーンオブジェクト」かつ **UTF-8 直列化後 4 MiB 以下**
  （`MAX_RESULT_BYTES`）のみ受理する。文字数 rather than バイト数で見ると
  UTF-16 の文字数で見ると多バイト文字で上限を約 3 倍超過できるため、
  `TextEncoder` で実バイトを測る。
  壊れた/過大な結果は done にせず、失敗にもしない（捨てる）。
- `progress` のトークンは文字列かつ 4 KB 以下、タスクごとに毎秒 50 件まで。
  違反は転送せず破棄する。
- 監査のため、受理した結果のノード ID と attempt ID を
  `TaskRecord.resultNodeId` / `resultAttemptId` に記録し、Webhook 本文にも含める。

## 4. ノード identity（Issue #5）

- `POST /crowd/nodes/register` はクライアント指定の `nodeId` を**無視**し、
  常に新しい UUID を発行してトークンに束縛する。トークンは
  `{ siteId, nodeId, capabilities, exp, ... }` に署名したもので、
  別のノード ID として提示することはできない。
- `/crowd/signal` はトークン内の `nodeId` だけを使う（クエリの `nodeId` は上書きされる）。
  正規トークンを持つソケットが既に生きている場合のみ、そのソケットを閉じて
  再接続を引き継ぐ（トークンが証明された後でのみ閉じる）。
- 自己申告値は信用しない:
  - `wasmMemoryBytes` は 16 GiB にクランプ。
  - `warmModels` は非負整数・`start < end`・`end <= 4096` のみ受理。
  - `cpuLoad` は有限数値のみ採用（不正値は前回値を保持）。
- 割り当て順は `scheduler.ts:rankPlacementCandidates()` の実装に従い、
  **ウォームモデル / ウォームベース → 実測 GPU → 既知容量 → 累計割り当て数 →
  自己申告負荷 → 接続時刻**（同率なら nodeId）の順。負荷を偽って 0 と申告しても
  それより前の骨子が優先されるため独占できない。

## 5. キューとファンアウトの上限（Issue #6）

| 上限 | 値 | 挙動 |
|------|----|------|
| グローバル pending | 500 | `429` |
| テナント別 pending | 50 | `429` |
| テナント別 enqueue | 60/分 | `429` |
| pending TTL | 5 分（`theia-inference` のみ 30 分） | `alarm()` が恒久失敗させる |
| `timeoutMs` | 1s..1h | `400` |
| リトライ | 3 回 | 以降は `failed` |
| 購読者/タスク | 8 | `429` |
| 購読 upgrade/タスク | 30/分 | `429` |
| 1 パスの割り当て対象 | 32 タスク | 残りは次回以降 |

`alarm()` は processing のタイムアウトに加えて pending も巡回し、
`queuedAt + min(timeoutMs, cap)` を超えたタスクを失敗させる（cap は通常 5 分、
Theia の LoRA タスクは 30 分）。理由は `No eligible node picked up <workload>
before its N-minute queue deadline` として記録される。

## 6. Webhook 署名（Issue #13）

- 専用 secret `WEBHOOK_SIGNING_SECRET` を使う（`NODE_TOKEN_SECRET` と共用しない）。
  未設定で `callbackUrl` 付きタスクを投入すると **400 で拒否**する（fail closed）。
- 署名対象は `<timestamp>.<nonce>.<raw body>`、ヘッダは
  `X-Flaxia-Signature: sha256=<base64url HMAC-SHA256>`、
  `X-Flaxia-Timestamp`（unix 秒）、`X-Flaxia-Nonce`。
- 受信側は SDK の `verifyCrowdWebhook()` を使う（定数時間比較・
  タイムスタンプ許容 300 秒・nonce 必須・任意のリプレイガード）。

### 署名が保証しないこと

プラットフォーム署名は「その本文がコーディネーターから送られた」こと
（配送の真正性）だけを示す。**結果の正しさは保証しない**: ノードは
実行した値をそのまま報告するため、悪意あるノードの出力も同じ署名で届く。
下流でモデレーション等の意思決定に使う場合は、複数ノードでの再実行や
サンプリング検証を別途組み合わせること。監査用に `nodeId` / `attemptId` を
本文に含めてあるので、どのノードの結果かを記録できる。

## 7. 購読トークン（Issue #14）

- `POST /crowd/tasks` と `GET /crowd/tasks/:id`（所有者のみ）の応答に
  短期（10 分）の `subscribeToken` を含める。HMAC は専用の
  `SUBSCRIBE_TOKEN_SECRET` で、`{ tenantId, taskId, exp }` に束縛される。
- `/crowd/subscribe` は `flaxia-subscribe-v1` サブプロトコルの
  `bearer.<subscribeToken>` を必須とし、`?token=` は 401、
  別タスク用トークンは 403、他テナントのタスクは 404 とする。

## 8. トークン輸送（Issue #20）

ブラウザの `WebSocket` はヘッダを設定できないため、トークンは
サブプロトコル一覧で運ぶ。クエリ文字列はログ・Referer に残るため拒否する。

```
new WebSocket('wss://host/crowd/signal',    ['flaxia-node-v1',      'bearer.' + nodeToken])
new WebSocket('wss://host/crowd/subscribe?taskId=…', ['flaxia-subscribe-v1', 'bearer.' + subscribeToken])
```

サーバーは 101 応答で同名のサブプロトコルをエコーする。
`@flaxia/sdk` の `handshake.ts` が唯一の契約定義（`buildNodeSignalProtocols` /
`buildSubscribeProtocols` / `parseBearerSubprotocol`）。

ノードトークンの TTL は 2 時間。ノード側はトークンを `localStorage` に
保存しない（メモリのみ）ため、ページ再読み込みのたびに再登録＝ローテーションになる。

## 9. デプロイ時の注意

タスクのストレージキーが `task:<taskId>` から `task:<tenantId>:<taskId>` に
変わったため、**デプロイ前にキューに残っていたタスクは解決できず破棄される**
（`alarm()` が未解決のキュー項目を掃除する）。依頼側は再投入すること。