/**
 * Shared Type Definitions for Flaxia Crowd
 */

export type TaskStatus = 'pending' | 'assigning' | 'processing' | 'done' | 'failed';

export type WorkloadType =
  | 'ai-inference'
  | 'image-process'
  | 'file-convert'
  | 'container'
  | 'vector-embed'
  | 'vector-store'
  | 'vector-query'
  | 'moe-inference'
  | 'nudenet'
  | 'cc-extract'
  | 'embed-gemma'
  | 'theia-inference';

// --- AI Inference ---

export interface AiInferenceOptions {
  /** Quantization dtype: 'q4f16' (default) | 'q8' | 'fp32' | 'q4' */
  dtype?: string;
  /** Execution device: 'wasm' (default) | 'webgpu' | 'cpu' */
  device?: string;
  /** Maximum number of tokens to generate (default: 128) */
  max_new_tokens?: number;
  /** Whether to sample (default: false = greedy decoding, faster) */
  do_sample?: boolean;
  /** Temperature for sampling (requires do_sample: true) */
  temperature?: number;
  /** Top-p nucleus sampling threshold */
  top_p?: number;
  /** Top-k sampling */
  top_k?: number;
  /** Repetition penalty */
  repetition_penalty?: number;
  /** Buffer tokens and flush in batches (reduces network overhead, default: false) */
  tokenBuffer?: boolean;
  /** Token buffer flush interval in ms (default: 50) */
  tokenBufferIntervalMs?: number;
  /** Number of threads for WASM backend (requires crossOriginIsolated, default: hardwareConcurrency) */
  numThreads?: number;
  /** Source language code (for translation tasks, e.g. 'en_XX') */
  src_lang?: string;
  /** Target language code (for translation tasks, e.g. 'ja_XX') */
  tgt_lang?: string;
  /**
   * When `true`, the inference must run on the device that already holds the
   * model. If the model is not preloaded, the task fails immediately with
   * `ONDEVICE_UNAVAILABLE` (HTTP 500) instead of downloading. When `false`
   * or omitted, the model may be downloaded on demand and (for coordinator
   * routed tasks) delegated to another node.
   */
  ondeviceOnly?: boolean;
}

export type DecisionQuestionType = 'noul' | 'choice' | 'score';

export interface DecisionQuestion {
  type: DecisionQuestionType;
  /** Instruction text (Japanese allowed). */
  instructions: string;
  /**
   * `choice`: named options -> description.
   * `noul`: optional { true: ..., false: ... }.
   * `score`: ordered level descriptions (2..10 entries).
   */
  criteria?: Record<string, string> | string[];
}

export type DecisionQuestions = Record<string, DecisionQuestion>;

export interface DecisionAnswer {
  /** `noul`: P(yes) in [0,1]. */
  noul?: number;
  /** `choice`: winning option name. */
  choice?: string;
  /** `choice`/`score`: confidence in [0,1]. */
  confidence?: number;
  /** `score`: expected level. */
  score?: number;
  /**
   * `choice`: full probability distribution keyed by option name.
   * Hosts use this to compute Top-K (e.g. Top3 + none) instead of relying on
   * top-1 only.
   */
  probabilities?: Record<string, number>;
  /** `score`: per-level probabilities in criteria order. */
  levelProbabilities?: number[];
  /** `score`: echoed level descriptions. */
  legend?: string[];
}

export interface AiInferencePayload {
  /**
   * Transformer.js pipeline task name (e.g. 'text-classification').
   * For d1 decision models use 'decision' with `decision` set (see below);
   * the generic pipeline path is skipped for those models.
   */
  task: string;
  /**
   * HuggingFace model name (e.g. 'Xenova/distilbert-base-uncased-finetuned-sst-2-english')
   */
  model: string;
  /** Text input (single or array). Ignored when `decision` is set. */
  input?: string | string[];
  /** pipeline() and generation options */
  options?: AiInferenceOptions;
  /**
   * Retained for wire compatibility. Inference always runs through the
   * FriedFlaxia GGUF runtime; the value is ignored.
   */
  engine?: 'transformers' | 'friedflaxia';
  /**
   * Decision-model mode (d1-omni-600M). When set, the node runs
   * `system_one(state, questions, images?, audio?)` and returns calibrated
   * probabilities instead of generated text.
   *
   * Multimodal input goes through publicly fetchable URLs (same contract as
   * NSFW `imageUrl`): the node fetches bytes itself, so no signed ticket or
   * base64 blob needs to cross the orchestrator.
   * - `images`: text + image(s) in a single forward pass (tiled).
   * - `audioUrl`: text + one 16kHz mono clip (<=30s) in a single forward pass.
   * - Images and audio together are rejected (model limit): split into two
   *   tasks and merge the results host-side.
   */
  decision?: {
    /** State text (or JSON stringified). `null` when media is the whole state. */
    state?: string | null;
    questions: DecisionQuestions;
    imageUrls?: string[];
    audioUrl?: string;
  };
}

export interface AiInferenceResult {
  output: unknown;
  /**
   * Decision-mode answers keyed by question name (d1-omni). Each answer
   * carries the full option distribution in `probabilities` so hosts can
   * compute Top-K without a second round-trip.
   */
  answers?: Record<string, DecisionAnswer>;
  /** Decision-mode input token count (output_tokens is always 0). */
  inputTokens?: number;
  durationMs?: number;
}

// --- MoE Inference ---

export type MoENodeRole = 'coordinator' | 'expert';

export type MoESessionState = 'allocating' | 'ready' | 'running' | 'cleanup' | 'failed';

export interface MoEModelConfig {
  modelId: string;
  hiddenSize?: number;
  numLayers?: number;
  numAttentionHeads?: number;
  numKeyValueHeads?: number;
  headDim?: number;
  vocabSize?: number;
  numRoutedExperts?: number;
  numSharedExperts?: number;
  numExpertsPerToken?: number;
  numHashLayers?: number;
  moeIntermediateSize?: number;
  maxNewTokens?: number;
  doSample?: boolean;
  temperature?: number;
  topP?: number;
  topK?: number;
  dtype?: 'bf16' | 'fp16' | 'fp32' | 'int8' | 'int4';
  device?: 'wasm' | 'webgpu' | 'cpu';
  coordinatorUrl?: string;
  expertModelBaseUrl?: string;
}

export interface MoEExpertRequest {
  layerIndex: number;
  expertIds: number[];
  hiddenStates: Array<ArrayBuffer | ArrayLike<number>>;
  tokenCount: number;
}

export interface MoEExpertResponse {
  expertId: number;
  output: number[];
  durationMs?: number;
  error?: string;
}

export interface MoEInferencePayload {
  input: string;
  model: MoEModelConfig;
  maxNewTokens?: number;
  timeoutMs?: number;
  useRelay?: boolean;
  coordinatorId?: string;
  expertIds?: number[];
  progress?: boolean;
}

export interface MoEInferenceResult {
  output: string;
  tokens: string[];
  durationMs: number;
  expertResponses: MoEExpertResponse[];
  config: MoEModelConfig;
}

export interface MoEProgressEvent {
  type: 'progress';
  taskId: string;
  state: MoESessionState;
  layerIndex?: number;
  expertIds?: number[];
  activeExperts?: number[];
  latencyMs?: number;
  message?: string;
}

export interface MoENodeConfig {
  role?: MoENodeRole;
  expertIds?: number[];
  modelId?: string;
}

// --- Theia distributed diffusion inference ---
//
// `theia-inference` is the Theia chat service's workload. It is declared here
// so hosts and the coordinator can share one contract before the node executor
// lands (the same staging as `moe-inference`). It is deliberately absent from
// ROUTABLE_WORKLOADS until a node can execute a denoise step.
//
// Theia is a star topology: the host owns the canvas and submits normal tasks
// for each expert. There is no peer transport or layer split.

export interface TheiaChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /** Optional consumer fields; the node ignores them. */
  id?: string;
  createdAt?: number;
}

export type TheiaMergeRule =
  | 'confidence-count'
  | 'logit-mean'
  | 'probability-mean'
  | 'poe';

/**
 * `generate` runs a complete response (single expert / baseline).
 * `denoise` runs a bounded number of denoise steps over a supplied canvas and
 * returns edit deltas for the host reducer.
 */
export type TheiaPhase = 'generate' | 'denoise';

export interface TheiaSpan {
  id: string;
  /** UTF-16 offsets, `[start, end)` into `TheiaCanvas.text`. */
  start: number;
  end: number;
}

/** A span in a snapshot, including whether it is still open. */
export interface TheiaCanvasSpan extends TheiaSpan {
  open: boolean;
}

export interface TheiaCanvas {
  version: number;
  text: string;
  /**
   * Every span slot. Open slots are unmasked positions; committed slots may
   * still be revised when the host enables revisions.
   */
  spans: TheiaCanvasSpan[];
}

/**
 * v1 accepts `replace` only. Insert/delete need stable span ids and Levenshtein
 * alignment (the LLaDA2.2 style edit primitives) and are a later protocol
 * version.
 */
export type TheiaEditOp = {
  kind: 'replace';
  /** Must exactly match an editable span of the canvas snapshot. */
  span: [number, number];
  text: string;
  /** Optional per-token probabilities used to calibrate confidence. */
  tokenProbs?: number[];
};

export interface TheiaDelta {
  /** Idempotency key; re-delivery of the same id is ignored. */
  id: string;
  /** LoRA expert id, e.g. `code`, `math`, `chat`. */
  expert: string;
  /** Canvas version this proposal was computed from. */
  baseVersion: number;
  round: number;
  ops: TheiaEditOp[];
  /** Self-reported confidence in `[0, 1]`. */
  confidence: number;
  entropy?: number;
  ageRounds?: number;
}

export interface TheiaInferencePayload {
  /** Conversation handed to the dLLM denoiser. */
  messages: TheiaChatMessage[];
  /** Base model id understood by the Theia dLLM runtime (e.g. 'qwen-dlm-4b'). */
  model: string;
  /** `generate` (default) or one denoise block round. */
  phase?: TheiaPhase;
  /** LoRA adapter id for this task; omitted for the base model. */
  expert?: string;
  /** Required for `phase: 'denoise'`; the snapshot the node should edit. */
  canvas?: TheiaCanvas;
  /** Denoise round number, used for stale detection and freshness decay. */
  round?: number;
  /** Denoise steps to run in this task (block-round granularity). */
  steps?: number;
  /** Maximum denoising steps per response (default: 128). */
  maxSteps?: number;
  /** Response token budget for `phase: 'generate'` (default 64, max 256). */
  maxNewTokens?: number;
  /** Self-Repulsion strength λ (default: 64). */
  strength?: number;
  /** Node-side denoise sampling temperature (default: 0.6). */
  temperature?: number;
  /** Distribution merge rule applied by the host reducer (generate mode). */
  mergeRule?: TheiaMergeRule;
  /**
   * Scheduling hints. Task placement is independent (star topology); there is
   * no room/session record in the coordinator.
   */
  theia?: {
    preferWarm?: boolean;
  };
}

/** One node's contribution to a host aggregate (not a per-task field). */
export interface TheiaNodeInfo {
  nodeId: string;
  /** LoRA expert served by this node. */
  expert?: string;
  /** Mean prediction confidence observed for this node (0..1). */
  confidence: number;
  /** Denoising steps contributed by this node. */
  steps: number;
  /** Deltas accepted from this node. */
  deltaCount?: number;
  /** Staleness in merge rounds when this node's proposal was merged. */
  ageRounds?: number;
}

export interface TheiaInferenceResult {
  /** Present in `generate` mode. */
  output?: string;
  /** Present in `denoise` mode. */
  deltas?: TheiaDelta[];
  /** Canvas version the deltas are based on. */
  canvasVersion?: number;
  /** Denoise round the node executed. */
  round?: number;
  model: string;
  steps: number;
  /** LoRA expert served by this task. */
  expert?: string;
  phase?: TheiaPhase;
  tokens?: string[];
  /** Host-side fan-out width K (number of expert tasks), not a node request. */
  expertCount?: number;
  mergeRule?: TheiaMergeRule;
  /** Host aggregate; a single node task does not populate this. */
  nodes?: TheiaNodeInfo[];
  durationMs: number;
}

// --- Image Processing ---

export interface ImageProcessPayload {
  operation: 'resize' | 'grayscale' | 'compress' | 'thumbnail';
  /** Base64 encoded image data */
  imageBase64: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  options: {
    width?: number;
    height?: number;
    quality?: number;
    outputFormat?: 'jpeg' | 'png' | 'webp';
  };
}

export interface ImageProcessResult {
  imageBase64: string;
  mimeType: string;
  originalSizeBytes: number;
  resultSizeBytes: number;
}

// --- File Conversion (Phase 2) ---

export interface FileConvertPayload {
  operation: 'pdf-to-text' | 'markdown-to-html';
  fileBase64: string;
  mimeType: string;
  options?: Record<string, unknown>;
}

// --- Linux Container (container2wasm) ---

export interface ContainerFileSource {
  /** HTTPS API endpoint that streams the file after validating this ticket. */
  url: string;
  /** Short-lived bearer ticket; the node sends it only in Authorization. */
  token: string;
  /** Expected raw byte count, checked before the file is mounted. */
  size: number;
  /** Full SHA-256 of the expected bytes, checked before the file is mounted. */
  sha256: string;
}

export interface ContainerPayload {
  /** Name of the WASM image to load (e.g. 'alpine-magick.wasm') */
  image: string;
  /** Command and arguments to run (e.g. ['magick', 'input.jpg', '-resize', '50%', 'output.jpg']) */
  command: string[];
  /** Small input files mounted inline as base64 (legacy-compatible format). */
  files?: Record<string, string>;
  /** Input files fetched by the node just before execution, keyed by mount name. */
  fileSources?: Record<string, ContainerFileSource>;
  /** Optional memory limit for the WASM runtime (in MB) */
  memoryLimitMb?: number;
}

export interface ContainerResult {
  /** Output files from the container (Map of filename -> base64 content) */
  files: Record<string, string>;
  /** Standard output from the command */
  stdout: string;
  /** Standard error from the command */
  stderr: string;
  /** Exit code of the process */
  exitCode: number;
}

// --- Vector Embedding ---

export interface VectorEmbedPayload {
  /** Text portion of the input (may be empty when media alone is the state). */
  text?: string;
  model?: string;
  chunkIndex?: number;
  docId?: string;
  /**
   * Multimodal inputs as publicly fetchable URLs (same contract as NSFW
   * `imageUrl`): the node fetches bytes itself.
   * - `imageUrls`: image(s) interleaved with text via placeholders.
   * - `audioUrl`: mono 16kHz clip (<=327s, model context limit).
   * - `videoUrl`: MP4 sampled at 1fps, up to 16 frames (140 tokens/frame).
   * All modalities share one 8192-token context; omit to embed text only
   * (backward compatible payload).
   */
  imageUrls?: string[];
  audioUrl?: string;
  videoUrl?: string;
  /**
   * Retained for wire compatibility. Inference always runs through the
   * FriedFlaxia GGUF runtime (text, image, audio and MP4 video); the value is ignored.
   */
  engine?: 'transformers' | 'friedflaxia';
}

export interface VectorEmbedResult {
  vector: number[];
  model: string;
  dimensions: number;
  durationMs: number;
}

// --- Vector Store ---

export interface VectorStorePayload {
  docId: string;
  vector: number[];
  metadata: {
    title: string;
    url: string;
    snippet: string;
    [key: string]: unknown;
  };
  shardKey: string;
}

export interface VectorStoreResult {
  stored: boolean;
  nodeId: string;
  totalVectors: number;
}

// --- Vector Query ---

export interface VectorQueryPayload {
  queryVector: number[];
  topK: number;
}

export interface VectorQueryResult {
  results: Array<{
    docId: string;
    score: number;
    metadata: {
      title: string;
      url: string;
      snippet: string;
    };
  }>;
  nodeId: string;
  searchDurationMs: number;
}

// --- NudeNet (NSFW detection) ---

export interface NudeNetPayload {
  /** URL of an image to scan (must be fetchable from the browser node). */
  imageUrl?: string;
  /** Base64-encoded image data (used when imageUrl is not available). */
  imageBase64?: string;
  /** MIME type of the image, required when using imageBase64. */
  mimeType?: string;
  /** NudeNet model. Only `320n` is supported. */
  model?: '320n' | '640m';
  /** NMS score threshold (default: 0.25). */
  scoreThreshold?: number;
  /** NMS IoU threshold (default: 0.45). */
  iouThreshold?: number;
  /** Maximum number of detections to keep (default: 100). */
  topK?: number;
  /**
   * Retained for wire compatibility. Inference always runs through the
   * FriedFlaxia YOLOv8n runtime; the value is ignored.
   */
  engine?: 'transformers' | 'friedflaxia';
}

export interface NudeNetDetection {
  /** NudeNet class label, e.g. 'FEMALE_GENITALIA_EXPOSED'. */
  label: string;
  /** Confidence score of the detection. */
  score: number;
  /** Bounding box in original image pixel coordinates: [x1, y1, x2, y2]. */
  box: [number, number, number, number];
}

export interface NudeNetResult {
  detections: NudeNetDetection[];
  durationMs: number;
}

// --- Common Crawl extraction ---

/** One WARC record located through the Common Crawl CDX index. */
export interface CcExtractRecord {
  /** Original page URL as recorded by the CDX index. */
  url: string;
  /** WARC object path below `https://data.commoncrawl.org/`. */
  warcFilename: string;
  /**
   * Optional same-host proxy URL that serves this byte range. Browser nodes
   * cannot fetch Common Crawl directly because the `Range` header triggers a
   * CORS preflight that the archive host rejects, so hosts normally sign a
   * range URL on their own origin instead.
   */
  fetchUrl?: string;
  /** Byte offset of the compressed WARC record. */
  offset: number;
  /** Compressed byte length of the WARC record. */
  length: number;
  /** CDX content languages, when known. */
  languages?: string;
  /** CDX content digest, when known. */
  contentDigest?: string;
}

export interface CcExtractPayload {
  /** Crawl id, e.g. CC-MAIN-2026-43. */
  crawl: string;
  /** Records to extract in one task (bounded, see MAX_CC_EXTRACT_RECORDS). */
  records: CcExtractRecord[];
  /** Per-record compressed byte cap. */
  maxRecordBytes?: number;
  /** Whole-task timeout. */
  timeoutMs?: number;
}

export interface CcExtractDocument {
  /** Original URL requested from the CDX index. */
  url: string;
  /**
   * Normalised `WARC-Target-URI` of the record. It must match `url` (apart from
   * URL normalisation and any fragment), so it is informational rather than a
   * redirect target.
   */
  targetUri?: string;
  /** Canonical URL advertised by the page, when present. */
  canonicalUrl?: string;
  title: string;
  /** Extracted readable text, bounded by MAX_CC_EXTRACT_TEXT_CHARS. */
  text: string;
  /** Short display excerpt. */
  excerpt: string;
  lang?: string;
  publishedAt?: string;
  contentType: string;
  httpStatus: number;
  warcFilename: string;
  offset: number;
  length: number;
  /** True when the text or WARC body was truncated at a cap. */
  truncated: boolean;
  /** Set when this record failed; other records in the task may still succeed. */
  error?: string;
}

export interface CcExtractResult {
  documents: CcExtractDocument[];
  durationMs: number;
}

// --- EmbeddingGemma 2 text embeddings ---

/** Native output dimension of EmbeddingGemma 2. */
export type EmbedGemmaDimensions = 768 | 512 | 256 | 128;

export interface EmbedGemmaPayload {
  /** 1..MAX_EMBED_GEMMA_TEXTS strings. Prefixes are applied by the host. */
  texts: string[];
  /** Matryoshka truncation target. Defaults to the native 768. */
  dimensions?: EmbedGemmaDimensions;
  /**
   * Retained for wire compatibility. Inference always runs through the pinned
   * FriedFlaxia GGUF runner; the value is ignored.
   */
  engine?: 'transformers' | 'friedflaxia';
}

export interface EmbedGemmaResult {
  /** One normalised vector per input text (128, 256, 512 or 768 dimensions). */
  vectors: number[][];
  model: string;
  dimensions: number;
  durationMs: number;
}

// --- Core Task Types ---

/** Scheduling hints any workload payload may carry. */
export interface TaskPayloadRouting {
  /**
   * Optional allow-list of node site ids. When set, the coordinator only hands
   * the task to nodes whose signed registration token carries one of these
   * site ids, and fails the task if no such node appears before its deadline.
   *
   * Note: a volunteer node necessarily sees the payload it executes, so this
   * restricts *which* sites see it, not whether a node can read it.
   */
  allowedSites?: string[];
}

export type TaskPayload = (
  | AiInferencePayload
  | ImageProcessPayload
  | FileConvertPayload
  | ContainerPayload
  | VectorEmbedPayload
  | VectorStorePayload
  | VectorQueryPayload
  | MoEInferencePayload
  | NudeNetPayload
  | CcExtractPayload
  | EmbedGemmaPayload
  | TheiaInferencePayload
) & TaskPayloadRouting;

export interface TaskRecord {
  id: string;
  status: TaskStatus;
  workload: WorkloadType;
  payload: TaskPayload;
  createdAt: number;
  /**
   * Tenant that submitted the task (derived from the API key). Every read path
   * is scoped to it: another tenant's key gets a 404, never this record.
   */
  tenantId: string;
  /**
   * Optional site allow-list copied from `payload.allowedSites`. When present,
   * only nodes whose signed token carries a matching `siteId` may run the task.
   */
  allowedSites?: string[];
  /** Caller-selected scheduling class. Lower values age into fair service. */
  priority?: 0 | 1 | 2 | 3;
  /** Start of the current pending interval; resets when a failed attempt is retried. */
  queuedAt?: number;
  assignedAt?: number;
  /** Milliseconds spent pending before the current assignment. */
  queueWaitMs?: number;
  /** Incremented when a retried attempt re-prefills and resets streamed output. */
  streamEpoch?: number;
  completedAt?: number;
  assignedNodeId?: string;
  assignedCoordinatorNodeId?: string;
  assignedExpertNodeIds?: string[];
  /** Compact explanation of the coordinator's selected placement heuristic. */
  placementReason?:
    | 'only-eligible-candidate'
    | 'warm-model'
    | 'measured-gpu'
    | 'known-capacity'
    | 'reported-load'
    | 'assignment-count'
    | 'stable-order';
  retryCount: number;
  timeoutMs: number;
  callbackUrl?: string;
  result?: unknown;
  error?: string;
  /** Node that produced the accepted result (audit trail). */
  resultNodeId?: string;
  /** Delivery attempt that produced the accepted result (audit trail). */
  resultAttemptId?: string;
  /**
   * Short-lived token for `GET /crowd/subscribe`, present only on API responses
   * (`POST /crowd/tasks`, `GET /crowd/tasks/:id`). Never stored on the task.
   */
  subscribeToken?: string;
  /** Unix ms expiry of {@link TaskRecord.subscribeToken}. */
  subscribeTokenExpiresAt?: number;
}

/** Response returned by POST /crowd/tasks (a partial snapshot, not a full TaskRecord). */
export interface SubmitTaskResponse {
  message: string;
  taskId: string;
  id: string;
  status: TaskStatus;
  createdAt: number;
  /** Short-lived token required by `GET /crowd/subscribe` for this task. */
  subscribeToken?: string;
  subscribeTokenExpiresAt?: number;
}

/** Signals that the current attempt ended and a retry will restart from the prompt. */
export interface TaskStreamReset {
  epoch: number;
}

export interface TaskQueueStats {
  pendingCount: number;
  pendingByPriority: Record<0 | 1 | 2 | 3, number>;
  assignedByPriority: Record<0 | 1 | 2 | 3, number>;
  rejectionCounts: Record<'global-cap' | 'tenant-cap' | 'enqueue-rate', number>;
  oldestPendingWaitMs: number | null;
  lastAssignmentWaitMs: number | null;
  maxAssignmentWaitMs: number | null;
  updatedAt: number | null;
}

/**
 * Coordinator -> node: the task is already settled (it timed out, a peer
 * failed, the plan was rejected), so stop working on it.
 *
 * Without this a node still running a session holds a slot the scheduler counts
 * as busy for the rest of the task timeout. The receiver must not report the
 * abort back: the coordinator may already have requeued the task for a retry,
 * and an error echo would race that attempt.
 */
export interface AbortMessage {
  type: 'abort';
  taskId: string;
  error: string;
}

// --- Node Types ---

/**
 * Persisted consent state for a browser node.
 *
 * - `granted`: the visitor opted in and the node may run.
 * - `denied`: the visitor opted out; the node must stay off.
 * - `unset`: no decision yet; a host or the built-in UI should ask.
 */
export type ConsentState = 'unset' | 'granted' | 'denied';

/**
 * Handed to a host that renders its own consent UI. The host calls
 * {@link ConsentControls.accept} or {@link ConsentControls.reject} so the node
 * bundle owns persistence and node lifecycle.
 */
export interface ConsentControls {
  /** Consent state at the moment the host UI was requested. */
  state: ConsentState;
  /** Persist consent and start the node. */
  accept(): void;
  /** Persist denial and stop the node. */
  reject(): void;
}

export interface ConsentConfig {
  brandName: string;
  position: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
  accentColor?: string;
  /**
   * Optional host-provided consent UI. When set, the built-in `ConsentUI` is
   * never rendered: the node calls this only while the state is `unset`, and
   * the host decides how (and whether) to prompt. Other hosts omit it and keep
   * the built-in banner.
   */
  onConsentRequired?: (controls: ConsentControls) => void;
}

/**
 * Control surface returned by {@link initFlaxiaNode}. Hosts use it to reflect
 * and change consent from a settings screen without re-initialising the bundle.
 */
export interface FlaxiaNodeController {
  /** Start the node (no-op when already running). */
  start(): void;
  /** Stop the node and release its Web Worker. */
  stop(): void;
  /** Whether the node currently has an active signaling client. */
  isRunning(): boolean;
  /** Read the persisted consent state (honours the consent TTL). */
  getConsentState(): ConsentState;
  /** Persist consent (clears any previous denial). */
  grant(): void;
  /** Persist denial and stop the node (clears any previous consent). */
  deny(): void;
  /** Forget the consent decision entirely (granted, denied and expiry). */
  clearConsent(): void;
  /**
   * Run `ai-inference` locally without involving the orchestrator. Only
   * present on nodes built with Light Inference support; older bundles leave
   * it undefined and callers must fall back to a coordinator routed task.
   *
   * When `options.ondeviceOnly === true` and the model is not already held,
   * throws `OndeviceUnavailableError` (code `ONDEVICE_UNAVAILABLE`, status 500).
   */
  runLocalAiInference?: (
    payload: AiInferencePayload,
    onToken?: (token: string) => void | Promise<void>,
  ) => Promise<AiInferenceResult>;
  /** Whether the given model is ready to serve without a download. */
  isAiModelPreloaded?: (model: string) => boolean;
  /** Download + warm the given model during idle time. */
  preloadAiModel?: (request: {
    task: string;
    model: string;
    dtype?: string;
    device?: string;
  }) => Promise<void>;
}

export interface NodeConfig {
  orchestratorUrl: string;
  siteId: string;
  consent: ConsentConfig;
  maxCpuLoad?: number;
  capabilities?: WorkloadType[];
  /**
   * Opt in to the bounded WebGPU compute probe used as resource telemetry.
   * Disabled by default: the probe creates a temporary device and submits a
   * few tiny compute passes, so hosts must ask for it explicitly. It is only a
   * scheduling hint and never authorizes a workload.
   */
  probeGpu?: boolean;
  /** Exact HTTPS origins allowed to serve executable container WASM images. */
  containerImageOrigins?: string[];
  /** Exact HTTPS origins from which signed container file sources may be fetched. */
  fileSourceOrigins?: string[];
  /** Exact HTTPS origins allowed to serve signed Common Crawl byte ranges. */
  ccRangeOrigins?: string[];
  moe?: MoENodeConfig;
}

/** How a resource value was obtained. Unknown values are always represented by null. */
export type ResourceMetricSource = 'measured' | 'estimated' | 'unknown';

export type ResourceMetricUnit = 'ratio' | 'bytes' | 'GiB' | 'ms' | 'text';

/** A bounded, time-stamped resource observation. `expiresAt` is never a cache hint from the node. */
export interface ResourceMetric<T extends number | string> {
  value: T | null;
  unit: ResourceMetricUnit;
  source: ResourceMetricSource;
  sampledAt: number;
  expiresAt: number;
  sampleCount: number;
}

export type GpuProbeStatus = 'available' | 'unsupported' | 'unavailable' | 'device-lost' | 'unknown';

/** Current, self-reported diagnostics used for scheduling hints, never trust decisions. */
export interface NodeResourceReport {
  version: 1;
  sampledAt: number;
  expiresAt: number;
  cpuLoad: ResourceMetric<number>;
  wasmMemoryLowerBound: ResourceMetric<number>;
  deviceMemory: ResourceMetric<number>;
  gpu: {
    status: GpuProbeStatus;
    sampledAt: number;
    expiresAt: number;
    architecture: ResourceMetric<string>;
    maxStorageBufferBindingSize: ResourceMetric<number>;
    computeCompletionMs: ResourceMetric<number>;
    /** Total/free GPU memory is not exposed by WebGPU and remains unknown. */
    memoryBytes: ResourceMetric<number>;
  };
}

export interface MemoryBudgetInput {
  availableBytes: number | null;
  modelBytes: number | null;
  activationBytes: number | null;
  kvCacheBytes: number | null;
  reservedBytes: number | null;
  safetyMarginBytes: number | null;
}

export interface MemoryBudgetResult {
  fits: boolean | null;
  requiredBytes: number | null;
  availableBytes: number | null;
  missing: Array<'availableBytes' | 'modelBytes' | 'activationBytes' | 'kvCacheBytes' | 'reservedBytes' | 'safetyMarginBytes'>;
}

/** A layer span of a model a node already holds in its persistent cache. */
export interface WarmModelRange {
  modelId: string;
  /** Cached contiguous layer range [start, end], inclusive. */
  layers: [number, number];
}

/**
 * Body of `POST /crowd/nodes/register`. Shared so worker and node agree on the
 * capability contract.
 */
export interface NodeRegisterRequest {
  siteId: string;
  /**
   * Ignored. The coordinator always issues a fresh random node id and binds the
   * token to it, so a node can never claim (and displace) another node's
   * identity. Kept for wire compatibility with older clients.
   */
  nodeId?: string;
  capabilities?: WorkloadType[];
  /** Advertises support for the additive container fileSources payload field. */
  fileSources?: boolean;
  deviceMemory?: number | null;
  /**
   * Measured WASM memory the device could commit, in bytes. Clamped by the
   * coordinator to a sane maximum; the value is self-reported and only used to
   * order candidate nodes, never as a trust decision.
   */
  wasmMemoryBytes?: number;
  /** Warm model layer ranges the node can serve without a download. */
  warmModels?: WarmModelRange[];
}

export interface NodeRegisterResponse {
  /** Base64url node token; bound to the returned `nodeId` and `siteId`. */
  token: string;
  /** Server-issued node id. Always use this, never a locally chosen id. */
  nodeId: string;
  expiresAt: number;
  lowMemory: boolean;
}
