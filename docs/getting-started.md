# 導入ガイド

Flaxia Crowdを使い始めるためのステップ・バイ・ステップガイドです。

## 前提条件
- Node.js v22以上
- npm v10以上
- Cloudflare アカウント（Worker開発用）

## インストール
各パッケージは独立しており、用途に合わせてインストールします。

公開パッケージは npm レジストリでは配布していません。GitHub Releases に添付された
tarball を URL 指定でインストールしてください（URL のバージョンは利用するリリースに
合わせて読み替えます）。

### 依頼者 (Requester)
```bash
npm install https://github.com/TeamFlaxia/flaxia-crowd/releases/download/sdk-v0.8.0/flaxia-sdk-0.8.0.tgz
```

### サイトオーナー (Node Provider)
```bash
npm install https://github.com/TeamFlaxia/flaxia-crowd/releases/download/node-v0.10.0/flaxia-node-0.10.0.tgz
```

`@flaxia/node` の実行時コードは `@flaxia/sdk` を同梱していますが、型定義
（`.d.ts`）は `@flaxia/sdk` を参照します。TypeScript で使う場合だけ、sdk の
tarball も入れてください（レジストリからの解決は行いません）:

```bash
npm install \
  https://github.com/TeamFlaxia/flaxia-crowd/releases/download/node-v0.10.0/flaxia-node-0.10.0.tgz \
  https://github.com/TeamFlaxia/flaxia-crowd/releases/download/sdk-v0.8.0/flaxia-sdk-0.8.0.tgz
```

> リポジトリ内（この monorepo の workspace）では引き続き `@flaxia/sdk` が
> workspace として解決されます。ソースの import は変更不要です。

## プロジェクトのアーキテクチャ概要
1. **依頼者**: `@flaxia/sdk` を通じて処理をリクエスト。
2. **オーケストレーター**: `@flaxia/worker` (Cloudflare Workers) がタスクをキューイングし、接続可能なノードをマッチング。
3. **ノード**: `@flaxia/node` がWebWorkerで処理を並列実行し、結果を返却。

詳細は各ガイドを参照してください。
