/// <reference types="@cloudflare/vitest-pool-workers" />
/**
 * `POST /crowd/tasks` boundary validation for `cc-extract`.
 *
 * The node re-validates the same limits, but a malformed record must never get
 * as far as occupying a volunteer slot. These tests pin the API-side contract.
 */

import { describe, it, expect } from 'vitest';
import { validateCcExtractPayload } from '../index';

const WARC_PATH =
  'crawl-data/CC-MAIN-2026-43/segments/1700000000000.0/warc/CC-MAIN-20260101000000-20260101010000-00000.warc.gz';

function payload(overrides: Record<string, unknown> = {}) {
  return {
    crawl: 'CC-MAIN-2026-43',
    records: [{ url: 'https://example.com/article', warcFilename: WARC_PATH, offset: 0, length: 1000 }],
    ...overrides,
  };
}

describe('validateCcExtractPayload', () => {
  it('accepts a well-formed payload', () => {
    expect(validateCcExtractPayload(payload())).toBeNull();
  });

  it('rejects a non-object payload', () => {
    expect(validateCcExtractPayload('nope')).toBeTruthy();
    expect(validateCcExtractPayload([])).toBeTruthy();
  });

  it('requires a valid crawl id', () => {
    expect(validateCcExtractPayload(payload({ crawl: 'not-a-crawl' }))).toMatch(/crawl/i);
  });

  it('requires 1..3 records', () => {
    expect(validateCcExtractPayload(payload({ records: [] }))).toMatch(/records/i);
    const four = new Array(4).fill({
      url: 'https://example.com/article',
      warcFilename: WARC_PATH,
      offset: 0,
      length: 10,
    });
    expect(validateCcExtractPayload(payload({ records: four }))).toMatch(/records/i);
  });

  it('rejects a non-http(s) or invalid URL', () => {
    expect(
      validateCcExtractPayload(
        payload({ records: [{ url: 'file:///etc/passwd', warcFilename: WARC_PATH, offset: 0, length: 10 }] }),
      ),
    ).toMatch(/url/i);
    expect(
      validateCcExtractPayload(
        payload({ records: [{ url: 'not a url', warcFilename: WARC_PATH, offset: 0, length: 10 }] }),
      ),
    ).toMatch(/url/i);
  });

  it('rejects a WARC path outside the Common Crawl layout', () => {
    expect(
      validateCcExtractPayload(
        payload({
          records: [{ url: 'https://example.com/', warcFilename: 'https://evil.example/x.warc.gz', offset: 0, length: 10 }],
        }),
      ),
    ).toMatch(/warcFilename/i);
  });

  it('rejects dot segments and a WARC path from another crawl', () => {
    const record = (warcFilename: string) =>
      payload({
        records: [{ url: 'https://example.com/', warcFilename, offset: 0, length: 10 }],
      });
    expect(
      validateCcExtractPayload(
        record('crawl-data/CC-MAIN-2026-43/segments/../warc/x.warc.gz'),
      ),
    ).toMatch(/warcFilename/i);
    expect(
      validateCcExtractPayload(
        record('crawl-data/CC-MAIN-2026-39/segments/1700000000000.0/warc/x.warc.gz'),
      ),
    ).toMatch(/warcFilename/i);
  });

  it('rejects a range URL with embedded credentials', () => {
    const withFetchUrl = (fetchUrl: string) =>
      payload({
        records: [
          { url: 'https://example.com/', warcFilename: WARC_PATH, offset: 0, length: 10, fetchUrl },
        ],
      });
    expect(validateCcExtractPayload(withFetchUrl('https://user:pass@flaxia.app/cc-range'))).toMatch(
      /credentials/i,
    );
  });

  it('rejects invalid offsets and lengths', () => {
    const record = (offset: unknown, length: unknown) =>
      payload({ records: [{ url: 'https://example.com/', warcFilename: WARC_PATH, offset, length }] });
    expect(validateCcExtractPayload(record(-1, 10))).toMatch(/offset/i);
    expect(validateCcExtractPayload(record(1.5, 10))).toMatch(/offset/i);
    expect(validateCcExtractPayload(record(0, 0))).toMatch(/length/i);
    expect(validateCcExtractPayload(record(0, 3 * 1024 * 1024))).toMatch(/length/i);
  });

  it('rejects a total byte budget above the cap', () => {
    const records = new Array(3).fill({
      url: 'https://example.com/',
      warcFilename: WARC_PATH,
      offset: 0,
      length: 2 * 1024 * 1024,
    });
    expect(validateCcExtractPayload(payload({ records }))).toMatch(/total bytes/i);
  });

  it('bounds maxRecordBytes and timeoutMs', () => {
    expect(validateCcExtractPayload(payload({ maxRecordBytes: 0 }))).toMatch(/maxRecordBytes/i);
    expect(validateCcExtractPayload(payload({ maxRecordBytes: 3 * 1024 * 1024 }))).toMatch(/maxRecordBytes/i);
    expect(validateCcExtractPayload(payload({ timeoutMs: 999 }))).toMatch(/timeoutMs/i);
    expect(validateCcExtractPayload(payload({ timeoutMs: 61_000 }))).toMatch(/timeoutMs/i);
  });

  it('accepts an https range-proxy URL and rejects insecure ones', () => {
    const withFetchUrl = (fetchUrl: unknown) =>
      payload({
        records: [
          {
            url: 'https://example.com/',
            warcFilename: WARC_PATH,
            offset: 0,
            length: 10,
            fetchUrl,
          },
        ],
      });
    expect(validateCcExtractPayload(withFetchUrl('https://flaxia.app/api/crowd/cc-range?x=1'))).toBeNull();
    expect(validateCcExtractPayload(withFetchUrl('http://flaxia.app/api/crowd/cc-range'))).toMatch(/https/i);
    expect(validateCcExtractPayload(withFetchUrl(42))).toMatch(/fetchUrl/i);
    expect(validateCcExtractPayload(withFetchUrl(`https://flaxia.app/${'x'.repeat(5000)}`))).toMatch(/fetchUrl/i);
  });

  it('rejects non-string optional metadata', () => {
    const withRecord = (extra: Record<string, unknown>) =>
      payload({
        records: [{ url: 'https://example.com/', warcFilename: WARC_PATH, offset: 0, length: 10, ...extra }],
      });
    expect(validateCcExtractPayload(withRecord({ languages: 1 }))).toMatch(/languages/i);
    expect(validateCcExtractPayload(withRecord({ contentDigest: {} }))).toMatch(/contentDigest/i);
  });
});
