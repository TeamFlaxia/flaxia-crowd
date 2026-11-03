# ノード提供者向けガイド (@flaxia/node)

ウェブサイト訪問者のブラウザリソースをノードとして活用するためのSDKです。

## 基本設定

```typescript
import { initFlaxiaNode } from '@flaxia/node'

initFlaxiaNode({
  orchestratorUrl: 'https://orchestrator.your-service.com',
  siteId: 'my-site-123',
  consent: {
    brandName: 'Flaxia Example',
    position: 'bottom-right'
  }
})
```

## コンプライアンスと同意
`@flaxia/node` はユーザーのプライバシーを最優先します。
- **UIの実装**: Shadow DOMにより、サイト側のCSSと独立したデザインを提供します。
- **状態管理**: 同意内容は `localStorage` に保持されます。
- **リソース制御**: CPU使用率はOS側のAPIやWebWorkerの実行制限を活用し、自動的にスロットリングされます。
- **同意 v3**: 公開Webアーカイブ（Common Crawl）からのページ取得・本文抽出を含みます。取得先のサイトには端末の IP アドレスが伝わり、抽出結果は依頼元へ送信されます（端末には保存しません）。

## 実行する workload の有効化

ノードが受ける workload は `capabilities` で指定します（既定は `ai-inference` と `image-process` のみ）。

```typescript
initFlaxiaNode({
  orchestratorUrl: 'https://orchestrator.your-service.com',
  siteId: 'my-site-123',
  consent: { brandName: 'Flaxia Example', position: 'bottom-right' },
  capabilities: ['ai-inference', 'cc-extract', 'embed-gemma'],
  // cc-extract の fetchUrl を許可する origin（完全一致）
  ccRangeOrigins: ['https://orchestrator.your-service.com'],
})
```

- `cc-extract` はブラウザから Common Crawl を直接取得できないため、**署名付き range proxy の origin を `ccRangeOrigins` に設定しない限り広告されません**。proxy は `Content-Range` を `Access-Control-Expose-Headers` で公開し、リダイレクトしないでください。
- `embed-gemma` は初回にモデル（約 300〜500 MB）をダウンロードします。ノードの回線・ストレージ・バッテリーへの影響を考慮して有効化してください。

## 開発時の注意点
- サイト側のコンテンツセキュリティポリシー (CSP) で `connect-src` にオーケストレーターのドメインを追加してください。`cc-extract` を使う場合は range proxy の origin、`embed-gemma` を使う場合は `https://huggingface.co` も追加が必要です。
- 処理は `WebWorker` で実行されるため、メインスレッドのUI操作をブロックしません。
