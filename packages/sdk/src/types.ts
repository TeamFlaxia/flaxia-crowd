/**
 * Shared Type Definitions for Flaxia Crowd
 */

export type TaskStatus = 'pending' | 'assigning' | 'processing' | 'done' | 'failed';

export type WorkloadType = 'ai-inference' | 'image-process' | 'file-convert' | 'container' | 'vector-embed' | 'vector-store' | 'vector-query' | 'moe-inference' | 'nudenet';

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

export type TaskPayload = AiInferencePayload | ImageProcessPayload | FileConvertPayload | ContainerPayload | VectorEmbedPayload | VectorStorePayload | VectorQueryPayload | MoEInferencePayload | NudeNetPayload;

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

// --- Node Types ---

export interface NodeConfig {
  orchestratorUrl: string;
  siteId: string;
  consent: {
    brandName: string;
    position: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
    accentColor?: string;
  };
  maxCpuLoad?: number;
  capabilities?: WorkloadType[];
  moe?: MoENodeConfig;
}
