# GEMINI.md — @flaxia/node

## このパッケージの目的

一般ウェブサイトに1行で埋め込める**ブラウザノードSDK**。
訪問者のブラウザを Flaxia Crowd の処理ノードにする。

## 技術スタック

- ビルド: Vite (library mode)
- 出力: ESM + UMD（CDN配信考慮）
- ターゲット: ES2020
- バンドルサイズ目標: gzip後200KB以下（Transformer.jsは動的import）

## 実装すべき機能

1. `docs/01-consent-ui.md` — Shadow DOM同意UI
2. `docs/02-node-client.md` — Signaling接続管理
3. `docs/03-worker-executor.md` — WebWorker処理実行
4. `docs/04-workloads.md` — ワークロード別実装
5. `docs/05-cpu-throttle.md` — CPU負荷制限

## ディレクトリ構成

```
packages/node/
├── GEMINI.md
├── package.json
├── tsconfig.json
├── vite.config.ts
├── docs/
│   ├── 01-consent-ui.md
│   ├── 02-node-client.md
│   ├── 03-worker-executor.md
│   ├── 04-workloads.md
│   └── 05-cpu-throttle.md
└── src/
    ├── index.ts
    ├── consent/
    │   ├── ConsentUI.ts      # closed Shadow DOM バナー（サニタイズ + 最低表示時間）
    │   ├── storage.ts        # HMAC署名付き同意レコード・オリジン/開示版/期限の検証
    │   └── notice.ts         # 開示文と CONSENT_NOTICE_VERSION
    ├── client/
    │   └── SignalingClient.ts
    ├── executor/
    │   ├── WorkerPool.ts
    │   └── throttle.ts
    └── workloads/
        ├── ai-inference.ts
        ├── image-process.ts
        └── file-convert.ts   # Phase 2
```

## package.json

```json
{
  "name": "@flaxia/node",
  "version": "0.1.0",
  "private": false,
  "type": "module",
  "main": "./dist/index.umd.js",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "vite build",
    "dev": "vite build --watch",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@flaxia/sdk": "*",
    "@xenova/transformers": "^2.0.0",
    "typescript": "^5.0.0",
    "vite": "^5.0.0"
  }
}
```

## 公開API

```typescript
import { initFlaxiaNode } from '@flaxia/node'

initFlaxiaNode({
  orchestratorUrl: 'https://crowd.flaxia.app',
  siteId: 'your-site-id',
  consent: {
    brandName: 'あなたのサービス名',
    position: 'bottom-right',
    accentColor: '#6366f1',
  },
  maxCpuLoad: 0.15,
})
```

同意まわりの追加エクスポート:

```typescript
import {
  getFlaxiaNodeConsentState,        // 同期・fail closed
  initFlaxiaNodeConsent,            // HMAC鍵の読み込みとレコード検証を await
  setFlaxiaNodeHostManagedConsent,  // ホスト独自UIを使う場合の明示オプトイン
} from '@flaxia/node'
```

## コーディング規約

- DOM操作はすべてShadow DOM内（サイトCSSと干渉させない）
- WebWorkerコードは `src/worker/` 以下に分離
- Transformer.jsは動的importで遅延ロード（同意後のみ）
- グローバル汚染禁止（`window`への代入禁止）

## 同意（consent）の不変条件

- **同意はユーザー操作でのみ成立する**: `saveConsent()` は同意バナーのクリックで
  発行されるジェスチャトークン、または `setFlaxiaNodeHostManagedConsent(true)` の
  明示的オプトインが無ければ拒否する（`console.warn` + 状態は `unset` のまま）。
- **fail closed**: `getConsentState()` / `hasConsent()` は HMAC 検証が済むまで
  `'granted'` を返さない。検証を待てる呼び出し元は `initConsentIntegrity()` を await する。
- **レコードは束縛される**: ページオリジン・開示文バージョン・必須の `expiry`
  （上限180日）・HMAC-SHA-256（非抽出 `CryptoKey` を IndexedDB に保存）の
  すべてが一致しなければ「同意なし」。
- **開示文を変えたら `CONSENT_NOTICE_VERSION` を上げる**。上げると既存の同意は
  すべて無効になり、バナーが再表示される。
- 詳細と残存脅威モデルは `docs/01-consent-ui.md` を参照。
