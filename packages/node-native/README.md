# Flaxia Crowd native node

Rust製の常駐ノード。最初の段階として、既存オーケストレーターへの登録・WebSocket接続・heartbeat・再接続に対応します。

**このバージョンではタスクは実行しません。** `capabilities: []` で登録するため、接続中のidleノードにはなりますが、タスクの配信対象にはなりません。AI推論・画像処理・GPU・Swarm対応は次の段階です。

## 起動（Linux）

Rust stable と、起動済みのCrowd workerが必要です。モノレポのルートから:

```bash
cp packages/node-native/node.example.toml packages/node-native/node.toml
# node.tomlの接続先・site_idを編集し、participate = true に変更する
cargo run --locked --manifest-path packages/node-native/Cargo.toml -- \
  --config packages/node-native/node.toml
```

設定:

| 項目 | 内容 |
|---|---|
| `orchestrator_url` | workerのベースURL。通常HTTPS。ローカル開発ではloopbackへのHTTPも使用可能 |
| `site_id` | 診断用識別子。1〜128 UTF-16 code units。サイトの所有権を証明するものではない |
| `participate` | 明示的な参加設定。既定値false。trueになるまでネットワーク接続しない |

workerには通常どおり `NODE_TOKEN_SECRET` が必要です。依頼者用APIキーはこのノードに設定しません。URLの認証情報・query・fragmentは拒否します。ベースURLにパスがある場合は、その下に `/crowd/*` を追加します。

Ctrl-CまたはSIGTERMで終了します。自動起動やsystemdへの登録は行いません。ログは接続・切断理由・再試行間隔のみを表示し、トークン・サーバー応答本文は表示しません。

## 通信・復帰

1. `POST /crowd/nodes/register` に `siteId`、空の `capabilities`、`fileSources: false` を送信。
2. サーバー発行のトークンを `flaxia-node-v1, bearer.<token>` のサブプロトコルとして `/crowd/signal` に送信。トークンをURLやファイルに保存しない。
3. 接続直後とJSON `ping` の受信時に `pong` を返す。CPU使用率は未計測なので `null`。
4. 60秒間JSON `ping` が来ない場合、トークン失効時、通信エラー時に切断・再登録。毎回新しいサーバー発行IDとトークンを取得。
5. 再試行の上限を1秒→2秒→4秒→…→30秒に増やし、各上限の50〜100%のジッターを適用。60秒以上維持できた接続の後はバックオフをリセット。

登録HTTPのタイムアウトとWebSocket handshake/writeのタイムアウトは15秒、終了時のcloseは最大2秒。登録応答は16 KiB、WebSocketのフレーム・メッセージは64 KiBまで。HTTPリダイレクトは追跡しません。不正な応答や想定外のタスクを受けた場合は接続を終了して再登録します。

この段階ではRAM/GPUの計測はせず、`deviceMemory` / `wasmMemoryBytes` を送信しません。workerでは低メモリ扱いになります。ネイティブRAMをWASM容量として報告しないためです。リソース上限の設定・計測・強制も、実処理の追加時に実装します。

## 開発・検証

```bash
cd packages/node-native
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
cargo build --locked --release
```

専用のGitHub ActionsでLinux上の同じチェックを実行します。npmの既存ビルドにRustは必須になりません。

SDKの `src/handshake.ts` を通信契約の正本とし、`build.rs` がプロトコル名・bearer prefix・トークン長上限をビルド時に読み取ります。そのため、このクレートはモノレポ内でビルドしてください。SDKの宣言形式が変わった場合はビルドが失敗するので、取り込み側も更新します。

RustのHTTP/WebSocket統合テストとSDKの契約テストで `tests/fixtures/signaling.json` を共有します。統合テストでは登録・認証・初回pong・ping応答・切断後の再登録・トークン更新・終了を確認します。実際のCloudflare workerを起動した疎通試験は別途必要です。
