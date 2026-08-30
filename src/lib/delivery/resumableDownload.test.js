/**
 * Unit tests for src/lib/delivery/resumableDownload.js — Issue #144
 *
 * Verifies that a mid-stream failure (e.g. a mobile-network interruption)
 * resumes from the last received byte via a Range request instead of
 * restarting the whole download, and that resumption fails safely when the
 * server cannot honor it.
 *
 * Run with: npm test (vitest)
 */
import { describe, it, expect, vi } from 'vitest';

import { downloadWithResume } from './resumableDownload.js';

function streamOf(chunks, { failAfter = null } = {}) {
  let i = 0;
  return {
    getReader() {
      return {
        async read() {
          if (failAfter !== null && i === failAfter) {
            throw new Error('network_error');
          }
          if (i >= chunks.length) return { done: true, value: undefined };
          const value = chunks[i];
          i += 1;
          return { done: false, value };
        },
      };
    },
  };
}

function headersOf(map) {
  return { get: (name) => map[name.toLowerCase()] ?? map[name] ?? null };
}

describe('downloadWithResume (#144)', () => {
  it('downloads a file in one pass when the stream never fails', async () => {
    const chunkA = new Uint8Array([1, 2, 3]);
    const chunkB = new Uint8Array([4, 5]);
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: headersOf({ 'content-length': '5', 'content-type': 'application/pdf' }),
      body: streamOf([chunkA, chunkB]),
    });

    const { blob } = await downloadWithResume('https://example.test/stream', { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(blob.size).toBe(5);
    expect(blob.type).toBe('application/pdf');
  });

  it('resumes with a Range request from the last received byte after a mid-stream failure', async () => {
    const first = new Uint8Array([1, 2, 3]);
    const rest = new Uint8Array([4, 5]);

    const fetchImpl = vi
      .fn()
      // Initial request: fails after delivering the first chunk.
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: headersOf({ 'content-length': '5', 'content-type': 'application/pdf' }),
        body: streamOf([first], { failAfter: 1 }),
      })
      // Resume request: server must see Range: bytes=3- and respond 206.
      .mockResolvedValueOnce({
        ok: true,
        status: 206,
        headers: headersOf({ 'content-range': 'bytes 3-4/5' }),
        body: streamOf([rest]),
      });

    const { blob } = await downloadWithResume('https://example.test/stream', {
      fetchImpl,
      delay: async () => {}, // no real backoff wait in tests
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1][1].headers.Range).toBe('bytes=3-');
    expect(blob.size).toBe(5);
  });

  it('gives up after exceeding the retry budget instead of retrying forever', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: headersOf({}),
      body: streamOf([new Uint8Array([1])], { failAfter: 0 }),
    });

    await expect(
      downloadWithResume('https://example.test/stream', {
        fetchImpl,
        maxRetries: 2,
        delay: async () => {},
      })
    ).rejects.toThrow('network_error');

    // Initial attempt + 2 retries = 3 calls.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('fails safely instead of corrupting the file when the server cannot resume', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: headersOf({ 'content-length': '5' }),
        body: streamOf([new Uint8Array([1, 2])], { failAfter: 1 }),
      })
      // Server ignores the Range header and restarts from the top (200, not 206).
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: headersOf({}),
        body: streamOf([new Uint8Array([1, 2, 3, 4, 5])]),
      });

    await expect(
      downloadWithResume('https://example.test/stream', { fetchImpl, delay: async () => {} })
    ).rejects.toThrow('Server did not resume the download');
  });

  it('fails safely when the resumed range does not start where the client left off', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: headersOf({ 'content-length': '5' }),
        body: streamOf([new Uint8Array([1, 2])], { failAfter: 1 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 206,
        headers: headersOf({ 'content-range': 'bytes 0-4/5' }), // stale/mismatched
        body: streamOf([new Uint8Array([1, 2, 3, 4, 5])]),
      });

    await expect(
      downloadWithResume('https://example.test/stream', { fetchImpl, delay: async () => {} })
    ).rejects.toThrow('resume position mismatch');
  });

  it('surfaces a clear error when the delivery token has expired', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 410,
      headers: headersOf({}),
      body: null,
    });

    await expect(downloadWithResume('https://example.test/stream', { fetchImpl })).rejects.toThrow(
      'Download token expired'
    );
  });
});
