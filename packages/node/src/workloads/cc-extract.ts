import { parse } from 'parse5';
import {
  CC_DATA_HOST,
  DEFAULT_CC_EXTRACT_TIMEOUT_MS,
  MAX_CC_EXTRACT_RECORD_BYTES,
  MAX_CC_EXTRACT_RECORDS,
  MAX_CC_EXTRACT_TEXT_CHARS,
  MAX_CC_EXTRACT_TIMEOUT_MS,
  MAX_CC_EXTRACT_TOTAL_BYTES,
  isValidCcWarcPath,
  type CcExtractDocument,
  type CcExtractPayload,
  type CcExtractRecord,
  type CcExtractResult,
} from '@flaxia/sdk';

/** Hard ceiling for a decompressed WARC record before parsing. */
export const MAX_CC_WARC_DECOMPRESSED_BYTES = 8 * 1024 * 1024;
/** Hard ceiling for the HTTP response body inside a WARC record. */
export const MAX_CC_HTTP_BODY_BYTES = 4 * 1024 * 1024;
/** Per-record network timeout. The whole task is also bounded by the payload. */
export const CC_RECORD_TIMEOUT_MS = 20_000;
/** Identifies Flaxia Crowd to Common Crawl's data host. */
export const CC_USER_AGENT = 'FlaxiaCrowd/0.6 (+https://flaxia.app/crowd)';

const HTTP_MESSAGE_SEPARATOR = new Uint8Array([13, 10, 13, 10]);
const LF_MESSAGE_SEPARATOR = new Uint8Array([10, 10]);

interface HtmlNode {
  nodeName: string;
  tagName?: string;
  value?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: HtmlNode[];
}

interface WarcResponse {
  targetUri: string;
  status: number;
  contentType: string;
  charset: string;
  body: Uint8Array;
  truncated: boolean;
}

interface ExtractedDocument {
  title: string;
  text: string;
  excerpt: string;
  canonicalUrl?: string;
  lang?: string;
  publishedAt?: string;
  truncated: boolean;
}

function fail(message: string): never {
  throw new Error(`cc-extract: ${message}`);
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, start = 0): number {
  outer: for (let i = start; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/** Split a byte buffer at the first header terminator, tolerating LF-only input. */
function splitHeaders(bytes: Uint8Array): { headerText: string; body: Uint8Array } | null {
  let end = indexOfBytes(bytes, HTTP_MESSAGE_SEPARATOR);
  let separatorLength = HTTP_MESSAGE_SEPARATOR.length;
  if (end === -1) {
    end = indexOfBytes(bytes, LF_MESSAGE_SEPARATOR);
    separatorLength = LF_MESSAGE_SEPARATOR.length;
  }
  if (end === -1) return null;
  const headerText = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, end));
  return { headerText, body: bytes.slice(end + separatorLength) };
}

function parseHeaderLines(headerText: string): Map<string, string> {
  const headers = new Map<string, string>();
  let lastKey: string | null = null;
  for (const rawLine of headerText.split(/\r?\n/)) {
    if (rawLine === '') continue;
    if ((rawLine.startsWith(' ') || rawLine.startsWith('\t')) && lastKey) {
      headers.set(lastKey, `${headers.get(lastKey) ?? ''} ${rawLine.trim()}`);
      continue;
    }
    const colon = rawLine.indexOf(':');
    if (colon <= 0) continue;
    const key = rawLine.slice(0, colon).trim().toLowerCase();
    const value = rawLine.slice(colon + 1).trim();
    headers.set(key, value);
    lastKey = key;
  }
  return headers;
}

function normalizeComparableUrl(value: string): string | null {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

async function readCappedStream(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        fail(`decompressed body exceeded ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

async function decompress(encoding: 'gzip' | 'deflate', bytes: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const body = new Response(buffer).body;
  if (!body) fail('empty response body');
  return readCappedStream(body.pipeThrough(new DecompressionStream(encoding)), maxBytes);
}

function resolveFetchUrl(record: CcExtractRecord, allowedOrigins: readonly string[]): string {
  if (record.fetchUrl !== undefined) {
    let parsed: URL;
    try {
      parsed = new URL(record.fetchUrl);
    } catch {
      fail('fetchUrl is not a valid URL');
    }
    if (parsed.protocol !== 'https:') fail('fetchUrl must use https');
    if (parsed.username || parsed.password) fail('fetchUrl must not carry credentials');
    if (allowedOrigins.length === 0) fail('no cc range origins are configured');
    if (!allowedOrigins.includes(parsed.origin)) fail(`fetchUrl origin is not allowed: ${parsed.origin}`);
    return parsed.toString();
  }
  return `https://${CC_DATA_HOST}/${record.warcFilename}`;
}

async function fetchWarcRecord(
  record: CcExtractRecord,
  maxRecordBytes: number,
  timeoutMs: number,
  allowedOrigins: readonly string[],
): Promise<Uint8Array> {
  if (!isValidCcWarcPath(record.warcFilename)) fail('invalid WARC object path');
  if (!Number.isSafeInteger(record.offset) || record.offset < 0) fail('invalid WARC offset');
  if (!Number.isSafeInteger(record.length) || record.length < 1) fail('invalid WARC length');
  if (record.length > maxRecordBytes) fail(`WARC record is larger than the ${maxRecordBytes}-byte cap`);

  const url = resolveFetchUrl(record, allowedOrigins);
  const response = await fetch(url, {
    headers: {
      Range: `bytes=${record.offset}-${record.offset + record.length - 1}`,
      Accept: 'application/octet-stream',
      'User-Agent': CC_USER_AGENT,
    },
    redirect: 'follow',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) fail(`Common Crawl returned HTTP ${response.status}`);
  if (!response.body) fail('Common Crawl returned an empty body');

  const contentRange = response.headers.get('content-range');
  if (contentRange) {
    const match = /^bytes\s+(\d+)-(\d+)\//i.exec(contentRange.trim());
    if (!match || Number(match[1]) !== record.offset) {
      fail(`Common Crawl range mismatch for ${url}`);
    }
  } else if (response.status !== 206) {
    fail(`Common Crawl ignored the byte range (HTTP ${response.status})`);
  }

  const compressed = await readCappedStream(response.body, maxRecordBytes);
  if (compressed.byteLength !== record.length) {
    fail(`expected ${record.length} compressed bytes, received ${compressed.byteLength}`);
  }
  return compressed;
}

function decodeBytes(bytes: Uint8Array, charset?: string): string {
  const label = charset?.trim() || 'utf-8';
  try {
    return new TextDecoder(label, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
}

async function parseWarcResponse(record: CcExtractRecord, warcBytes: Uint8Array): Promise<WarcResponse> {
  const warc = splitHeaders(warcBytes);
  if (!warc) fail('malformed WARC headers');
  const warcHeaders = parseHeaderLines(warc.headerText);

  const warcType = warcHeaders.get('warc-type');
  if (warcType !== 'response' && warcType !== 'resource') {
    fail(`unsupported WARC type: ${warcType ?? 'missing'}`);
  }

  const targetUri = warcHeaders.get('warc-target-uri') ?? '';
  const expected = normalizeComparableUrl(record.url);
  const actual = normalizeComparableUrl(targetUri);
  if (!expected || !actual || expected !== actual) {
    fail('WARC target URI does not match the requested URL');
  }

  const declaredLength = Number(warcHeaders.get('content-length'));
  let httpMessage = warc.body;
  let truncated = false;
  if (Number.isFinite(declaredLength) && declaredLength >= 0 && declaredLength < httpMessage.byteLength) {
    httpMessage = httpMessage.slice(0, declaredLength);
  } else if (Number.isFinite(declaredLength) && declaredLength > httpMessage.byteLength) {
    truncated = true;
  }
  if (httpMessage.byteLength > MAX_CC_HTTP_BODY_BYTES) {
    httpMessage = httpMessage.slice(0, MAX_CC_HTTP_BODY_BYTES);
    truncated = true;
  }

  const http = splitHeaders(httpMessage);
  if (!http) fail('malformed HTTP message in WARC record');
  const firstLine = http.headerText.split(/\r?\n/, 1)[0] ?? '';
  const statusMatch = /^HTTP\/\d\.\d\s+(\d{3})/.exec(firstLine);
  if (!statusMatch) fail('malformed HTTP status line');
  const status = Number(statusMatch[1]);

  const httpHeaders = parseHeaderLines(http.headerText);
  const contentTypeHeader = httpHeaders.get('content-type') ?? '';
  const contentType = contentTypeHeader.split(';')[0]!.trim().toLowerCase();
  const charsetMatch = /charset\s*=\s*"?([^";\s]+)"?/i.exec(contentTypeHeader);
  const charset = charsetMatch?.[1] ?? 'utf-8';

  let body = http.body;
  const contentEncoding = (httpHeaders.get('content-encoding') ?? '').toLowerCase();
  if (contentEncoding === 'gzip' || contentEncoding === 'deflate') {
    body = await decompress(contentEncoding, body, MAX_CC_WARC_DECOMPRESSED_BYTES);
  } else if (contentEncoding && contentEncoding !== 'identity') {
    fail(`unsupported content-encoding: ${contentEncoding}`);
  }
  if (httpHeaders.get('warc-truncated')) truncated = true;

  return { targetUri, status, contentType, charset, body, truncated };
}

function attr(node: HtmlNode | undefined, name: string): string | undefined {
  return node?.attrs?.find((entry) => entry.name.toLowerCase() === name)?.value;
}

function findFirst(node: HtmlNode | undefined, tagName: string): HtmlNode | undefined {
  if (!node) return undefined;
  if (node.tagName?.toLowerCase() === tagName) return node;
  for (const child of node.childNodes ?? []) {
    const found = findFirst(child, tagName);
    if (found) return found;
  }
  return undefined;
}

function findAll(node: HtmlNode | undefined, predicate: (node: HtmlNode) => boolean, out: HtmlNode[] = []): HtmlNode[] {
  if (!node) return out;
  if (predicate(node)) out.push(node);
  for (const child of node.childNodes ?? []) findAll(child, predicate, out);
  return out;
}

const SKIPPED_TEXT_TAGS = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'canvas',
  'iframe',
  'object',
  'embed',
  'head',
]);

function collectText(node: HtmlNode | undefined, out: string[]): void {
  if (!node) return;
  const tag = node.tagName?.toLowerCase();
  if (tag && SKIPPED_TEXT_TAGS.has(tag)) return;
  if (node.nodeName === '#text' && node.value) out.push(node.value);
  for (const child of node.childNodes ?? []) collectText(child, out);
}

function normalizeText(value: string): string {
  return value
    .replace(/\u0000/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstText(node: HtmlNode | undefined): string {
  const out: string[] = [];
  collectText(node, out);
  return normalizeText(out.join(' '));
}

function metaContent(nodes: HtmlNode[], names: string[]): string {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  for (const node of nodes) {
    const key = (attr(node, 'property') || attr(node, 'name') || '').toLowerCase();
    if (wanted.has(key)) {
      const content = attr(node, 'content');
      if (content) return normalizeText(content);
    }
  }
  return '';
}

function extractDocument(html: string, url: string): ExtractedDocument {
  const document = parse(html) as unknown as HtmlNode;
  const metas = findAll(document, (node) => node.tagName?.toLowerCase() === 'meta');
  const links = findAll(document, (node) => node.tagName?.toLowerCase() === 'link');
  const htmlNode = findFirst(document, 'html');

  const title =
    firstText(findFirst(document, 'title')) ||
    metaContent(metas, ['og:title', 'twitter:title']) ||
    firstText(findFirst(document, 'h1')) ||
    url;

  const description = metaContent(metas, ['description', 'og:description', 'twitter:description']);
  const canonicalNode = links.find((node) => (attr(node, 'rel') || '').toLowerCase().split(/\s+/).includes('canonical'));
  const canonicalHref = attr(canonicalNode, 'href');
  let canonicalUrl: string | undefined;
  if (canonicalHref) {
    try {
      const resolved = new URL(canonicalHref, url);
      if (resolved.protocol === 'https:' || resolved.protocol === 'http:') canonicalUrl = resolved.toString();
    } catch {
      // Ignore an invalid canonical link.
    }
  }
  const publishedAt =
    metaContent(metas, ['article:published_time', 'datepublished', 'og:updated_time']) ||
    attr(findFirst(document, 'time'), 'datetime') ||
    '';

  const contentRoot =
    findFirst(document, 'article') ||
    findFirst(document, 'main') ||
    findAll(document, (node) => attr(node, 'role')?.toLowerCase() === 'main')[0] ||
    findFirst(document, 'body') ||
    document;

  const textParts: string[] = [];
  collectText(contentRoot, textParts);
  let text = normalizeText(textParts.join(' '));
  let truncated = false;
  if (text.length > MAX_CC_EXTRACT_TEXT_CHARS) {
    text = text.slice(0, MAX_CC_EXTRACT_TEXT_CHARS);
    truncated = true;
  }

  const excerptSource = description || text;
  const excerpt = excerptSource.slice(0, 320).trim();

  return {
    title: title.slice(0, 300),
    text,
    excerpt,
    canonicalUrl,
    lang: attr(htmlNode, 'lang')?.trim() || undefined,
    publishedAt: publishedAt || undefined,
    truncated,
  };
}

function validatePayload(payload: CcExtractPayload): {
  records: CcExtractRecord[];
  maxRecordBytes: number;
  timeoutMs: number;
} {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('payload must be an object');
  const records = payload.records;
  if (!Array.isArray(records) || records.length === 0 || records.length > MAX_CC_EXTRACT_RECORDS) {
    fail(`records must contain 1..${MAX_CC_EXTRACT_RECORDS} entries`);
  }
  let totalBytes = 0;
  for (const record of records) {
    if (!record || typeof record !== 'object') fail('record must be an object');
    if (typeof record.url !== 'string' || !record.url) fail('record.url is required');
    if (!isValidCcWarcPath(record.warcFilename)) fail('record.warcFilename is invalid');
    if (!Number.isSafeInteger(record.offset) || record.offset < 0) fail('record.offset is invalid');
    if (!Number.isSafeInteger(record.length) || record.length < 1) fail('record.length is invalid');
    totalBytes += record.length;
  }
  const maxRecordBytes = Math.min(
    Math.max(1, Math.floor(payload.maxRecordBytes ?? MAX_CC_EXTRACT_RECORD_BYTES)),
    MAX_CC_EXTRACT_RECORD_BYTES,
  );
  if (totalBytes > MAX_CC_EXTRACT_TOTAL_BYTES) fail('records exceed the total byte cap');
  const timeoutMs = Math.min(
    Math.max(1000, Math.floor(payload.timeoutMs ?? DEFAULT_CC_EXTRACT_TIMEOUT_MS)),
    MAX_CC_EXTRACT_TIMEOUT_MS,
  );
  return { records, maxRecordBytes, timeoutMs };
}

export async function handleCcExtract(
  payload: CcExtractPayload,
  allowedOrigins: readonly string[] = [],
): Promise<CcExtractResult> {
  const startedAt = performance.now();
  const { records, maxRecordBytes, timeoutMs } = validatePayload(payload);
  const deadline = startedAt + timeoutMs;
  const documents: CcExtractDocument[] = [];

  for (const record of records) {
    const base: CcExtractDocument = {
      url: record.url,
      title: '',
      text: '',
      excerpt: '',
      contentType: '',
      httpStatus: 0,
      warcFilename: record.warcFilename,
      offset: record.offset,
      length: record.length,
      truncated: false,
    };

    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      documents.push({ ...base, error: 'task timeout' });
      continue;
    }

    try {
      const compressed = await fetchWarcRecord(
        record,
        maxRecordBytes,
        Math.min(CC_RECORD_TIMEOUT_MS, remaining),
        allowedOrigins,
      );
      const warc = await parseWarcResponse(record, await decompress('gzip', compressed, MAX_CC_WARC_DECOMPRESSED_BYTES));
      if (warc.status !== 200) {
        documents.push({ ...base, httpStatus: warc.status, contentType: warc.contentType, error: `HTTP ${warc.status}` });
        continue;
      }
      if (!['text/html', 'application/xhtml+xml', 'text/plain'].includes(warc.contentType)) {
        documents.push({
          ...base,
          httpStatus: warc.status,
          contentType: warc.contentType,
          error: `unsupported content type: ${warc.contentType || 'missing'}`,
        });
        continue;
      }

      const html = decodeBytes(warc.body, warc.charset);
      const extracted = extractDocument(html, record.url);
      documents.push({
        ...base,
        finalUrl: warc.targetUri,
        canonicalUrl: extracted.canonicalUrl,
        title: extracted.title,
        text: extracted.text,
        excerpt: extracted.excerpt,
        lang: extracted.lang,
        publishedAt: extracted.publishedAt,
        contentType: warc.contentType,
        httpStatus: warc.status,
        truncated: warc.truncated || extracted.truncated,
      });
    } catch (error) {
      documents.push({
        ...base,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { documents, durationMs: Math.round(performance.now() - startedAt) };
}
