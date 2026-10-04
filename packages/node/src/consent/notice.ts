/**
 * Version of the consent disclosure text below.
 *
 * Consent records are bound to this value: a record only counts as granted
 * while it carries the *current* version, so bumping the version invalidates
 * every existing grant and forces the visitor to see (and accept) the new
 * wording. Increment it whenever `CONSENT_DISCLOSURE` changes in any way that
 * a visitor would care about.
 *
 * - v1: legacy copy ("サイトのパフォーマンス向上にご協力ください。"), which never
 *   disclosed what actually runs on the device.
 * - v2: the informed-consent copy below (third-party workloads, orchestrator
 *   registration, persistent connection, resource usage).
 */
export const CONSENT_NOTICE_VERSION = 2;

/**
 * The disclosure shown in the built-in banner. Deliberately static: hosts may
 * style the banner but must not be able to weaken the wording, otherwise the
 * recorded notice version would no longer describe what the visitor saw.
 */
export const CONSENT_DISCLOSURE = {
  summary:
    '同意すると、このブラウザは第三者から依頼された処理をバックグラウンドで実行します。',
  items: [
    '実行する処理: 顧客（第三者）が依頼したワークロード。任意の WebAssembly コンテナの実行や、画像の NSFW（成人向け）判定などを含みます。',
    '接続と登録: オーケストレーターへ WebSocket で常時接続し、端末の性能や対応ワークロードを登録します。',
    '資源の使用: 待機中も接続を維持し、処理の実行中は CPU・GPU・通信・バッテリーを消費します。',
    'タスクの出所: 処理はこのサイトの運営者ではなく、第三者（顧客）から割り当てられます。',
  ],
  /** Shown while the accept button is inside its minimum-visible window. */
  acceptGateHint:
    '開示内容を確認できるよう、「同意して開始」はしばらくの間押せません。',
  acceptLabel: '同意して開始',
  rejectLabel: '拒否',
} as const;