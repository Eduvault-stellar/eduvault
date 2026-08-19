import https from 'node:https';
import dns from 'node:dns/promises';
import { URL } from 'node:url';
import net from 'node:net';
import crypto from 'node:crypto';

import { redactHeaders, redactText } from '../telemetry/redact.js';

/**
 * Response handling limits (#173).
 *
 * A subscriber endpoint is untrusted: its response may contain cookies,
 * tokens, stack traces or PII, and it may be arbitrarily large. We therefore
 * read a bounded prefix, keep a bounded and redacted preview of it, and
 * persist a digest of the received bytes instead of the bytes themselves.
 */
export const RESPONSE_LIMITS = Object.freeze({
  // Bytes read from the socket before we stop reading and drain the response.
  maxReadBytes: 64 * 1024,
  // Bytes of the body retained in memory for the preview.
  captureBytes: 8 * 1024,
  // Characters of the redacted preview that are persisted.
  previewChars: 1024,
});

/**
 * Content types whose bodies may be previewed. Anything else (HTML error
 * pages, binary payloads, `text/event-stream`, ...) is digested only: those
 * bodies are the ones most likely to embed session markup or PII, and they
 * have no debugging value for a webhook delivery.
 */
export const PREVIEWABLE_CONTENT_TYPES = Object.freeze([
  'application/json',
  'application/problem+json',
  'text/plain',
]);

function parseContentType(headerValue) {
  if (!headerValue) return '';
  return String(headerValue).split(';')[0].trim().toLowerCase();
}

export function isPreviewableContentType(contentType) {
  const type = parseContentType(contentType);
  if (!type) return false;
  if (PREVIEWABLE_CONTENT_TYPES.includes(type)) return true;
  // Vendor JSON media types, e.g. application/vnd.acme.v1+json.
  return type.startsWith('application/') && type.endsWith('+json');
}

/**
 * Build the persistence-safe view of a subscriber response.
 *
 * The raw body never leaves this function: callers get an allowlisted header
 * map, a redacted and bounded preview and a digest that still allows two
 * responses to be compared without retaining their content.
 *
 * @param {{ status?: number, headers?: object, bodyBuffer?: Buffer, bodyBytes?: number, truncated?: boolean }} response
 * @returns {{ responseStatus: number|null, responseHeaders: Record<string,string>, responseBody: string, responseBodyDigest: string|null, responseBodyBytes: number, responseBodyTruncated: boolean, responseBodyOmittedReason?: string }}
 */
export function sanitizeWebhookResponse(response = {}) {
  const headers = response.headers || {};
  const bodyBuffer = Buffer.isBuffer(response.bodyBuffer)
    ? response.bodyBuffer
    : Buffer.from(response.bodyBuffer ? String(response.bodyBuffer) : '', 'utf8');

  const bodyBytes = Number.isFinite(response.bodyBytes) ? response.bodyBytes : bodyBuffer.length;
  const truncated = Boolean(response.truncated) || bodyBuffer.length < bodyBytes;

  const safe = {
    responseStatus: Number.isFinite(response.status) ? response.status : null,
    responseHeaders: redactHeaders(headers),
    responseBody: '',
    responseBodyDigest: bodyBytes > 0
      ? `sha256:${crypto.createHash('sha256').update(bodyBuffer).digest('hex')}`
      : null,
    responseBodyBytes: bodyBytes,
    responseBodyTruncated: truncated,
  };

  if (bodyBytes === 0) {
    safe.responseBodyOmittedReason = 'empty_body';
    return safe;
  }

  // Read the content type back from the normalised header map so casing
  // from the remote endpoint does not matter.
  if (!isPreviewableContentType(safe.responseHeaders['content-type'])) {
    safe.responseBodyOmittedReason = 'content_type_not_allowlisted';
    return safe;
  }

  safe.responseBody = redactText(bodyBuffer.toString('utf8'), {
    maxLength: RESPONSE_LIMITS.previewChars,
  });
  return safe;
}

/**
 * Normalise an attempt record read back from storage.
 *
 * Deliveries written before #173 contain a raw `responseBody` and no digest,
 * so anything served from history is redacted and bounded on read as well.
 *
 * @param {object} attempt
 * @returns {object}
 */
export function sanitizeStoredAttempt(attempt) {
  if (!attempt || typeof attempt !== 'object') return attempt;

  const safe = { ...attempt };
  if (typeof safe.responseBody === 'string' && safe.responseBody.length > 0) {
    safe.responseBody = redactText(safe.responseBody, { maxLength: RESPONSE_LIMITS.previewChars });
  }
  if (safe.responseHeaders) {
    safe.responseHeaders = redactHeaders(safe.responseHeaders);
  }
  if (typeof safe.error === 'string') {
    safe.error = redactText(safe.error, { maxLength: RESPONSE_LIMITS.previewChars });
  }
  return safe;
}

export function isPrivateIP(ip) {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    // 10.0.0.0/8
    if (parts[0] === 10) return true;
    // 172.16.0.0/12
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    // 192.168.0.0/16
    if (parts[0] === 192 && parts[1] === 168) return true;
    // 127.0.0.0/8 (loopback)
    if (parts[0] === 127) return true;
    // 169.254.0.0/16 (link-local)
    if (parts[0] === 169 && parts[1] === 254) return true;
    // 0.0.0.0/8 (current network)
    if (parts[0] === 0) return true;
    // 100.64.0.0/10 (CGNAT)
    if (parts[0] === 100 && (parts[1] >= 64 && parts[1] <= 127)) return true;
    // 192.0.0.0/24 (IETF Protocol Assignments)
    if (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) return true;
    // 198.18.0.0/15 (Benchmarking)
    if (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)) return true;
    // 255.255.255.255/32 (Broadcast)
    if (parts[0] === 255 && parts[1] === 255 && parts[2] === 255 && parts[3] === 255) return true;
    return false;
  } else if (net.isIPv6(ip)) {
    const ipLower = ip.toLowerCase();
    // ::1/128 loopback
    if (ipLower === '::1') return true;
    // fc00::/7 Unique local address
    if (ipLower.startsWith('fc') || ipLower.startsWith('fd')) return true;
    // fe80::/10 Link-local
    if (ipLower.startsWith('fe8') || ipLower.startsWith('fe9') || ipLower.startsWith('fea') || ipLower.startsWith('feb')) return true;
    // IPv4-mapped IPv6 ::ffff:0:0/96
    if (ipLower.startsWith('::ffff:')) {
      const v4 = ipLower.substring(7);
      if (v4.includes('.')) {
        return isPrivateIP(v4);
      }
    }
    // Disallow unspecified
    if (ipLower === '::' || ipLower === '0:0:0:0:0:0:0:0' || ipLower === '::0') return true;
    return false;
  }
  return true; // Unknown format, block to be safe
}

export async function dispatchWebhook(url, payloadStr, signatureHeader) {
  let currentUrl = url;
  let redirects = 0;
  const maxRedirects = 3;

  while (redirects <= maxRedirects) {
    let parsedUrl;
    try {
      parsedUrl = new URL(currentUrl);
    } catch (e) {
      throw new Error(`Invalid URL: ${currentUrl}`);
    }

    if (parsedUrl.protocol !== 'https:') {
      throw new Error('Only HTTPS is allowed');
    }
    if (parsedUrl.username || parsedUrl.password) {
      throw new Error('URL credentials are not allowed');
    }

    const port = parsedUrl.port ? parseInt(parsedUrl.port, 10) : 443;
    if (port !== 443 && port !== 8443) {
      throw new Error('Unsafe port');
    }

    // Resolve DNS
    let lookupRes;
    try {
      lookupRes = await dns.lookup(parsedUrl.hostname);
    } catch (e) {
      throw new Error(`DNS resolution failed for ${parsedUrl.hostname}`);
    }
    const ip = lookupRes.address;

    if (process.env.NODE_ENV !== 'test' && !process.env.ALLOW_LOCAL_WEBHOOKS) {
      if (isPrivateIP(ip)) {
        throw new Error(`SSRF Prevention: Cannot connect to private/reserved IP: ${ip}`);
      }
    }

    const requestOptions = {
      method: 'POST',
      host: ip, // DNS Rebinding protection: connect directly to resolved IP
      port: port,
      path: parsedUrl.pathname + parsedUrl.search,
      headers: {
        'Host': parsedUrl.hostname, // Original hostname for virtual hosting
        'Content-Type': 'application/json',
        'User-Agent': 'EduVault-Webhook-Sender/1.0',
        'Content-Length': Buffer.byteLength(payloadStr),
      },
      servername: parsedUrl.hostname, // TLS SNI
      timeout: 5000,
    };

    if (signatureHeader) {
      requestOptions.headers['Eduvault-Signature'] = signatureHeader;
    }

    const response = await new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        fn(value);
      };

      const req = https.request(requestOptions, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // The redirect target is consumed in-process only; it is never
          // surfaced to callers or persisted, since it can carry credentials.
          res.resume();
          settle(resolve, { redirect: res.headers.location });
          return;
        }

        let totalBytes = 0;
        let captured = 0;
        let truncated = false;
        const chunks = [];

        const finish = () => {
          const bodyBuffer = Buffer.concat(chunks, captured);
          settle(resolve, {
            status: res.statusCode,
            headers: res.headers,
            bodyBuffer,
            bodyBytes: totalBytes,
            truncated,
          });
        };

        res.on('data', (chunk) => {
          totalBytes += chunk.length;

          if (captured < RESPONSE_LIMITS.captureBytes) {
            const room = RESPONSE_LIMITS.captureBytes - captured;
            const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
            chunks.push(slice);
            captured += slice.length;
            if (slice.length < chunk.length) truncated = true;
          } else {
            truncated = true;
          }

          if (totalBytes > RESPONSE_LIMITS.maxReadBytes) {
            // An oversized response is not a delivery failure: the status code
            // already decided the outcome. Stop reading, keep what we have and
            // release the socket.
            truncated = true;
            finish();
            res.destroy();
            req.destroy();
          }
        });

        res.on('end', finish);
        res.on('error', (e) => settle(reject, e));
      });

      req.on('error', (e) => settle(reject, e));
      req.on('timeout', () => req.destroy(new Error('Request timeout')));

      req.write(payloadStr);
      req.end();
    });

    if (response.redirect) {
      redirects++;
      currentUrl = new URL(response.redirect, currentUrl).toString();
      continue;
    }

    // Only the sanitized view leaves the dispatcher: no raw body, no raw
    // headers, so no caller can persist or log subscriber secrets by accident.
    return {
      status: response.status,
      ...sanitizeWebhookResponse(response),
    };
  }

  throw new Error('Too many redirects');
}

/**
 * Redact an outbound dispatch error before it is persisted or logged.
 * Dispatch errors embed hostnames, resolved IPs and upstream text.
 *
 * @param {unknown} error
 * @returns {string}
 */
export function sanitizeDispatchError(error) {
  const message = error instanceof Error ? error.message : String(error ?? 'Unknown error');
  return redactText(message, { maxLength: 512 }) || 'Unknown error';
}
