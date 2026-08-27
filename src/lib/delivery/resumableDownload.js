/**
 * Resumable Download Client
 *
 * Streams a protected delivery URL and, if the connection drops mid-stream
 * (e.g. a mobile-network interruption), resumes from the last received byte
 * using an RFC 7233 Range request instead of restarting the whole download.
 *
 * Fails safe: if the server does not honor the resume (no 206 / mismatched
 * Content-Range), the accumulated bytes are discarded and an error is
 * surfaced rather than silently producing a corrupt file.
 */

const DEFAULT_MAX_RETRIES = 4;
const DEFAULT_RETRY_DELAY_MS = 1000;

function defaultDelay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Download `url`, resuming on transient stream failures.
 *
 * @param {string} url
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl] - Injectable fetch for testing.
 * @param {number} [options.maxRetries] - Max resume attempts after the initial request.
 * @param {number} [options.retryDelayMs] - Base delay between resume attempts.
 * @param {(delayMs: number, attempt: number) => Promise<void>} [options.delay] - Injectable delay for testing.
 * @param {(progress: {loadedBytes: number, totalBytes: number|null}) => void} [options.onProgress]
 * @param {string} [options.fallbackContentType] - Used when the response has no Content-Type.
 * @returns {Promise<{blob: Blob, contentType: string|null}>}
 */
export async function downloadWithResume(
  url,
  {
    fetchImpl = typeof fetch !== 'undefined' ? fetch : undefined,
    maxRetries = DEFAULT_MAX_RETRIES,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    delay = defaultDelay,
    onProgress,
    fallbackContentType = 'application/octet-stream',
  } = {}
) {
  if (!fetchImpl) throw new Error('fetch is not available in this environment');

  const chunks = [];
  let loadedBytes = 0;
  let totalBytes = null;
  let contentType = null;
  let attempt = 0;

  for (;;) {
    const isResume = loadedBytes > 0;
    const headers = isResume ? { Range: `bytes=${loadedBytes}-` } : {};

    const response = await fetchImpl(url, { headers });

    if (isResume) {
      // A resume must be honored as partial content continuing exactly
      // where the previous attempt stopped. Anything else risks silently
      // corrupting the file, so treat it as a fatal, non-retryable failure.
      if (response.status !== 206) {
        throw new Error('Server did not resume the download; please retry.');
      }
      const contentRange = response.headers.get('Content-Range') || '';
      const match = contentRange.match(/^bytes (\d+)-/);
      if (!match || Number(match[1]) !== loadedBytes) {
        throw new Error('Download resume position mismatch; please retry.');
      }
    } else {
      if (!response.ok) {
        if (response.status === 410) throw new Error('Download token expired. Please try again.');
        throw new Error('Failed to connect to delivery service');
      }
      contentType = response.headers.get('Content-Type') || contentType;
      const contentLength = response.headers.get('Content-Length');
      totalBytes = contentLength ? parseInt(contentLength, 10) : null;
    }

    if (!response.body) throw new Error('ReadableStream not supported by the browser');

    try {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return finalize();
        chunks.push(value);
        loadedBytes += value.length;
        onProgress?.({ loadedBytes, totalBytes });
      }
    } catch (err) {
      if (attempt >= maxRetries) throw err;
      attempt += 1;
      await delay(retryDelayMs * attempt, attempt);
      // loop again: next iteration resumes from loadedBytes
    }
  }

  function finalize() {
    return { blob: new Blob(chunks, { type: contentType || fallbackContentType }), contentType };
  }
}
