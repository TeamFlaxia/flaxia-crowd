/** Maximum number of streamed tokens a subscriber may leave unacknowledged. */
export const MAX_SUBSCRIBER_INFLIGHT_TOKENS = 32;
/** Bound serialized token messages retained by one unacknowledged subscriber window. */
export const MAX_SUBSCRIBER_INFLIGHT_BYTES = 512 * 1024;
/** Pause a swarm host before its bounded subscriber window is exhausted. */
export const SUBSCRIBER_PAUSE_AT_TOKENS = 16;
/** Resume generation once all subscribers have drained below this watermark. */
export const SUBSCRIBER_RESUME_AT_TOKENS = 8;
/** Close a subscriber that stops acknowledging tokens for this long. */
export const SUBSCRIBER_ACK_TIMEOUT_MS = 30_000;
/** Bound tokens waiting in the SDK before a consumer registers or finishes its callback. */
export const MAX_SDK_BUFFERED_TOKENS = 32;
/** Bound aggregate UTF-16 code units retained by one SDK subscription. */
export const MAX_SDK_BUFFERED_TOKEN_CHARS = 64 * 1024;
