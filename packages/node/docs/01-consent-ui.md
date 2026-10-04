# 01. 同意UIコンポーネント

## 概要

Cookie同意バナーと同じ文脈で、ユーザーにノード参加を促すUIを表示する。
**Shadow DOM（`{ mode: 'closed' }`）で実装し、サイト側のCSSと完全に分離する。**

同意は「訪問者が実際にバナーを見て、操作した」場合にのみ成立する。
ホストが独自UIを描画する場合を除き、プログラムから `accept()` を呼ぶだけでは
同意は保存されない（issue #9 の要件）。

## 表示タイミング

1. `initFlaxiaNode()` 呼び出し時に保存済み同意を確認
2. 有効な同意レコードがある（オリジン・開示バージョン・期限・HMACがすべて一致）→ UIを表示せずそのままノード接続
3. 未同意・期限切れ・改ざん・別オリジン・旧開示バージョン → 同意UIを表示

## 開示文（`src/consent/notice.ts`）

`CONSENT_DISCLOSURE` は静的な定数で、ホストからは変更できない。
文言を変えた場合は必ず `CONSENT_NOTICE_VERSION` を上げること。

```
{brandName}

同意すると、このブラウザは第三者から依頼された処理をバックグラウンドで実行します。

・実行する処理: 顧客（第三者）が依頼したワークロード。任意の WebAssembly コンテナの
  実行や、画像の NSFW（成人向け）判定などを含みます。
・接続と登録: オーケストレーターへ WebSocket で常時接続し、端末の性能や対応
  ワークロードを登録します。
・資源の使用: 待機中も接続を維持し、処理の実行中は CPU・GPU・通信・バッテリーを
  消費します。
・タスクの出所: 処理はこのサイトの運営者ではなく、第三者（顧客）から割り当てられます。

[同意して開始]  [拒否]
```

### 開示バージョンの意味

- `CONSENT_NOTICE_VERSION` は「訪問者が見た開示文のバージョン」。
- 同意レコードにはバージョンが HMAC 対象として保存される。
- バージョンを上げると**過去の同意はすべて無効**になり、次の訪問でバナーが再表示される。
- 旧バージョンのレコードは「同意なし」として扱われ、保存領域から削除される。

## 同意レコードの設計

`localStorage` キー `flaxia_consent_record` に JSON で保存する（旧キー
`flaxia_consent_granted` / `flaxia_consent_expiry` は読み取り時に削除され、
**同意としては一切扱われない**）。

```typescript
type ConsentRecord = {
  v: 1                  // レコード形式のバージョン
  noticeVersion: number // 訪問者が見た開示文のバージョン
  origin: string        // 同意したページのオリジン
  grantedAt: number     // 同意時刻 (ms)
  expiry: number        // 失効時刻 (ms) — 必須。欠落・不正は「同意なし」
  mac: string           // base64url の HMAC-SHA-256（上記フィールド全体が対象）
}
```

- **HMAC**: `crypto.subtle` の HMAC-SHA-256。鍵は `extractable: false` の
  `CryptoKey` として生成し、IndexedDB（`flaxia-consent-integrity`）に保存する。
  生の鍵バイトは取り出せないため、`localStorage` に文字列を書けるだけの
  スクリプトは検証を通るレコードを偽造できない。
- **オリジン束縛**: `origin` が現在のオリジンと一致しないレコードは無効。
- **開示バージョン束縛**: `noticeVersion` が現在値と一致しないレコードは無効。
- **期限**: `expiry` は必須。欠落・非数値・期限切れは無効。TTLの上限は
  `CONSENT_MAX_TTL_MS`（**180日**）で、それを超える寿命を主張するレコードも無効。
- **改ざん検知**: 値とHMACが一致しないレコードは「同意なし」として扱い、削除する。

### 鍵ストアが使えない環境

IndexedDB が使えない場合（プライベートモード、サイトデータ遮断など）は
セッション内のみの鍵にフォールバックする。この場合、同意は**そのページ表示中だけ**
有効で、リロード後は再同意が必要になる（fail closed）。
`crypto.subtle` 自体が無い非セキュアコンテキストでは永続レコードを書かず、
同じくセッション内のみの同意となる。

## 公開API

```typescript
import {
  getFlaxiaNodeConsentState,   // 同期・fail closed
  initFlaxiaNodeConsent,       // 非同期の整合性初期化
  setFlaxiaNodeHostManagedConsent,
} from '@flaxia/node'

// 同期読み取り: HMAC検証が済んでいなければ 'granted' を返さない
getFlaxiaNodeConsentState() // 'unset' | 'granted' | 'denied'

// 検証を待てる呼び出し元はこちら（冪等・例外を投げない）
await initFlaxiaNodeConsent()
```

`initConsentIntegrity()` はモジュール読み込み時にも自動で開始されるが、
同期読み取りは検証完了まで `'unset'` を返す（fail closed）。
設定画面などでリロード直後に正しい状態を表示したい場合は
`await initFlaxiaNodeConsent()` してから読むこと。

## 同意操作の強制（headless accept の禁止）

- `saveConsent()` は以下のいずれかが無い限り**拒否**し、`console.warn` を出して
  状態を `unset` のままにする。
  1. `ConsentUI` の同意ボタン押下で発行されるワンショットのジェスチャトークン
     （`markUserGestureConsent()`。ライブラリ内部専用）
  2. ホストが `setFlaxiaNodeHostManagedConsent(true)` で明示的にオプトインした場合
- `onConsentRequired` の `accept()` をUI非表示のまま呼んでも同意にはならない。
  ホスト独自UIを使う場合のみ、オプトインした上で現在の開示文を提示する責任を負う。
- 同意ボタンは最低表示時間（既定 **1500ms**）が経過するまで `disabled`。
  設定 `consent.minVisibleMs` で**延長のみ**可能（下限1500msでクランプ）。
  テストは `ConsentUIOptions`（`minVisibleMs` / `now` / `schedule`）で注入する。
- Shadow root は `closed`。ホストページのスクリプトから
  `container.shadowRoot.querySelector('#consent-btn').click()` を呼ぶことはできない。

## 設定値のサニタイズ

| 項目 | 扱い |
|------|------|
| `brandName` | `textContent` で描画。制御文字・双方向制御文字を除去し80文字に切詰め。HTMLとして解釈しない |
| `acceptLabel` / `rejectLabel` | 同上（40文字） |
| `position` | 4値のホワイトリスト。逸脱時は `bottom-right` |
| `accentColor` | `#rgb` / `#rrggbb` / `rgb()` / `rgba()`（各0-255, alpha 0-1）/ 名前付き色の許可リストのみ。解析後に正規化した文字列だけをCSSへ埋め込む。逸脱時は既定色 `#6366f1` |
| `privacyPolicyUrl` | `http:` / `https:` の絶対URLのみ。それ以外はリンク自体を描画しない |

CSSテンプレートは定数で、ホスト入力はサニタイズ済みの値だけがプレースホルダ経由で
入る。`innerHTML` は使用しない。

## 残存脅威モデル（正直な限界）

この仕組みが守るのは「**保存領域に文字列を書くだけの偽造**」である。以下は防げない。

- **同一オリジンのスクリプトがライブラリ自身のAPIを呼ぶ場合**: パッケージの
  エントリをimportできるスクリプトは `setFlaxiaNodeHostManagedConsent(true)` を
  呼び、`window.__flaxia_node_controller.grant()`（または同意コールバックの
  `accept()`）で同意を成立させられる。XSSや第三者タグはこの経路を取れる。
  根本対策は orchestrator 側の同意台帳（未実装・別ワークストリーム）。
- **同意UIを持たないホストの設定ミス**: オプトインしたホストが開示文を出さずに
  `accept()` を呼べば、その責任はホストにある。
- **同意の取り消し後の再同意**: `clearConsent()` は HMAC 鍵も破棄するため、
  過去レコードのコピーは無効になるが、新しい鍵で再同意は可能。
- **サーバー側の検証は無い**: 現状はブラウザ内の記録のみ。改ざん検知は端末内で完結する。

## Shadow DOM実装方針

```typescript
const ui = new ConsentUI(container, config, onConsent, onReject, options)
// 内部:
//   this.root = container.attachShadow({ mode: 'closed' })
//   style.textContent = STYLE_TEMPLATE.replace('__flaxia_accent__', sanitizedAccent)
//   title.textContent = sanitizedBrandName  // innerHTML は使わない
```

`shadowRootForTesting()` はテスト・診断用の `@internal` アクセサで、
インスタンスはグローバルに公開されない。

## アクセシビリティ

- `role="dialog"` と `aria-labelledby` を付与
- 最低表示時間中は `disabled` と `aria-disabled="true"` を付与
- 拒否ボタンは常に即時操作可能（拒否は制限しない）

未実装（TODO）: フォーカストラップ、`Escape` キーでの拒否、
`prefers-reduced-motion` 対応。

## ポジション指定

```typescript
const POSITION_STYLES = {
  'bottom-right': 'bottom: 20px; right: 20px;',
  'bottom-left':  'bottom: 20px; left: 20px;',
  'top-right':    'top: 20px; right: 20px;',
  'top-left':     'top: 20px; left: 20px;',
}
```

## イベント発火

```typescript
// 同意した場合（ジェスチャトークンを発行してから onConsent を呼ぶ）
markUserGestureConsent(CONSENT_NOTICE_VERSION)
onConsent()

// 断った場合
onReject?.()
```