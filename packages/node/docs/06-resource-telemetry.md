# リソース計測とメモリ予算

## 報告経路と期限

同意済みノードは、接続時およびCoordinatorのheartbeat (`ping`) ごとに `pong.resources` を送ります。Coordinatorは各報告を検証し、90秒の報告期限を過ぎた値を破棄します。GPU計測は10分キャッシュし、WASMのコミット可能メモリ下限はページ内で一度だけ測定します。2 GiB上限のWASM測定をheartbeatごとに繰り返すことはありません。

各数値には単位、サンプル時刻、期限、サンプル数、取得方法 (`measured` / `estimated` / `unknown`) を付けます。未取得の値は数値のゼロではなく `value: null` と `source: 'unknown'` で表します。

## GPU計測の限界

WebGPU対応端末ではadapterからdeviceを作成し、バッファを確保しない小さなcomputeを3回送信して中央値の完了時間を記録します。各送信は750 msで打ち切り、deviceは必ず破棄します。adapter制限の `maxStorageBufferBindingSize` は1つのstorage bufferの上限であり、総VRAMや空きVRAMではありません。ブラウザが総VRAMを公開しないため `gpu.memoryBytes` はunknownのままです。

`unsupported` はAPIまたはadapterがない場合、`unavailable` はdevice作成・計測失敗、`device-lost` は計測中のdevice喪失です。device-lost等の新しい報告はswarm候補から一時的に外すためのヒントになり、後続の成功した計測で候補に戻れます。

## メモリ予算と縮退

`evaluateMemoryBudget()` はモデル重み、activation、KV cache、予約領域、安全余白を合算し、利用可能量と比較します。いずれかがunknownなら `fits: null` を返します。WASMの下限値やadapterのbuffer上限を、空きGPUメモリとして読み替えてはいけません。unknownまたは不足のときはモデル・層数・同時実行を縮小するか、別ノードへ再割当てし、値が揃うまで「適合」として扱わないでください。

すべての計測値はノード自身が送信するため、Coordinator認証や計算結果の信頼根拠にはなりません。容量・性能の候補順位付けに限って使用します。
