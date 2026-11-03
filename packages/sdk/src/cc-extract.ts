/**
 * Shared limits and validation for the `cc-extract` workload.
 *
 * A task names a small set of WARC records from the Common Crawl CDX index.
 * Hosts walk the index; volunteer nodes fetch only those byte ranges and return
 * bounded extracted text. Keeping the limits here means the API boundary and
 * the node enforce the same numbers.
 */

/** Fixed origin for Common Crawl archive data. */
export const CC_DATA_HOST = 'data.commoncrawl.org';
/** Fixed origin for the Common Crawl CDX index. */
export const CC_INDEX_HOST = 'index.commoncrawl.org';

/** Maximum WARC records accepted in one task. */
export const MAX_CC_EXTRACT_RECORDS = 3;
/** Maximum compressed bytes per WARC record. */
export const MAX_CC_EXTRACT_RECORD_BYTES = 2 * 1024 * 1024;
/** Maximum compressed bytes across all records in one task. */
export const MAX_CC_EXTRACT_TOTAL_BYTES = 4 * 1024 * 1024;
/** Maximum extracted text characters returned per document. */
export const MAX_CC_EXTRACT_TEXT_CHARS = 16_000;
/** Default whole-task timeout. */
export const DEFAULT_CC_EXTRACT_TIMEOUT_MS = 30_000;
/** Hard cap for a caller-supplied whole-task timeout. */
export const MAX_CC_EXTRACT_TIMEOUT_MS = 60_000;
/** Maximum URL length accepted in a record. */
export const MAX_CC_EXTRACT_URL_CHARS = 2_048;
/** Maximum signed range-proxy URL length accepted in a record. */
export const MAX_CC_EXTRACT_FETCH_URL_CHARS = 4_096;
/** Crawl id shape, e.g. CC-MAIN-2026-43. */
export const CC_CRAWL_PATTERN = /^CC-MAIN-\d{4}-\d{2}$/;
/**
 * WARC object paths are always under `crawl-data/CC-MAIN-.../segments/.../warc/`.
 * The character classes exclude absolute paths, query strings and hosts, and
 * the negative lookaheads reject `.` / `..` path segments so a path can never
 * be normalised into another directory (important because hosts build signed
 * range-proxy URLs from this value).
 */
export const CC_WARC_PATH_PATTERN =
  /^crawl-data\/CC-MAIN-\d{4}-\d{2}\/segments\/(?!\.{1,2}\/)[A-Za-z0-9._-]+\/warc\/(?!\.{1,2}\/)[A-Za-z0-9._-]+\.warc\.gz$/;

/** True when a string is a safe Common Crawl WARC object path. */
export function isValidCcWarcPath(value: unknown): value is string {
  return typeof value === 'string' && CC_WARC_PATH_PATTERN.test(value);
}

/**
 * True when the (already validated) WARC object path belongs to `crawl`.
 * The payload carries both fields, so a mismatched pair is a client bug that
 * should be rejected instead of silently fetching a different crawl.
 */
export function ccWarcPathMatchesCrawl(warcFilename: unknown, crawl: unknown): boolean {
  return (
    typeof crawl === 'string' &&
    CC_CRAWL_PATTERN.test(crawl) &&
    isValidCcWarcPath(warcFilename) &&
    warcFilename.startsWith(`crawl-data/${crawl}/`)
  );
}
