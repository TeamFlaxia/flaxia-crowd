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
  | 'swarm-inference';

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
}

export interface AiInferencePayload {
  /**
   * Transformer.js pipeline task name (e.g. 'text-classification')
   */
  task: string;
  /**
   * HuggingFace model name (e.g. 'Xenova/distilbert-base-uncased-finetuned-sst-2-english')
   */
  model: string;
  /** Text input (single or array) */
  input: string | string[];
  /** pipeline() and generation options */
  options?: AiInferenceOptions;
}

export interface AiInferenceResult {
  output: unknown;
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

// --- Swarm Inference (multi-node, layer-sharded generation) ---

/** Room-sizing and scheduling hints for a swarm inference job. */
export interface SwarmOptions {
  /** Minimum nodes the job needs before it may start (default: 1). */
  minNodes?: number;
  /** Maximum nodes the coordinator may reserve (default: 4). */
  maxNodes?: number;
  /** Prefer nodes whose layer range is already cached (default: true). */
  preferWarm?: boolean;
}

export interface SwarmInferencePayload {
  /**
   * Model identifier understood by the swarm engine (e.g. 'qwen3-1.7b').
   * The engine resolves it to a GGUF source and layer plan.
   */
  model: string;
  /** Prompt text for a base model, or a single user turn for an instruct model. */
  prompt: string | string[];
  /** Maximum number of tokens to generate (default: 128). */
  maxNewTokens?: number;
  /** Sampling temperature (default: greedy / 0). */
  temperature?: number;
  /** Top-p nucleus sampling threshold. */
  topP?: number;
  /** Top-k sampling threshold. */
  topK?: number;
  /** Optional room sizing / scheduling hints. */
  swarm?: SwarmOptions;
}

/** One node's role in a completed swarm session, surfaced in the result. */
export interface SwarmInferenceNodeInfo {
  /** Assigned contiguous transformer layer range `[start, end)` (end exclusive, as in {@link SwarmSlice}). */
  layers: [number, number];
  /** Whether this node ran the host duties (tokenizer, embed, LM head, sampling). */
  host: boolean;
  /**
   * Whether the node served its layer range from a warm cache. Only set for a
   * node that can observe its own cache (the reporter); the other members'
   * warmth is not part of the protocol, so it is omitted rather than guessed.
   */
  warm?: boolean;
  /** Per-node load duration in milliseconds, when reported. */
  loadMs?: number;
}

export interface SwarmInferenceResult {
  output: string;
  tokens: string[];
  nodes: SwarmInferenceNodeInfo[];
  durationMs: number;
  prefillMs?: number;
  tokensPerSecond?: number;
}

/** A node's role in a swarm session: the host drives generation, workers run a slice. */
export type SwarmRole = 'host' | 'worker';

/** One node's contiguous transformer layer slice. `end` is exclusive. */
export interface SwarmSlice {
  start: number;
  end: number;
  hasEmbed: boolean;
  hasHead: boolean;
}

export interface SwarmChainNode {
  nodeId: string;
  role: SwarmRole;
  slice: SwarmSlice;
}

/** The layer placement and ordered node chain for one swarm inference session. */
export interface SwarmSessionPlan {
  sessionId: string;
  taskId: string;
  model: string;
  /** Total number of trunk layers in the model. */
  layers: number;
  /** Ordered chain; index 0 is the host and owns the generation loop. */
  chain: SwarmChainNode[];
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

export interface ContainerPayload {
  /** Name of the WASM image to load (e.g. 'alpine-magick.wasm') */
  image: string;
  /** Command and arguments to run (e.g. ['magick', 'input.jpg', '-resize', '50%', 'output.jpg']) */
  command: string[];
  /** Input files to mount into the container (Map of filename -> base64 content) */
  files: Record<string, string>;
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
  text: string;
  model?: string;
  chunkIndex?: number;
  docId?: string;
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
  /** ONNX model to use. '320n' (default) or '640m'. */
  model?: '320n' | '640m';
  /** NMS score threshold (default: 0.25). */
  scoreThreshold?: number;
  /** NMS IoU threshold (default: 0.45). */
  iouThreshold?: number;
  /** Maximum number of detections to keep (default: 100). */
  topK?: number;
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

// --- Core Task Types ---

export type TaskPayload =
  | AiInferencePayload
  | ImageProcessPayload
  | FileConvertPayload
  | ContainerPayload
  | VectorEmbedPayload
  | VectorStorePayload
  | VectorQueryPayload
  | MoEInferencePayload
  | NudeNetPayload
  | SwarmInferencePayload;

export interface TaskRecord {
  id: string;
  status: TaskStatus;
  workload: WorkloadType;
  payload: TaskPayload;
  createdAt: number;
  assignedAt?: number;
  completedAt?: number;
  assignedNodeId?: string;
  assignedCoordinatorNodeId?: string;
  assignedExpertNodeIds?: string[];
  retryCount: number;
  timeoutMs: number;
  callbackUrl?: string;
  /** Set for `swarm-inference` tasks once the coordinator has assembled a chain. */
  swarmSession?: SwarmSessionPlan;
  result?: unknown;
  error?: string;
}

/** Response returned by POST /crowd/tasks (a partial snapshot, not a full TaskRecord). */
export interface SubmitTaskResponse {
  message: string;
  taskId: string;
  id: string;
  status: TaskStatus;
  createdAt: number;
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
  /** Required for swarm tasks: identifies the attempt being stopped. */
  sessionId?: string;
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
}

export interface NodeConfig {
  orchestratorUrl: string;
  siteId: string;
  consent: ConsentConfig;
  maxCpuLoad?: number;
  capabilities?: WorkloadType[];
  moe?: MoENodeConfig;
  /**
   * Opt in to downloading model layer weights for swarm inference. Swarm jobs
   * can pull multi-GB byte spans into the browser cache, so hosts must ask for
   * this explicitly rather than inheriting it from the general node consent.
   */
  allowModelDownload?: boolean;
}

/**
 * GPU capability a node advertises to the orchestrator. Only nodes with
 * `webgpu: true` are eligible for `swarm-inference` routing.
 */
export interface SwarmNodeCapabilities {
  webgpu: boolean;
  /** Adapter vendor/architecture string, when the browser exposes one. */
  gpuArchitecture?: string;
  /** Adapter max storage-buffer binding size in bytes, when reported. */
  maxStorageBufferBindingSize?: number;
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
  nodeId?: string;
  capabilities?: WorkloadType[];
  deviceMemory?: number | null;
  /** Measured WASM memory the device could commit, in bytes. */
  wasmMemoryBytes?: number;
  /** WebGPU capabilities, when the node has been probed for swarm inference. */
  swarm?: SwarmNodeCapabilities;
  /** Warm model layer ranges the node can serve without a download. */
  warmModels?: WarmModelRange[];
}

export interface NodeRegisterResponse {
  token: string;
  nodeId: string;
  expiresAt: number;
  lowMemory: boolean;
}
