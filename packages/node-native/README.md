# Flaxia Crowd native node

Rust製の常駐ノード。既存オーケストレーターへの登録・WebSocket接続・heartbeat・再接続に加え、Linuxでは `image-process` を実行できます。

## 起動

Rust stable と、起動済みのCrowd workerが必要です。モノレポのルートから:

```bash
cp packages/node-native/node.example.toml packages/node-native/node.toml
# 接続先・site_idを編集し、participate = true に変更
cargo run --locked --manifest-path packages/node-native/Cargo.toml -- \
  --config packages/node-native/node.toml
```

画像処理も受ける場合は、設定ファイルに以下を追加します。

```toml
[execution]
image_process = true
memory_limit_mb = 512
max_timeout_ms = 120000
```

| 項目 | 内容 |
|---|---|
| `orchestrator_url` | workerのベースURL。通常HTTPS。ローカル開発ではloopbackへのHTTPも使用可能 |
| `site_id` | 診断用識別子。1〜128 UTF-16 code units。サイトの所有権の証明には使わない |
| `participate` | 既定false。trueになるまでネットワーク接続しない |
| `execution.image_process` | 既定false。有効化した場合だけ画像処理用子プロセスを検査し、`image-process` を登録する |
| `execution.memory_limit_mb` | 子プロセスの仮想アドレス空間上限。既定512 MiB、256〜2048 MiB |
| `execution.max_timeout_ms` | 子プロセスの壁時計時間上限。既定120000 ms、1〜600000 ms。タスク指定値との小さい方を使用 |

workerには `NODE_TOKEN_SECRET` が必要です。依頼者用APIキーはこのノードに設定しません。URLの認証情報・query・fragmentは拒否します。ベースURLにパスがある場合、その下に `/crowd/*` を追加します。

画像処理を有効化するにはLinuxと4 GiB以上の物理RAMが必要です。これは既存workerの低メモリ判定に合わせた条件です。実測した物理RAMを `deviceMemory` の診断値として送信し、`wasmMemoryBytes` は送信しません。プローブや上限制御が使えない場合、有効化したノードは登録前に起動を拒否します。画像処理が無効なら、これまでどおり空の `capabilities` で接続維持のみを行います。

Ctrl-CまたはSIGTERMで終了します。自動起動サービスは登録しません。ログにはトークン・タスク本文・サーバー応答本文を出しません。

## 画像処理

SDKの `ImageProcessPayload` / `ImageProcessResult` を使います。対応操作は `resize`、`grayscale`、`compress`、`thumbnail`、入力・出力形式はPNG/JPEG/WebPです。`imageBase64` で渡された画像だけを扱い、URL取得や任意コマンド実行は行いません。

既存ブラウザ版と同様、出力幅・高さはそれぞれ元画像以下に制限し、指定された幅と高さへ変換します。thumbnailも同じ寸法指定を使います。ネイティブコーデックを使うため、ブラウザとの出力バイト列や補間結果の一致は保証しません。`quality` はJPEG出力に適用します。PNGとWebPは可逆圧縮で出力し、qualityによる圧縮率調整は行いません。

入力の上限は16 MiB、幅・高さは8192px、総画素数は32M pixelsです。ヘッダーの形式・寸法・MIMEを検査してからデコードします。エンコード出力にも上限を設け、base64とJSON envelopeを含む結果をworkerの4 MiB上限以内に収めます。サイズ超過や不正な画像はタスクエラーとして返します。

## タスク制御と実行プロセス

- 1ノード1タスク。すべての結果・エラーに受信した `taskId` と `attemptId` を付けます。実行中および直近256件の同一attemptの重複配信を無視します。
- 処理は同じバイナリの内部子プロセスへパイプで渡し、親のWebSocket処理は継続します。子は環境変数を継承せず、ペイロードを引数や一時ファイルへ保存しません。
- 子プロセスはLinuxの `RLIMIT_AS` と `RLIMIT_CPU` を設定し、core dumpを無効にします。CPU時間上限は壁時計予算から算出します。CPU使用率のパーセンテージ制御は行いません。
- `abort`、ローカルtimeout、切断、ノード停止では子を終了・回収します。abortへのエラー返送は行いません。切断前の処理結果を再接続後に返送することもありません。
- 別attemptのタスクが実行中に重なった場合は接続を終了し、現タスクを停止してworker側の回復処理に委ねます。

プロセス分離とリソース上限は、任意プログラム向けのOSサンドボックスではありません。このバージョンでは同梱の画像処理コードだけを実行します。AI/GPU/Swarmは未対応です。

## 通信・再接続

`POST /crowd/nodes/register` のサーバー発行トークンを、`flaxia-node-v1, bearer.<token>` のサブプロトコルとして `/crowd/signal` に送信します。URLやファイルには保存しません。

接続直後とJSON `ping` の受信時に `pong` を返します。CPU使用率は未計測なので `null` です。60秒間JSON pingが来ない場合、トークン失効時、通信エラー時に切断・再登録します。毎回新しいサーバー発行IDとトークンを取得します。

再試行上限は1秒→2秒→4秒→…→30秒で、上限の50〜100%のジッターを適用します。60秒以上維持できた接続の後はバックオフをリセットします。登録HTTP・WebSocket handshake/writeは15秒、終了時closeは最大2秒です。HTTPリダイレクトは追跡しません。

画像処理有効時のフレーム・メッセージ上限は24 MiB、接続維持のみの場合は64 KiBです。登録応答は16 KiBまでに制限します。

## 開発・検証

```bash
cd packages/node-native
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
cargo build --locked --release
```

SDKの `src/handshake.ts` を通信契約の正本とし、`build.rs` がプロトコル名・bearer prefix・トークン長上限をビルド時に取り込みます。このクレートはモノレポ内でビルドしてください。

Rust統合テストでは実行バイナリを起動して画像処理と結果を検証します。停止制御の試験では待機用の子プロセスを使い、abort・timeout・切断・shutdown後にプロセスが残らないことを確認します。

さらに、モノレポのルートで以下を実行すると、SDK → 実worker（Miniflare/workerd）→ Rustバイナリ → 結果取得の疎通を検証します。最初のタスク投入前に70秒待機し、アイドル中のheartbeatも確認します。本番環境へは接続しません。

```bash
npm ci
npm run build --workspace=@flaxia/sdk
node --test packages/node-native/tests/worker-e2e.mjs
```

GitHub Actionsでは同じ試験をLinux上で実行します。既存npmビルドにRustは必須になりません。
