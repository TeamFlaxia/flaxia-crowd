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

## Webhook / HTTP Callback

アプリケーション固有の本番 URL、DB スキーマ、Webhook 受信処理は、このリポジトリの
開発メモに記載しない。各ホストアプリの管理下で実装し、Crowd の Callback を受ける
場合は SDK の署名検証を必須にする。

検証前に JSON を信頼したり、本文から取り出した値で DB を更新したりしてはならない。
受信した生の本文と `readCrowdWebhookHeaders()` を
[`packages/sdk/docs/02-submit-task.md`](packages/sdk/docs/02-submit-task.md) の
`verifyCrowdWebhook()` に渡し、失敗時は処理を拒否する。本番では専用の
`WEBHOOK_SIGNING_SECRET` と共有可能なリプレイガードを設定する。

署名は配送元と本文の真正性を示すが、推論結果の正しさは保証しない。判断に使う場合は
独立した検証も設計する。

---

## Flaxia SNSへの組み込み方法

```bash
# ホストアプリ側で
npm install @flaxia/worker @flaxia/sdk

# wrangler.tomlへの追記は packages/worker/docs/06-wrangler.md を参照
```

## 生成テストの基準

- Web・デスクトップ共通で、実モデルの **Qwen3.5-2B Q4_0** を生成確認の基準にする。
- モデル・SHA-256・共通プロンプトは `scripts/swarm-spike/generation-baseline.mjs`、実行手順は `benchmarks/inference/README.md` を参照する。
- `npm run test:generation -- all` で両ターゲットを確認する。個別実行は `web` / `desktop`。
- 小型の合成GGUFはunit・回帰・通信smoke test用。実モデルの生成確認に合格した根拠にはしない。
- GPUやブラウザが利用できず実行できなかったターゲットは、未検証として報告する。
