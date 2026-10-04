# @flaxia/text-analyzer

`@flaxia/sdk` と `@flaxia/node` を使った感情分析デモ（Vite + TypeScript）。
テキストを Crowd タスクとして投入し、同時に訪問者のブラウザをノードとして提供します。

## 動作の前提

- ブラウザは **API キーを一切持たない**。`/crowd/*` へのリクエストは同一オリジンの
  プロキシ（本番はホスティング層、開発時は Vite の `server.proxy`）が受け、
  `Authorization` ヘッダはサーバー側で付与されます。
- ノードの Signaling（WebSocket）だけはオーケストレーターへ直接接続します。
  その接続先はビルド時に確定し、実行時に任意のオリジンへは変更できません。

## 設定（すべてビルド時）

| 変数 | 必須 | 説明 |
|------|------|------|
| `FLAXIA_API_KEY` | 開発時のみ | Vite の dev プロキシ専用。`VITE_` を付けないためバンドルには含まれません。 |
| `VITE_ORCHESTRATOR_URL` | 必須 | バンドルに埋め込むオーケストレーターのオリジン（例: `http://localhost:8787`）。未設定のビルドは本番へフォールバックせず、UI に設定エラーを表示します。 |
| `VITE_ALLOWED_ORCHESTRATOR_ORIGINS` | 任意 | カンマ区切りのオリジン許可リスト。`localStorage["flaxia_orchestrator_url"]` による上書きは、ここに完全一致したオリジンのみ受け付けます。空（既定）なら上書きは無視されます。 |

値の例は [`.env.example`](./.env.example) を参照してください。

### localStorage 上書きの扱い

`localStorage["flaxia_orchestrator_url"]` は、オリジン許可リストに載っている
オリジンと完全一致する場合のみ採用されます。パス・クエリ・フラグメント・
認証情報を含む値は拒否され、拒否時はコンソールに警告を出して
`VITE_ORCHESTRATOR_URL` の値を使用します。許可リストが空の場合、上書きは
一切効きません。

## 開発

```bash
# リポジトリルートから
npm run dev:text-analyzer
npm run build --workspace=@flaxia/text-analyzer
npm test --workspace=@flaxia/text-analyzer
```

同意状態の判定には `@flaxia/node` の公開 API（`getFlaxiaNodeConsentState()`）を
使います。`localStorage` のフラグを直接読む実装は、期限切れや改ざんを検出できない
ため使用しないでください。