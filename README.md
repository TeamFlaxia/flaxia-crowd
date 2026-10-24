# Flaxia Crowd

**「サーバーレス・バッチ処理を月額定額で実現する」分散処理ライブラリ。**

一般ウェブサイトの訪問者ブラウザをノードとして活用し、AI推論・画像処理などの非同期バッチ処理を効率的に実行します。

---

## 概要

| 比較項目 | 従来型（AWS/Modal等） | Flaxia Crowd |
|---|---|---|
| コスト | 従量課金・青天井 | **月額定額** |
| 予算 | 予測困難 | **予測可能** |
| スケーラビリティ | サーバー増設 | **サイト訪問者数に連動** |

サーバーを介さないため、従来と根本的に異なる原価構造で提供します。

---

## ディレクトリ構成

```text
flaxia-crowd/
├── packages/
│   ├── worker/    # Cloudflare Workers オーケストレーター (TaskQueue, Signaling)
│   ├── node/      # ブラウザノードSDK (ConsentUI, WebRTC, WorkerPool)
│   ├── node-native/ # Rust製常駐ノード（登録・接続維持・Linuxネイティブ画像処理）
│   └── sdk/       # 依頼者用SDK (Task Submission, Types)
```

---

## How to use

詳細な利用方法や各コンポーネントの仕様は `docs/` ディレクトリを参照してください。

- [導入ガイド (Getting Started)](docs/getting-started.md)
- [依頼者向けSDKガイド](docs/sdk-guide.md)
- [ノード提供者向けガイド](docs/node-guide.md)
- [Rust製ネイティブノード](packages/node-native/README.md)
- [ワーカーオーケストレーターガイド](docs/worker-guide.md)


---

## 同意UIとプライバシー

訪問者のリソース利用には明示的な同意が必須です。

- **リソース制限**: CPU使用率は最大15%（動画再生相当）。バックグラウンドタブでは自動停止。
- **匿名性**: 処理内容はサイト側に一切開示されません。
- **管理**: 同意状態はlocalStorageに保持（デフォルト30日）。

---

## 開発・貢献ワークフロー

### 事前準備
- Node.js v22+
- npm v10+

### 環境構築とテスト
```bash
git clone https://github.com/flaxia/flaxia-crowd
cd flaxia-crowd
npm install
npm run build     # 全パッケージのビルド
npm run test      # 全パッケージのテスト
```

### 開発方針
1. `packages/worker` (基盤): オーケストレーター機能。
2. `packages/node` (ノード): ブラウザ実行環境。
3. `packages/sdk` (インターフェース): 依頼者向けAPI。

機能追加・修正は必ず `tests` を含め、既存の `GEMINI.md` に記載された各パッケージのルールに従ってください。
型定義を変更した場合は必ず3パッケージ同時に整合性を取ってください。

---

## ライセンス

MIT
---
