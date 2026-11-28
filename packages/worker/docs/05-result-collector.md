# 05. 結果収集・コールバック通知

## 概要

ノードが処理を完了したら、結果をWorkerに返却し、
依頼者（@flaxia/sdk）に非同期で通知する。

## 結果返却フロー

```
[Node] --{ type: 'result', taskId, attemptId, payload }--> [Coordinator DO /ws]
                                                       ↓
                                      completeTask(taskId, result, nodeId, attemptId)
                                                       ↓
                                           callbackUrl があれば署名付き POST
                                           結果は Coordinator の DO Storage に保存
```

## コールバック方式（SDKがcallbackUrlを指定した場合）

```typescript
// completeTask() / failTask() 内で実行
const body = JSON.stringify({
  taskId: task.id,
  status: 'done',            // or 'failed'
  result: task.result,       // failed のときは error
  nodeId: task.resultNodeId, // 監査用: 結果を出したノード
  attemptId: task.resultAttemptId, // 監査用: 受理した配信試行
});
const timestamp = String(Math.floor(Date.now() / 1000));
const nonce = crypto.randomUUID();
const signature = await createWebhookSignature(env.WEBHOOK_SIGNING_SECRET, timestamp, nonce, body);

await fetch(task.callbackUrl, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Flaxia-Signature': signature, // sha256=<base64url HMAC-SHA256>
    'X-Flaxia-Timestamp': timestamp, // unix 秒
    'X-Flaxia-Nonce': nonce,
  },
  body,
  signal: AbortSignal.timeout(5000),
});
```

- 署名対象は `<timestamp>.<nonce>.<raw body>`。
- secret は **`WEBHOOK_SIGNING_SECRET` 専用**（`NODE_TOKEN_SECRET` と共用しない）。
- `callbackUrl` 付きタスクは secret 未設定なら投入時に 400 で拒否する（fail closed）。
- 受信側の検証は SDK の `verifyCrowdWebhook()` を使う
  （定数時間比較・許容 300 秒・nonce 必須・任意のリプレイガード）。

### 署名が保証する範囲

署名は「コーディネーターがその本文を送った」こと（配送の真正性）を示すだけで、
**結果の正しさは保証しない**。ノードは実行した値をそのまま報告するため、
悪意あるノードの出力にも同じ署名が付く。意思決定に使う場合は
再実行・サンプリング検証などを組み合わせ、`nodeId` / `attemptId` を
監査ログに残すこと。

## ポーリング方式（SDKがcallbackUrlを指定しない場合）

結果は Coordinator の DO Storage（`task:<tenantId>:<taskId>`）に保存され、
SDKがポーリングで取得する：

```
GET /crowd/tasks/:id
→ { taskId, status, result?, error?, processingMs? }
```

キーは `task:${tenantId}:${taskId}`（テナントスコープ）。結果はタスクの
ライフサイクル終了後も取得できる別途の TTL は設定していない。

## 結果レスポンス型

```typescript
type TaskResult = {
  taskId: string
  status: 'pending' | 'processing' | 'done' | 'failed'
  result?: unknown        // done時のみ
  error?: string          // failed時のみ
  processingMs?: number   // done/failed時
  retryCount: number
}
```

## 失敗時の処理

- `retryCount < 3` → Coordinator が自動で PENDING に戻す（恒久失敗は即 failed）
- `retryCount >= 3` → status を `failed` に確定
  - callbackUrl があれば `{ status: 'failed', error }` を署名付きで POST
  - 結果は DO Storage に保存され REST/購読で取得できる

## セキュリティ

- コールバック先URLはHTTPSのみ許可
- コールバックには `X-Flaxia-Signature` ヘッダを付与（HMAC-SHA256）
  → SDKはこれを検証してなりすましを防ぐ
- 結果は REST ではテナントスコープの `GET /crowd/tasks/:id` からのみ参照でき、
  他テナントのタスクIDでは取得できない。
