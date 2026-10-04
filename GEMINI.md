# GEMINI.md — flaxia-crowd モノレポ

## このリポジトリの目的

**Flaxia Crowd** のコアライブラリ群。
一般ウェブサイトの訪問者ブラウザをノードとして使う分散非同期処理サービスの実装。

Flaxia SNS（flaxia.app）とは**独立した別リポジトリ**。
Flaxia SNSへの組み込みはこのモノレポのパッケージをnpmインストールする形で行う。

## パッケージ構成

```
flaxia-crowd/
├── GEMINI.md                   ← このファイル
├── package.json                 ← workspaces定義
├── tsconfig.base.json           ← 共通TypeScript設定
├── packages/
│   ├── worker/                  @flaxia/worker
│   │   → Cloudflare Workers オーケストレーター
│   │   → タスクキュー・Signaling・ノード管理
│   │
│   ├── node/                    @flaxia/node
│   │   → 一般サイト埋め込み用ブラウザノードSDK
│   │   → 同意UI・WebRTC・処理実行
│   │
│   └── sdk/                     @flaxia/sdk
│       → 依頼者向けSDK
│       → タスク投入・結果取得
```

## 技術スタック共通事項

- 言語: TypeScript strict mode
- ビルド: Vite (library mode)
- パッケージマネージャ: npm workspaces
- ターゲット環境: ES2020

## 開発の進め方

**実装順序は必ずこの順番で行う：**

1. `packages/worker` — オーケストレーターが動かないと他が全部机上の空論
2. `packages/node` — Signalingサーバーが動いてから実装する
3. `packages/sdk` — 1と2が動いて初めて正しいAPIが設計できる

各パッケージの詳細は `packages/*/GEMINI.md` を参照。

## ルートpackage.json

```json
{
  "name": "flaxia-crowd",
  "private": true,
  "workspaces": [
    "packages/*"
  ],
  "scripts": {
    "build": "npm run build --workspaces",
    "dev:worker": "npm run dev --workspace=packages/worker",
    "dev:node": "npm run dev --workspace=packages/node"
  }
}
```

## tsconfig.base.json

```json
{
  "compilerOptions": {
    "strict": true,
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  }
}
```

## パッケージ間の型共有ルール

`@flaxia/worker` ・ `@flaxia/node` ・ `@flaxia/sdk` が共有する型
（WorkloadType・TaskRecord等）は **`@flaxia/sdk`の`types.ts`を単一の真実の源泉**とする。

workerとnodeは`@flaxia/sdk`を依存に追加して型だけ参照する。
型定義を変更した場合は必ず3パッケージ同時に更新すること。

型だけでなく、ワークロード一覧（`WORKLOAD_TYPES` / `ROUTABLE_WORKLOADS`）・重み判定
（`HEAVY_WORKLOADS`）・Webhook契約（`parseCrowdWebhook` / `buildCallbackUrl`）といった
**実行時の契約も`@flaxia/sdk`を単一の真実の源泉**とする。workerやnodeで同じ配列・判定を
再定義してはならない。ホスト（Flaxia SNS 等）も同じヘルパーをimportする。

## 実装について
- 必ず完了報告をするときはテストにパスしてなくてはならない
- 常にパスするようにズルをしたテストを作成してはならない。

## Webhook / HTTP Callback 統合ガイド

### 背景
長時間かかるタスクの完了を HTTP Callback（Webhook）で受け取るための契約。
ホストは `callbackUrl` を渡し、ワーカーは完了・失敗時にその URL へ結果を POST する。

### 送信側（`@flaxia/worker`）

`Coordinator` の `deliverCallback()` が `Content-Type: application/json` で POST する。

- タイムアウトは 5 秒程度。コールバックが遅くてもタスク自体の完了は阻害しない
- 失敗時のリトライは行わない（結果は REST API からも取得できる）
- DO 内からは通常の `fetch()` が使える（100ms 制限はない）
- 署名 secret が未設定のまま署名なしで送信してはならない

### 署名の契約（`@flaxia/sdk` が単一の真実の源泉）

```
X-Flaxia-Signature: sha256=<hmac>
X-Flaxia-Timestamp: <unix秒>
X-Flaxia-Nonce:     <推測不能な一意値>
```

HMAC-SHA256 の対象は `<timestamp>.<nonce>.<raw body>`（生のリクエストボディ）。

### 受信側（ホスト）の必須要件

1. **署名検証を最優先する**。`@flaxia/sdk` の `verifyCrowdWebhook()`
   （PR "worker trust plane" で追加）を使い、生のリクエストボディで検証する。
   検証に成功するまでボディを信用してはならない（JSON パース・DB 更新・ログ出力も検証後）。
2. **タイムスタンプ許容幅**を設ける（例: ±5 分）。許容幅を外れたリクエストは拒否する。
3. **リプレイガード**を入れる。nonce を TTL 付きで記録し、同じ nonce の再送は拒否する。
4. **`taskId` → 自ドメインのエンティティの対応はサーバー側で解決する**。
   リクエストで渡された ID をそのまま信用せず、タスク投入時にホスト自身が
   永続化した対応表を、認可されたコンテキストから引く。
5. **未認証の呼び出し元に詳細を返さない**。応答は `204 No Content`（または最小限の
   `200`）に留め、DB の状態・対応表の内容・エラー詳細を返さない。
6. 署名 secret は環境変数／シークレットストアで管理し、ローテーション可能にする。
7. ペイロードには利用者のコンテンツが含まれ得るため、生のボディをログに残さない。

### ペイロードの形

`parseCrowdWebhook()`（`@flaxia/sdk`）が検証済みボディをこの形に正規化する。
`result.output` の取り出しは `extractCallbackOutput()` を使う。

```typescript
type CrowdWebhookEvent = {
  taskId: string
  status: 'done' | 'failed'
  result?: { output?: unknown; [key: string]: unknown }
  error?: string
}
```

### タスク投入側

- `callbackUrl?: string` は `SubmitTaskOptions` に定義済み。URL は
  `buildCallbackUrl()`（`@flaxia/sdk`）で組み立て、ホストのベース URL は
  環境変数から注入する（本番 URL をソースにハードコードしない）。
- `submitAsync()` で投入し、`taskId` と自ドメインのエンティティの対応は
  **投入時にサーバー側で永続化**しておく。クライアントから渡された `taskId` を
  信頼する設計にしない。

---

## Flaxia SNSへの組み込み方法

```bash
# flaxia.app リポジトリ側で
npm install @flaxia/worker @flaxia/sdk

# wrangler.tomlへの追記は packages/worker/docs/06-wrangler.md を参照
```
