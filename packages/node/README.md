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
| `consent.accentColor` | `string` | no | 内蔵UIのアクセントカラー（許可リスト外は既定色） |
| `consent.acceptLabel` / `consent.rejectLabel` | `string` | no | ボタン文言の上書き（テキストとして描画） |
| `consent.privacyPolicyUrl` | `string` | no | プライバシーポリシーへのリンク（http/https のみ） |
| `consent.minVisibleMs` | `number` | no | 同意ボタンが有効になるまでの最低表示時間。**延長のみ**（下限1500ms） |
| `consent.onConsentRequired` | `(controls: ConsentControls) => void` | no | ホスト独自の同意UIを使う場合に指定。指定すると内蔵バナーは表示されない |
| `maxCpuLoad` | `number` | no | CPU負荷制限（未実装） |

### ホスト独自の同意UI（オプトインが必要）

`consent.onConsentRequired` を渡すと、内蔵の Shadow DOM バナーは使われず、
同意状態が `unset` のときだけホストが呼び出されます。

ただし既定では **`accept()` を呼んでも同意は保存されません**。訪問者に実際の
開示文を見せて操作させるのはホストの責任になるため、ホスト独自UIを使う場合は
先に `setFlaxiaNodeHostManagedConsent(true)` で明示的にオプトインしてください。

```typescript
import { initFlaxiaNode, setFlaxiaNodeHostManagedConsent } from '@flaxia/node'

setFlaxiaNodeHostManagedConsent(true) // ホストが開示文を提示する責任を負う

initFlaxiaNode({
  orchestratorUrl: 'https://crowd.flaxia.app',
  siteId: 'your-site-id',
  consent: {
    brandName: 'あなたのサービス名',
    position: 'bottom-right',
    onConsentRequired: ({ state, accept, reject }) => {
      // 現在の開示文（packages/node/docs/01-consent-ui.md）を提示し、
      // ユーザーの選択に応じて accept() / reject()
      showMyConsentModal({
        onAccept: accept,
        onReject: reject,
      })
    },
  },
})
```

オプトインせずに `accept()` を呼んだ場合は `console.warn` が出て、状態は
`unset` のまま（＝同意なし）になります。

### コントローラ（設定画面からの変更）

`initFlaxiaNode()` は `FlaxiaNodeController` を返します。同一モジュール内で一度だけ
状態を保持するため、設定画面から同意の付与・取消をリロードなしで行えます。

```typescript
const controller = initFlaxiaNode({ /* ... */ })

controller.getConsentState() // 'unset' | 'granted' | 'denied'
controller.grant()           // 同意を保存（拒否を消去）※ホスト管理UIのオプトインが必要
controller.deny()            // 拒否を保存して停止（同意を消去）
controller.start()           // ノード起動
controller.stop()            // ノード停止 + Web Worker 解放
controller.isRunning()       // 稼働中か
controller.clearConsent()    // 同意・拒否・HMAC鍵をすべて消去
```

同意は `localStorage` の `flaxia_consent_record` に保存され、**180日**で失効します
（`grant` と `deny` は排他）。レコードは HMAC-SHA-256 で署名され、ページの
オリジンと開示文バージョンに束縛されるため、`localStorage` に文字列を書いただけの
偽造や、旧開示文に対する同意は「同意なし」として扱われます。

### 保存状態の読み取り（ノード初期化前）

`getFlaxiaNodeConsentState()` はコントローラを作らず、ネットワークにも触れず、
保存済みの同意状態を同期的に返します。**fail closed** で、HMAC 検証が完了して
いなければ `'granted'` は返しません。

リロード後の自動再開を維持したいホストは、**`initFlaxiaNode()` を呼ぶ前に**
`await initFlaxiaNodeConsent()` を実行してください。await せずに初期化すると、
再訪した同意済みの訪問者にもバナーが表示され、ノードは自動起動しません
（同意が無いものとして扱われるため）。

```typescript
import { getFlaxiaNodeConsentState, initFlaxiaNode, initFlaxiaNodeConsent } from '@flaxia/node'

await initFlaxiaNodeConsent()          // 冪等・例外を投げない
if (getFlaxiaNodeConsentState() !== 'granted') showSettingsToggle()
initFlaxiaNode({ /* ... */ })
```

## アーキテクチャ

```
ブラウザタブ
┌────────────────────────────────────────────┐
│ メインスレッド                              │
│  ┌──────────┐  ┌──────────────┐           │
│  │ ConsentUI│  │ Signaling    │           │
│  │ (Shadow  │  │ Client       │──WebSocket─┼──→ Worker
│  │  DOM)    │  │ (WebSocket)  │           │
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
| **同意** | `src/consent/` | closed Shadow DOM の同意バナー、HMAC署名付き同意レコードの保存・検証 |
| **接続** | `src/client/` | WebSocket signaling（登録・再接続・タスク授受） |
| **実行** | `src/executor/` | WebWorker のライフサイクル管理、タイムアウト処理、WASM コンテナ実行 |
| **Worker** | `src/worker/` | WebWorker エントリ、workload への動的ディスパッチ |
| **Workload** | `src/workloads/` | AI推論・画像処理・NSFW判定・コンテナ実行の実装 |

## 対応ワークロード

| workload | ファイル | 技術 |
|----------|---------|------|
| `ai-inference` | `workloads/ai-inference.ts` | 🤗 Transformers.js (ONNX Runtime) |
| `image-process` | `workloads/image-process.ts` | OffscreenCanvas API |
| `container` | `workloads/container.ts` | container2wasm + WASI |
| `nudenet` | `workloads/nudenet.ts` | NSFW（成人向け）画像判定 |

## フロー

1. `initFlaxiaNode()` が呼ばれると、HMAC署名付きの同意レコードを確認
2. 未同意の場合、内蔵の closed Shadow DOM 同意バナー、または `onConsentRequired` でホストのUIを表示
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
