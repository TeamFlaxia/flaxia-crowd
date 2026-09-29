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

## TODO: Webhook / HTTP Callback 対応

### 背景
Flaxia SNS の `waitUntil` 内で `waitForTask()`（最大30秒ポーリング）がタイムアウトする。
解決策として、タスク完了をHTTP Callback（Webhook）で受け取る方式に移行する。

### 1. `packages/worker` — Coordinator に callback delivery を実装

**ファイル**: `packages/worker/src/worker/Coordinator.ts`

**`completeTask()`** と **`failTask()`** の末尾で `task.callbackUrl` が存在する場合、HTTP POST で結果を送信する：

```typescript
// completeTask() の WebSocket通知後:
if (task.callbackUrl) {
  await this.deliverCallback(task.callbackUrl, {
    taskId,
    status: 'done',
    result: task.result,
  });
}

// failTask() の WebSocket通知後:
if (task.callbackUrl) {
  await this.deliverCallback(task.callbackUrl, {
    taskId,
    status: 'failed',
    error: task.error,
  });
}
```

**注意点**:
- `deliverCallback()` は `fetch()` で `POST` + `Content-Type: application/json`
- タイムアウトは 5秒程度に設定（callbackが遅くてもタスク自体の完了は阻害しない）
- 失敗時のリトライは初回実装ではスキップ（callback先が落ちていてもタスク結果はREST APIから取得可能）
- DO の `fetch()` には 100ms の制限がない（DO内からは通常の `fetch()` が使える）

### 2. `packages/sdk` — SubmitTaskOptions に callbackUrl が既にあることを確認（済）
`callbackUrl?: string` は既に `SubmitTaskOptions` に定義済み。変更不要。

### 3. `flaxia` 側 — analyzeSentiment の callbackUrl 対応

**ファイル**: `functions/api/[[route]].ts`

`analyzeSentiment()` を以下のように修正：

```typescript
async function analyzeSentiment(c: any, postId: string, text: string): Promise<void> {
  if (processingPosts.has(postId)) return
  processingPosts.add(postId)
  try {
    const client = getCrowdClient(c)
    if (!client) return

    const callbackUrl = `${c.env.BASE_URL}/api/crowd/webhook`
    await client.submit({
      workload: 'ai-inference',
      payload: {
        task: 'text-classification',
        model: 'Xenova/bert-base-multilingual-uncased-sentiment',
        input: text,
      },
      callbackUrl,  // ← 追加
    })
    // waitForTask は呼ばない（waitUntil のタイムアウト回避）
  } catch (err) {
    console.error(`Sentiment analysis submission failed for post ${postId}:`, err)
  } finally {
    processingPosts.delete(postId)
  }
}
```

### 4. `flaxia` 側 — Webhook受信エンドポイントを新設

**ファイル**: `functions/api/[[route]].ts`

`POST /api/crowd/webhook` を Hono ルーターに追加：

```typescript
app.post('/api/crowd/webhook', async (c) => {
  const { taskId, status, result, error } = await c.req.json()
  if (!taskId) return c.text('Bad Request', 400)

  // taskId から postId を引く（後述の補完テーブルが必要）
  // 現状は taskId→postId のマッピングがないので、
  // posts テーブルの sentiment_task_id カラムで管理する

  if (status === 'done' && result?.output?.[0]) {
    const output = result.output[0]
    const labelScoreMap = {
      very_negative: 0.0, negative: 0.25,
      neutral: 0.5, positive: 0.75, very_positive: 1.0,
    }
    const score = labelScoreMap[output.label] ?? output.score
    // postId が必要
    await c.env.DB.prepare(
      'UPDATE posts SET sentiment_score = ? WHERE id = ?'
    ).bind(score, postId).run()
  }

  return c.json({ received: true })
})
```

**課題**: 現状 `taskId → postId` のマッピングがない。以下のいずれかで解決：

- **案A**: `posts` テーブルに `sentiment_task_id TEXT` カラムを追加（マイグレーション）
- **案B**: 新テーブル `sentiment_tasks(task_id TEXT, post_id TEXT, created_at INT)` を作成

### 5. `flaxia` 側 — マイグレーション

`migrations/0034_add_sentiment_task_id.sql`:
```sql
ALTER TABLE posts ADD COLUMN sentiment_task_id TEXT;
```

または案Bのテーブルを作成。

### 6. `flaxia` 側 — `wrangler.toml` に BASE_URL の確認

`BASE_URL` 環境変数が `https://flaxia.app` に設定されていることを確認。

---

## Flaxia SNSへの組み込み方法

```bash
# flaxia.app リポジトリ側で
npm install @flaxia/worker @flaxia/sdk

# wrangler.tomlへの追記は packages/worker/docs/06-wrangler.md を参照
```
