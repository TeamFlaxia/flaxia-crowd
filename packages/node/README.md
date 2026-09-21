# @flaxia/node

一般ウェブサイトに1行で埋め込める**ブラウザノードSDK**。
訪問者のブラウザを Flaxia Crowd の計算ノードとして稼働させます。

## インストール

```bash
npm install @flaxia/node
```

## 使い方

```typescript
import { initFlaxiaNode } from '@flaxia/node'

const controller = initFlaxiaNode({
  orchestratorUrl: 'https://crowd.flaxia.app',
  siteId: 'your-site-id',
  consent: {
    brandName: 'あなたのサービス名',
    position: 'bottom-right',
    accentColor: '#6366f1',
  },
})
```

## 設定

### NodeConfig

| プロパティ | 型 | 必須 | 説明 |
|-----------|-----|------|------|
| `orchestratorUrl` | `string` | yes | オーケストレーターのURL |
| `siteId` | `string` | yes | サイト固有の識別子 |
| `consent` | `ConsentConfig` | yes | 同意UIの設定 |
| `consent.brandName` | `string` | yes | サイト名（内蔵UIに表示） |
| `consent.position` | `'bottom-right' \| 'bottom-left' \| 'top-right' \| 'top-left'` | yes | 内蔵UIの表示位置 |
| `consent.accentColor` | `string` | no | 内蔵UIのアクセントカラー |
| `consent.onConsentRequired` | `(controls: ConsentControls) => void` | no | ホスト独自の同意UIを使う場合に指定。指定すると内蔵バナーは表示されない |
| `maxCpuLoad` | `number` | no | CPU負荷制限（未実装） |

### ホスト独自の同意UI

`consent.onConsentRequired` を渡すと、内蔵の Shadow DOM バナーは使われず、
同意状態が `unset` のときだけホストが呼び出されます。ホストは `controls.accept()` /
`controls.reject()` を呼ぶだけで、保存とノードの起動・停止はSDK側が行います。

```typescript
initFlaxiaNode({
  orchestratorUrl: 'https://crowd.flaxia.app',
  siteId: 'your-site-id',
  consent: {
    brandName: 'あなたのサービス名',
    position: 'bottom-right',
    onConsentRequired: ({ state, accept, reject }) => {
      // 自前のモーダルを表示し、ユーザーの選択に応じて accept() / reject()
      showMyConsentModal({
        onAccept: accept,
        onReject: reject,
      })
    },
  },
})
```

### コントローラ（設定画面からの変更）

`initFlaxiaNode()` は `FlaxiaNodeController` を返します。同一モジュール内で一度だけ
状態を保持するため、設定画面から同意の付与・取消をリロードなしで行えます。

```typescript
const controller = initFlaxiaNode({ /* ... */ })

controller.getConsentState() // 'unset' | 'granted' | 'denied'
controller.grant()           // 同意を保存（拒否を消去）
controller.deny()            // 拒否を保存して停止（同意を消去）
controller.start()           // ノード起動
controller.stop()            // ノード停止 + Web Worker 解放
controller.isRunning()       // 稼働中か
controller.clearConsent()    // 同意・拒否・失効時刻をすべて消去
```

同意は localStorage に保存され、**30日**で失効します。`grant` と `deny` は排他で、
片方を保存するともう片方は消去されます。

## アーキテクチャ

```
ブラウザタブ
┌────────────────────────────────────────────┐
│ メインスレッド                              │
│  ┌──────────┐  ┌──────────────┐           │
│  │ ConsentUI│  │ Signaling    │           │
│  │ (Shadow  │  │ Client       │──WebSocket─┼──→ Worker
│  │  DOM)    │  │ (WS + WebRTC)│           │
│  └──────────┘  └──────┬───────┘           │
│                       │                    │
│                 ┌─────▼──────┐            │
│                 │ WorkerPool │            │
│                 │ (管理/監視) │            │
│                 └─────┬──────┘            │
├───────────────────────┼────────────────────┤
│ WebWorker             │                    │
│  ┌────────────────────▼──────────────┐    │
│  │ main.worker.ts (ディスパッチャ)    │    │
│  │  ┌──────────┐ ┌──────────┐       │    │
│  │  │ AI推論   │ │ 画像処理 │       │    │
│  │  │ (ONNX)   │ │(Offscreen│       │    │
│  │  │          │ │ Canvas)  │       │    │
│  │  └──────────┘ └──────────┘       │    │
│  │  ┌──────────┐                    │    │
│  │  │ Container│                    │    │
│  │  │(WASM)    │                    │    │
│  │  └──────────┘                    │    │
│  └──────────────────────────────────┘    │
└────────────────────────────────────────────┘
```

### レイヤー構成

| レイヤー | ディレクトリ | 責務 |
|---------|------------|------|
| **同意** | `src/consent/` | Shadow DOM による同意バナー、localStorage への同意保存 |
| **接続** | `src/client/` | WebSocket signaling、WebRTC ピア接続 |
| **実行** | `src/executor/` | WebWorker のライフサイクル管理、タイムアウト処理、WASM コンテナ実行 |
| **Worker** | `src/worker/` | WebWorker エントリ、workload への動的ディスパッチ |
| **Workload** | `src/workloads/` | AI推論・画像処理・コンテナ実行の実装 |

## 対応ワークロード

| workload | ファイル | 技術 |
|----------|---------|------|
| `ai-inference` | `workloads/ai-inference.ts` | 🤗 Transformers.js (ONNX Runtime) |
| `image-process` | `workloads/image-process.ts` | OffscreenCanvas API |
| `container` | `workloads/container.ts` | container2wasm + WASI |

## フロー

1. `initFlaxiaNode()` が呼ばれると、localStorage の同意状態を確認
2. 未同意の場合、内蔵の Shadow DOM 同意バナー、または `onConsentRequired` でホストのUIを表示
3. 同意後、WebSocket でオーケストレーターに接続（`/crowd/signal`）
4. タスクを受信すると WebWorker で実行
5. 結果・中間トークンを WebSocket で返送
6. 切断時は指数バックオフ付き自動再接続（最大30秒）
7. `FlaxiaNodeController` 経由で設定画面から同意の付与・取消が可能

## 開発

```bash
# ビルド
npm run build

# 開発サーバー
npm run dev

# テスト
npm run test
```
