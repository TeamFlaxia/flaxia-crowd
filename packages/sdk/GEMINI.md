# GEMINI.md — @flaxia/sdk

## このパッケージの目的

個人開発者が Flaxia Crowd にタスクを投げるための**依頼者向けSDK**。
型定義の単一の真実の源泉（`@flaxia/worker`・`@flaxia/node`はここの型を参照する）。

## 技術スタック

- ビルド: Vite (library mode)
- 出力: ESM + CJS（Node.js・Deno・Cloudflare Workers すべて対応）
- 外部依存: **ゼロ**（fetchのみ使用）

## 実装すべき機能

1. `docs/01-client.md` — FlaxiaClientクラス
2. `docs/02-submit-task.md` — タスク投入API
3. `docs/03-polling.md` — 結果取得
4. `docs/04-types.md` — 共有型定義（全パッケージの真実の源泉）
5. `docs/05-errors.md` — エラークラス階層

## ディレクトリ構成

```
packages/sdk/
├── GEMINI.md
├── package.json
├── tsconfig.json
├── vite.config.ts
├── docs/
│   ├── 01-client.md
│   ├── 02-submit-task.md
│   ├── 03-polling.md
│   ├── 04-types.md
│   └── 05-errors.md
└── src/
    ├── index.ts
    ├── client.ts
    ├── submit.ts
    ├── polling.ts
    ├── types.ts       ← 全パッケージ共通型はここ
    └── errors.ts
```

## package.json

```json
{
  "name": "@flaxia/sdk",
  "version": "0.1.0",
  "private": false,
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    }
  },
  "scripts": {
    "build": "vite build",
    "dev": "vite build --watch",
    "typecheck": "tsc --noEmit",
    "test": "vitest"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "vite": "^5.0.0",
    "vitest": "^1.0.0"
  }
}
```

## 基本的な使い方

```typescript
import { FlaxiaClient } from '@flaxia/sdk'

const client = new FlaxiaClient({
  apiKey: 'fc_live_xxxxxxxxxxxx',
})

// Flaxia Crowd
const result = await client.submit({
  workload: 'ai-inference',
  payload: {
    task: 'text-classification',
    model: 'Xenova/distilbert-base-uncased-finetuned-sst-2-english',
    input: 'This is amazing!',
  },
})

```

## コーディング規約

- TypeScript strict mode
- ゼロ依存（fetchのみ）
- すべての公開メソッドにJSDoc必須
- エラーは必ずFlaxiaErrorサブクラスでthrow
- テストキー（fc_test_）でモック応答を返す機能を実装する
