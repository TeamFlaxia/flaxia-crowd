# 03. タスクキュー管理（Durable Objects）

## 概要

`TaskQueue` Durable Object がタスクのライフサイクル全体を管理する。

## タスクのステータス遷移

```
PENDING → ASSIGNING → PROCESSING → DONE
                  ↘            ↘
                  TIMEOUT →  PENDING（再キュー）
                             （最大3回）
                  FAILED（3回失敗で確定）
```

## Durable Object: TaskQueue

### 内部ストレージ構造（DO Storage）

```typescript
// キー設計（テナント分離: Issue #3）
`task:${tenantId}:${taskId}` → TaskRecord
`taskindex:${taskId}`        → tenantId（ノードメッセージ解決用の内部インデックス）
`attempt:${taskId}`          → { attemptId, nodeId, tenantId }（現在の配信試行）
`queue:pending`              → taskId[] (JSON, 全体の割り当て順)
`queue:processing`           → taskId[] (JSON)
`pending:${tenantId}`        → taskId[] (JSON, テナント別の上限判定用)
`nodes:idle`                 → nodeId[] (JSON)
```

読み取りは必ず `task:<tenantId>:<taskId>` を直接引き、他テナントのタスクは
404 として扱う。`taskindex` は DO 内部の逆引き専用で、外部に公開しない。

### TaskRecord 型定義

```typescript
type TaskStatus = 'pending' | 'assigning' | 'processing' | 'done' | 'failed'

type WorkloadType = 'ai-inference' | 'image-process' | 'file-convert'

type TaskRecord = {
  id: string
  status: TaskStatus
  workload: WorkloadType
  payload: unknown
  createdAt: number       // unixtime ms
  tenantId: string        // API キーから解決した所有テナント
  allowedSites?: string[] // payload.allowedSites の写し（サイト allow-list）
  assignedAt?: number
  completedAt?: number
  assignedNodeId?: string
  retryCount: number      // max 3
  timeoutMs: number       // 1s..1h（デフォルトはワークロード依存）
  callbackUrl?: string    // 完了時にPOSTする先（SDK側）
  result?: unknown
  error?: string
  resultNodeId?: string   // 結果を受理したノード（監査用）
  resultAttemptId?: string// 結果を受理した配信試行（監査用）
}
```

### 公開メソッド（RPC or fetch）

| メソッド | 説明 |
|---------|------|
| `enqueue(task)` | タスクをPENDINGキューに追加 |
| `assign(taskId, nodeId)` | ASSIGNING→PROCESSINGに遷移 |
| `complete(taskId, result)` | PROCESSING→DONEに遷移・callback発火 |
| `fail(taskId, error)` | 失敗処理・リトライ判定 |
| `getTask(taskId)` | タスク取得 |
| `getPending()` | PENDING一覧取得 |
| `checkTimeouts()` | タイムアウト確認・再キュー |

## キュー上限と pending TTL（Issue #6）

| 上限 | 値 | 超過時 |
|------|----|--------|
| グローバル pending | 500 | `429` |
| テナント別 pending | 50 | `429` |
| テナント別 enqueue | 60/分 | `429` |
| pending TTL | `createdAt + min(timeoutMs, 5分)` | `alarm()` が恒久失敗 |
| `minNodes` / `maxNodes` | 1..16 | `400` |
| 1 パスで見る pending | 32 件 | 残りは次回のパス |

`tryAssignAll` はノードレコードを 1 回だけ読み込み、キュー先頭 32 件だけを
対象にする（O(タスク×ノード) のストレージ読み取りを避ける）。

## タイムアウト処理

Durable Objects の Alarm API を使用する：

```typescript
// タスクenqueue時にAlarmをセット
await this.state.storage.setAlarm(Date.now() + task.timeoutMs)

// alarm() ハンドラでタイムアウト確認
async alarm() {
  // 1. processing のタイムアウト（リトライ or 失敗）
  // 2. pending の TTL 切れ（候補ノードが現れないまま残ったタスクを失敗）
  // 3. ノードの ping / 死活 GC、レート制限エントリの GC
  // 次のAlarmをセット（キューやノードが残っていれば）
}
```

## 冗長化方針

Phase 1では冗長配布（同一タスクを複数ノードへ）は**行わない**。
シンプルに1タスク1ノードでリトライで対応する。

Phase 2以降で結果照合による冗長実行を検討する。
