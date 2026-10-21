# 01. FlaxiaClientクラス

## 概要

すべての操作の起点となるクライアントクラス。
`fetch` のみを使用し、外部依存ゼロで実装する。

## クラス定義

```typescript
type FlaxiaClientConfig = {
  /** Flaxia CrowdダッシュボードのAPIキー */
  apiKey: string
  /** オーケストレーターURL デフォルト: 'https://crowd.flaxia.app' */
  orchestratorUrl?: string
  /** HTTPリクエストのタイムアウト ms デフォルト: 30000 */
  requestTimeoutMs?: number
}

class FlaxiaClient {
  private readonly config: Required<FlaxiaClientConfig>

  constructor(config: FlaxiaClientConfig)

  /**
   * タスクを投入し、完了まで待って結果を返す（ポーリング方式）
   * タイムアウトまでに完了しない場合は FlaxiaTimeoutError を throw
   */
  async submit<T = unknown>(options: TaskSubmitOptions): Promise<TaskResult<T>>

  /**
   * タスクを投入してタスクIDだけ返す（コールバック方式）
   * 結果は callbackUrl に POST される
   */
  async submitAsync(options: TaskSubmitAsyncOptions): Promise<{ id: string }>

  /**
   * タスクの現在の状態を取得する（所有者テナントのみ。他テナントは 404）
   * 応答の subscribeToken はクライアント内にキャッシュされる
   */
  async getTask<T = unknown>(taskId: string): Promise<TaskResult<T>>

  /**
   * タスクの進捗トークンと完了結果を WebSocket で購読する
   *
   * `/crowd/subscribe` はテナント + タスク + 期限に束縛された購読トークンが
   * 必須。クライアントは submit() の応答、キャッシュ、または
   * GET /crowd/tasks/:id から自動で取得する（options.subscribeToken で上書き可）。
   * トークンはサブプロトコル `flaxia-subscribe-v1, bearer.<token>` で送る。
   * `onToken` は同期または Promise を返すハンドラーを受け付け、Promise が完了すると
   * SDK がそのトークンをACKする。未処理バッファは最大32件・64K文字で、超過時は
   * 購読を閉じて `onError` に通知する。
   */
  async subscribe(taskId: string, options?: SubscribeOptions): Promise<TaskSubscription>
}
```

## ストリームの流量制御

新しいSDKはトークンごとに処理完了をACKする。Coordinatorは未ACKが16件に達すると
生成ノードを停止し、全購読者が8件未満まで追いつくと再開する。切断やキャンセルで
待機は解除される。ACKが30秒止まった購読者は切断される。ACKに対応しない旧SDKも
無制限には送らず、32件の固定上限で購読を閉じる。

```ts
const subscription = await client.subscribe(taskId);
subscription.onToken(async (token) => {
  await persistToken(token); // 完了後にACKされ、必要なら生成が再開する
});
subscription.onError((error) => console.error(error));
```

## 内部ヘルパー

```typescript
// すべてのHTTPリクエストはこれを通す
private async request<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown
): Promise<T> {
  const controller = new AbortController()
  const timeoutId = setTimeout(
    () => controller.abort(),
    this.config.requestTimeoutMs
  )

  try {
    const res = await fetch(`${this.config.orchestratorUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    })

    if (!res.ok) {
      const err = await res.json()
      throw new FlaxiaCrowdError(err.error, err.code, res.status)
    }

    return res.json()
  } finally {
    clearTimeout(timeoutId)
  }
}
```

## APIキーのフォーマット

```
fc_live_xxxxxxxxxxxxxxxxxxxxxxxxxx   本番
fc_test_xxxxxxxxxxxxxxxxxxxxxxxxxx   テスト（ノードに流さずモック応答）
```

テストキーを使うと実際のノードに流さずにモック応答が返るため、
開発中の動作確認が容易になる。

## 環境互換性

以下すべての環境で動作すること：

| 環境 | バージョン |
|------|-----------|
| Node.js | 18+ |
| Cloudflare Workers | - |
| Deno | 1.30+ |
| ブラウザ | モダンブラウザ |

`fetch` はすべての対象環境でグローバルに存在するため、ポリフィル不要。
