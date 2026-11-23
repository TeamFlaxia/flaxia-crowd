# ワーカーオーケストレーターガイド (@flaxia/worker)

タスクのキューイング、マッチング、ライフサイクル管理を担当する Cloudflare Workers ベースのオーケストレーターです。

## 主な役割
- **タスクキュー**: `TaskQueue` Durable Object でタスクの永続化とステータス管理。
- **Signaling**: ノードのWebSocket接続認証・維持とJSONタスク配信。
- **ノード管理**: ノードの接続監視とマッチング。

## 開発・デプロイ設定 (wrangler.toml)
Durable Objects を使用するため、以下の設定が必須です。

```toml
[[durable_objects.bindings]]
name = "TASK_QUEUE"
class_name = "TaskQueue"

[[migrations]]
tag = "v1"
new_classes = ["TaskQueue"]
```

## タスクのライフサイクル
1. **PENDING**: SDKから投入され、キューに入る。
2. **ASSIGNING**: オーケストレーターがノードへ割り当てを開始。
3. **PROCESSING**: ノードがWebSocket経由でタスクを実行中。
4. **DONE/FAILED**: 結果の確定、またはエラー処理。

## 冗長化方針
現在、Phase 1では「1タスク1ノード」のシンプルな実行構成ですが、`TaskQueue` DOにてリトライ回数（最大3回）を管理しています。タイムアウト時は自動で再キューイングされます。
