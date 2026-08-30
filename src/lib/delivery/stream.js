/**
 * Authenticated Streaming Proxy Service
 *
 * Proxies protected file bytes from IPFS (via Pinata gateway) through the
 * EduVault server without exposing the permanent CID or origin URL to the
 * client. Supports:
 *   - Streaming with backpressure and cancellation
 *   - RFC 7233 range requests (partial content / resume)
 *   - Content-Length, Content-Type, Content-Disposition headers
 *   - Upstream timeout handling (no corrupt partial responses)
 *   - Cross-user cache isolation via Cache-Control headers
 *   - Client disconnect detection
 */

import { getDb } from '@/lib/mongodb';
import { IPFS_GATEWAY_URL } from '@/lib/config/chain';
import { normalizeDownloadFilename, normalizeExternalUrl } from '@/lib/security/input';
import { verifyDeliveryIntegrity } from '@/lib/provenance/verify';

const DEFAULT_UPSTREAM_TIMEOUT_MS = 30_000; // 30s upstream timeout
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024 * 1024; // 5GB hard limit

/**
 * Fetch material metadata from the database.
 *
 * @param {string} materialId
 * @returns {Promise<object|null>} Material document with ipfsCid, fileName, contentType, fileSize
 */
export async function getMaterialRecord(materialId) {
  if (!materialId) return null;

  const db = await getDb();
  const material = await db.collection('materials').findOne(
    { materialId },
    {
      projection: {
        ipfsCid: 1,
        cid: 1,
        fileHash: 1,
        storageKey: 1,
        fileUrl: 1,
        fileName: 1,
        title: 1,
        contentType: 1,
        fileSize: 1,
        _id: 0,
      },
    }
  );

  if (!material) return null;

  const cid =
    material.ipfsCid ??
    material.cid ??
    material.fileHash ??
    material.storageKey ??
    material.fileUrl ??
    '';

  if (!cid) return null;

  return {
    cid,
    fileName: normalizeDownloadFilename(material.fileName || material.title || materialId),
    contentType: material.contentType || 'application/octet-stream',
    fileSize: material.fileSize || 0,
  };
}

/**
 * Resolve a protected deliverable and verify its provenance integrity.
 *
 * Ties the (mutable) CID mapping on the material record to the purchased
 * version manifest — the manifest digest must be intact and the CID to be
 * served must match the manifest's file CID. The streaming route runs this
 * BEFORE any protected bytes are served (Issue #168); a mismatch is a hard
 * denial, never a warning.
 *
 * @param {object} params
 * @param {string} params.materialId
 * @param {string} params.buyerAddress - The buyer's wallet address (from the delivery token)
 * @returns {Promise<{material: object, version: number, manifestCid: string}|{error: {statusCode: number, reason: string, detail: string}}>}
 */
export async function resolveVerifiedDeliverable({ materialId, buyerAddress }) {
  const material = await getMaterialRecord(materialId);
  if (!material || !material.cid) {
    return {
      error: { statusCode: 404, reason: 'material_not_found', detail: 'Material not found' },
    };
  }

  const integrity = await verifyDeliveryIntegrity({
    materialId,
    buyerAddress,
    requestedCid: material.cid,
  });

  if (!integrity.valid) {
    return {
      error: {
        statusCode: integrity.statusCode,
        reason: integrity.reason,
        detail: integrity.detail,
      },
    };
  }

  return {
    material,
    version: integrity.version,
    manifestCid: integrity.manifestCid,
  };
}

/**
 * Build the upstream IPFS gateway URL for a given CID.
 * Uses the private gateway if PRIVATE_IPFS_GATEWAY_URL is configured.
 *
 * @param {string} cid
 * @returns {string}
 */
export function buildUpstreamUrl(cid) {
  const gateway = process.env.PRIVATE_IPFS_GATEWAY_URL || IPFS_GATEWAY_URL;
  const allowedHost = new URL(gateway).hostname;
  if (cid.startsWith('http')) {
    return normalizeExternalUrl(cid, { allowedHosts: [allowedHost] });
  }
  if (!/^[a-zA-Z0-9]+$/.test(cid || '')) throw new Error('Invalid IPFS content identifier');
  return `${gateway.replace(/\/$/, '')}/ipfs/${cid}`;
}

/**
 * Parse an RFC 7233 Range header into { start, end }.
 * Returns null if the header is absent or malformed.
 *
 * @param {string|null} rangeHeader
 * @returns {{start: number, end: number}|null}
 */
export function parseRangeHeader(rangeHeader) {
  if (!rangeHeader || typeof rangeHeader !== 'string') return null;

  const match = rangeHeader.match(/^bytes=(\d+)-(\d*)$/);
  if (!match) return null;

  const start = parseInt(match[1], 10);
  const end = match[2] !== '' ? parseInt(match[2], 10) : Infinity;

  if (isNaN(start) || start < 0) return null;
  if (end !== Infinity && (isNaN(end) || end < start)) return null;

  return { start, end };
}

/**
 * Create a ReadableStream that fetches from the upstream IPFS gateway
 * and pipes data through with backpressure, timeout, and cancellation support.
 *
 * @param {object} params
 * @param {string} params.cid - The IPFS content identifier
 * @param {number} [params.fileSize] - Total file size in bytes (for range headers)
 * @param {{start: number, end: number}|null} [params.range] - Optional byte range
 * @param {AbortSignal} [params.signal] - Optional abort signal for cancellation
 * @returns {ReadableStream} A readable stream of the file content
 */
export function createUpstreamStream({ cid, fileSize = 0, range = null, signal = null }) {
  const upstreamUrl = buildUpstreamUrl(cid);
  const upstreamTimeout = parseInt(
    process.env.UPSTREAM_FETCH_TIMEOUT_MS || String(DEFAULT_UPSTREAM_TIMEOUT_MS),
    10
  );

  return new ReadableStream({
    async start(controller) {
      // Build upstream fetch headers
      const upstreamHeaders = {
        Accept: '*/*',
      };

      if (range) {
        upstreamHeaders.Range = `bytes=${range.start}-${range.end === Infinity ? '' : range.end}`;
      }

      // Create an AbortController for upstream timeout
      const abortController = new AbortController();
      const timeoutId = setTimeout(
        () => abortController.abort(new Error('upstream_timeout')),
        upstreamTimeout
      );

      // Combine with client abort signal if provided
      const combinedSignal = signal
        ? combineAbortSignals(abortController.signal, signal)
        : abortController.signal;

      try {
        const upstreamResponse = await fetch(upstreamUrl, {
          headers: upstreamHeaders,
          signal: combinedSignal,
        });

        clearTimeout(timeoutId);

        if (!upstreamResponse.ok && upstreamResponse.status !== 206) {
          controller.error(
            new Error(`Upstream returned status ${upstreamResponse.status}`)
          );
          return;
        }

        if (!upstreamResponse.body) {
          controller.error(new Error('Upstream response has no body'));
          return;
        }

        const reader = upstreamResponse.body.getReader();

        try {
          while (true) {
            // Check for client disconnect
            if (signal?.aborted) {
              await reader.cancel();
              controller.error(new Error('client_disconnected'));
              return;
            }

            const { done, value } = await reader.read();

            if (done) {
              controller.close();
              return;
            }

            // Enqueue with backpressure awareness
            controller.enqueue(value);
          }
        } catch (err) {
          controller.error(err);
        } finally {
          reader.releaseLock();
        }
      } catch (err) {
        clearTimeout(timeoutId);
        if (err.name === 'AbortError') {
          const isTimeout = err.message === 'upstream_timeout';
          controller.error(
            new Error(isTimeout ? 'upstream_timeout' : 'request_cancelled')
          );
        } else {
          controller.error(err);
        }
      }
    },

    cancel(reason) {
      // Upstream fetch will be aborted via the signal
    },
  });
}

/**
 * Combine two AbortSignals into one.
 */
function combineAbortSignals(signal1, signal2) {
  const controller = new AbortController();

  const onAbort1 = () => {
    controller.abort(signal1.reason);
  };
  const onAbort2 = () => {
    controller.abort(signal2.reason);
  };

  signal1.addEventListener('abort', onAbort1, { once: true });
  signal2.addEventListener('abort', onAbort2, { once: true });

  controller.signal.addEventListener(
    'abort',
    () => {
      signal1.removeEventListener('abort', onAbort1);
      signal2.removeEventListener('abort', onAbort2);
    },
    { once: true }
  );

  return controller.signal;
}

/**
 * Resolve the status code and byte-range headers for a delivery response.
 *
 * Fails safe when a resume request cannot be honored:
 *   - A range starting at or past a known file size is rejected with 416
 *     (Range Not Satisfiable) instead of emitting a negative/corrupt
 *     Content-Length.
 *   - An open-ended range (`bytes=N-`) against an unknown file size cannot
 *     be turned into a valid Content-Length, so the range is ignored and
 *     the full file is served (200) rather than corrupting the download.
 *
 * @param {object} params
 * @param {{start: number, end: number}|null} params.range
 * @param {number} [params.fileSize]
 * @returns {
 *   | { ok: true, statusCode: 200 }
 *   | { ok: true, statusCode: 206, contentStart: number, contentEnd: number, contentLength: number, contentRangeTotal: string }
 *   | { ok: false, statusCode: 416, contentRange: string }
 * }
 */
export function resolveRangeResponse({ range, fileSize = 0 }) {
  if (!range) return { ok: true, statusCode: 200 };

  if (fileSize > 0 && range.start >= fileSize) {
    return { ok: false, statusCode: 416, contentRange: `bytes */${fileSize}` };
  }

  if (fileSize <= 0 && range.end === Infinity) {
    // Total size is unknown and the range has no explicit end: there is no
    // safe way to compute a Content-Length, so fall back to a full response.
    return { ok: true, statusCode: 200 };
  }

  const contentStart = range.start;
  const contentEnd =
    range.end !== Infinity ? (fileSize > 0 ? Math.min(range.end, fileSize - 1) : range.end) : fileSize - 1;
  const contentLength = contentEnd - contentStart + 1;

  return {
    ok: true,
    statusCode: 206,
    contentStart,
    contentEnd,
    contentLength,
    contentRangeTotal: fileSize > 0 ? String(fileSize) : '*',
  };
}

/**
 * Validate that a file size is within acceptable limits.
 */
export function validateFileSize(fileSize) {
  if (!fileSize || fileSize <= 0) return { valid: true };
  if (fileSize > MAX_FILE_SIZE_BYTES) {
    return {
      valid: false,
      reason: `File exceeds maximum size of ${MAX_FILE_SIZE_BYTES / (1024 * 1024 * 1024)}GB`,
    };
  }
  return { valid: true };
}
