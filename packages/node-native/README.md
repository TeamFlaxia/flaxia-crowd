# Flaxia Crowd native node

Rust製の常駐ノード。既存オーケストレーターへの登録・WebSocket接続・heartbeat・再接続に加え、Linuxでは `image-process` と、既存ブラウザノードと共通の `swarm-inference` を実行できます。

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
| `execution.memory_limit_mb` | 画像処理の仮想アドレス空間上限。既定512 MiB、256〜2048 MiB |
| `execution.max_timeout_ms` | 子プロセスの壁時計時間上限。既定120000 ms、1〜600000 ms。タスク指定値との小さい方を使用 |

workerには `NODE_TOKEN_SECRET` が必要です。依頼者用APIキーはこのノードに設定しません。URLの認証情報・query・fragmentは拒否します。ベースURLにパスがある場合、その下に `/crowd/*` を追加します。

画像処理を有効化するにはLinuxと4 GiB以上の物理RAMが必要です。これは既存workerの低メモリ判定に合わせた条件です。実測した物理RAMを `deviceMemory` の診断値として送信し、`wasmMemoryBytes` は送信しません。プローブや上限制御が使えない場合、有効化したノードは登録前に起動を拒否します。画像処理・Swarmが両方無効なら、空の `capabilities` で接続維持のみを行います。

Ctrl-CまたはSIGTERMで終了します。自動起動サービスは登録しません。ログにはトークン・タスク本文・サーバー応答本文を出しません。

## 画像処理

SDKの `ImageProcessPayload` / `ImageProcessResult` を使います。対応操作は `resize`、`grayscale`、`compress`、`thumbnail`、入力・出力形式はPNG/JPEG/WebPです。`imageBase64` で渡された画像だけを扱い、URL取得や任意コマンド実行は行いません。

既存ブラウザ版と同様、出力幅・高さはそれぞれ元画像以下に制限し、指定された幅と高さへ変換します。thumbnailも同じ寸法指定を使います。ネイティブコーデックを使うため、ブラウザとの出力バイト列や補間結果の一致は保証しません。`quality` はJPEG出力に適用します。PNGとWebPは可逆圧縮で出力し、qualityによる圧縮率調整は行いません。

入力の上限は16 MiB、幅・高さは8192px、総画素数は32M pixelsです。ヘッダーの形式・寸法・MIMEを検査してからデコードします。エンコード出力にも上限を設け、base64とJSON envelopeを含む結果をworkerの4 MiB上限以内に収めます。サイズ超過や不正な画像はタスクエラーとして返します。

## タスク制御と実行プロセス

- 1ノード1タスク。すべての結果・エラーに受信した `taskId` と `attemptId` を付けます。実行中および直近256件の同一attemptの重複配信を無視します。
- 画像処理は同じバイナリの内部子プロセスへパイプで渡し、親のWebSocket処理は継続します。子は環境変数を継承せず、ペイロードを引数や一時ファイルへ保存しません。
- 画像処理の子プロセスはLinuxの `RLIMIT_AS` と `RLIMIT_CPU` を設定し、core dumpを無効にします。CPU時間上限は壁時計予算から算出します。CPU使用率のパーセンテージ制御は行いません。
- `abort`、ローカルtimeout、切断、ノード停止では子を終了・回収します。abortへのエラー返送は行いません。切断前の処理結果を再接続後に返送することもありません。
- 別attemptのタスクが実行中に重なった場合は接続を終了し、現タスクを停止してworker側の回復処理に委ねます。

プロセス分離とリソース上限は、任意プログラム向けのOSサンドボックスではありません。画像処理は同梱のコードだけを実行します。Swarmの実行方式と上限は次節を参照してください。

## Swarmによる分割AI推論

Rustの親プロセスが登録・認証・heartbeatとタスクの寿命を管理し、Deno 2.9.6のRust/wgpuのVulkanバックエンドでレイヤースライスを実行します。Denoは既存WGSLエンジンをホストする実行層として残ります。Chromiumやブラウザ画面は起動しません。既存のPooledエンジン、SwarmController、SDKのf16フレーム形式・ホップHMACを共有します。llama.cppの単独生成APIへ置き換えず、既存Swarmとのレイヤー分担を維持します。

Linux、4 GiB以上のRAM、動作するVulkanドライバー、Deno 2.9.6が必要です。ソフトウェアVulkanでも検証できますが、実モデルには十分なRAM/VRAMと実用的な演算性能が必要です。モデルはブラウザ版と同じ固定レジストリ（SDKの `SUPPORTED_SWARM_MODEL_IDS`）を使用し、ノードは割り当てられたレイヤーとhost用のembedding/headの重みをRange取得します。任意のモデルURL・コードはタスクから指定できません。

モノレポのルートでヘルパーをビルドします。npmはビルド時だけ必要です。

```bash
npm ci
node packages/node-native/swarm/build.mjs
cargo build --locked --release --manifest-path packages/node-native/Cargo.toml
```

設定ファイルの既存 `[execution]` の後に追加してください。両パスは実際の絶対パスに置き換えます。

```toml
[execution.swarm]
enabled = true
allow_model_download = true
runtime = "/opt/deno/bin/deno"
helper = "/opt/flaxia-crowd/packages/node-native/dist/swarm-helper.js"
heap_limit_mb = 512
```

`enabled` と `allow_model_download` はどちらも既定falseです。ダウンロードの明示同意がない場合や、ヘルパーの起動・Vulkanの実computeプローブに失敗した場合は、ノード登録前に起動を拒否します。実測したWebGPU能力だけを登録し、WASMのメモリ測定値は捏造しません。接続維持のみのモードにはDenoは不要です。

Rustが子の `DENO_WEBGPU_BACKEND=vulkan` を固定します。ヘルパーも同じ指定を確認し、Vulkanで実computeプローブに成功した場合だけ登録します。OpenGL・他のGPU APIへの自動フォールバックは行いません。Denoの環境変数読み取り権限はこの1項目だけに限定します。実行ログの `gpu_backend="vulkan"` が起動成功の確認になります。ソフトウェアVulkan（lavapipe等）はCPU上で動作するため、実GPUを使う運用では対象GPUのVulkanドライバーを導入してください。

SDKから既存の `swarm-inference` を投入します。最低2台の参加ノードと、現在のschedulerが要求する予備候補が必要です。nativeだけのチェーンにも、ブラウザとの混在チェーンにも同じ通信契約を使います。

```ts
await client.submit({
  workload: 'swarm-inference',
  payload: {
    model: 'qwen3.5-2b', prompt: 'Explain distributed inference.',
    maxNewTokens: 32, swarm: { minNodes: 2, maxNodes: 3 },
  },
  timeoutMs: 120000,
});
```

現段階のnative transportはCoordinatorリレーを使い、`peerReady: false` を通知します。これにより混在チェーンも既存のリレーモードへ切り替わります。WebRTCの直接接続・その帯域上の利点はありません。既存のリレーbyte budgetが適用され、上限超過時はタスクが失敗します。

生成トークン・結果にはtask/session/attemptを付けます。古いattemptの制御、別sessionのフレーム、不正MACは受け付けません。`swarm-flow` による一時停止・再開をトークン境界で適用し、パイプとキューに上限を設けます。abort・切断・timeout・shutdownで子を終了・回収し、次のタスクは新しいプロセスで実行します。プロセスごとに重みを再ロードし、ブラウザのCacheStorageや実行中モデルのwarm cache・prewarmは提供しません。

`execution.max_timeout_ms` はSwarmにも適用します。Swarmには画像処理用の `memory_limit_mb` / `RLIMIT_AS` は適用しません。V8の仮想メモリ予約・GPUドライバーとは両立しないためです。`heap_limit_mb` はV8ヒープだけの上限（既定512、256〜4096 MiB）で、GPU/ドライバー/nativeメモリは含みません。全プロセスの厳密なRAM/VRAM制限が必要な運用では外部のcgroup等を設定してください。子は環境変数を継承せず、Denoのネットワーク権限をモデル配信先に制限し、ファイル・任意コマンド実行の権限を渡しません。

この実装のAI対応範囲は `swarm-inference` です。一般のTransformers.jsパイプライン（分類・音声等）、単独 `ai-inference` / `vector-embed` は広告しません。

## 通信・再接続

`POST /crowd/nodes/register` のサーバー発行トークンを、`flaxia-node-v1, bearer.<token>` のサブプロトコルとして `/crowd/signal` に送信します。URLやファイルには保存しません。

接続直後とJSON `ping` の受信時に `pong` を返します。CPU使用率は未計測なので `null` です。60秒間JSON pingが来ない場合、トークン失効時、通信エラー時に切断・再登録します。毎回新しいサーバー発行IDとトークンを取得します。

再試行上限は1秒→2秒→4秒→…→30秒で、上限の50〜100%のジッターを適用します。60秒以上維持できた接続の後はバックオフをリセットします。登録HTTP・WebSocket handshake/writeは15秒、終了時closeは最大2秒です。HTTPリダイレクトは追跡しません。

画像処理またはSwarm有効時のフレーム・メッセージ上限は24 MiB、接続維持のみの場合は64 KiBです。登録応答は16 KiBまでに制限します。

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

Swarmの検証（DenoとVulkanドライバーが必要）:

```bash
npx tsc -p packages/node-native/tsconfig.json
node packages/node-native/swarm/build.mjs --test
node packages/node-native/tests/build-swarm-fixture.mjs
deno test --no-config --no-npm --cached-only packages/node-native/dist/bridge.test.js
node --test packages/node-native/tests/swarm-e2e.mjs
```

Swarm E2Eでは実workerd、Rustノード3台中の2台、Vulkanに固定したネイティブwgpuを使用し、合成Qwen35 GGUFの4レイヤーを2分割して生成を繰り返します。学習済みの大型モデルの品質・性能や実ブラウザとの混在実行を検証したものではありません。Rustの試験でabort/timeout/切断/shutdown後の子プロセス回収、bridge試験でHMAC・attempt・トークンpause/resumeを確認します。
