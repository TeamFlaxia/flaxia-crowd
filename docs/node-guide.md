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

## 開発時の注意点
- サイト側のコンテンツセキュリティポリシー (CSP) で `connect-src` にオーケストレーターのドメインを追加してください。
- 処理は `WebWorker` で実行されるため、メインスレッドのUI操作をブロックしません。
