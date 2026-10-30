# コントリビューション

Flaxia Crowdへのコントリビューションを歓迎します。変更は小さくまとめ、目的と影響をPull Requestに記載してください。

## Issueの報告・提案

バグ報告や機能提案は[GitHub Issues](https://github.com/TeamFlaxia/flaxia-crowd/issues)へお願いします。再現手順、期待される動作、実際の動作を添え、投稿前に既存のIssueを確認してください。セキュリティ上の問題は公開せず、[SECURITY.md](./SECURITY.md)の手順で報告してください。

## 開発環境と確認

- Node.js v22以上
- npm v10以上

```sh
npm install
npm run build
npm test
```

`npm run build`は全パッケージをビルドし、`npm test`は各ワークスペースのテストを実行します。コードの振る舞いを変更する場合は、関連するテストも追加または更新してください。

## Pull Request

- `main`ブランチを対象にしてください。
- 1つのPRにつき1つの論理的な変更とし、目的、影響、実行した確認を説明してください。
- 同意UI、ブラウザノードの実行・リソース制御、WebRTC、タスク認可、Webhook署名に関わる変更では、セキュリティ・プライバシーへの影響と互換性を説明してください。
- 型や実行時の契約を変更した場合は、関連パッケージ間で整合性を保ち、テスト結果を記載してください。
