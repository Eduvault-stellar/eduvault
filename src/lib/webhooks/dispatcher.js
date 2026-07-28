import https from 'node:https';
import dns from 'node:dns/promises';
import { URL } from 'node:url';
import net from 'node:net';
import { createCircuitBreaker, CircuitState, DependencyError } from "@/lib/resilience/index.js";
import { setGauge, incrementCounter } from "@/lib/telemetry/metrics";
import { currentTraceparent } from "@/lib/telemetry/context";

const webhookCircuitBreaker = createCircuitBreaker("webhook", {
  failureThreshold: Number(process.env.WEBHOOK_CB_FAILURE_THRESHOLD || 5),
  successThreshold: 2,
  resetTimeoutMs: Number(process.env.WEBHOOK_CB_RESET_TIMEOUT_MS || 30000),
  onStateChange(name, from, to) {
    setGauge("circuit_breaker_state", { dependency: name, state: to }, 1);
    if (from && from !== to) {
      setGauge("circuit_breaker_state", { dependency: name, state: from }, 0);
    }
    if (to === CircuitState.OPEN) {
      incrementCounter("circuit_breaker_open_total", { dependency: name });
    }
    const level = to === CircuitState.OPEN ? "warn" : "info";
    console[level](`[circuit-breaker] webhook: ${from} -> ${to}`);
  },
});

export function getWebhookCircuitBreakerState() {
  return webhookCircuitBreaker.getState();
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
  if (webhookCircuitBreaker.getState() === CircuitState.OPEN) {
    incrementCounter("rpc_errors_total", { operation: "webhook.dispatch" });
    throw new DependencyError({
      dependency: "webhook",
      action: "dispatch",
      retryable: false,
      statusCode: 503,
      userMessage: "Webhook delivery service is temporarily unavailable.",
    });
  }
  return webhookCircuitBreaker.call(async () => _dispatchWebhook(url, payloadStr, signatureHeader));
}

async function _dispatchWebhook(url, payloadStr, signatureHeader) {
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

    const traceparent = currentTraceparent();
    if (traceparent) {
      requestOptions.headers['traceparent'] = traceparent;
    }

    const response = await new Promise((resolve, reject) => {
      const req = https.request(requestOptions, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          resolve({ redirect: res.headers.location });
          return;
        }

        let totalSize = 0;
        const maxSize = 1024 * 1024; // 1MB limit
        let responseBody = '';

        res.on('data', (chunk) => {
          totalSize += chunk.length;
          if (totalSize > maxSize) {
            req.destroy(new Error('Response size limit exceeded'));
            return;
          }
          responseBody += chunk.toString('utf8');
        });

        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: responseBody
          });
        });
      });

      req.on('error', (e) => reject(e));
      req.on('timeout', () => req.destroy(new Error('Request timeout')));

      req.write(payloadStr);
      req.end();
    });

    if (response.redirect) {
      redirects++;
      currentUrl = new URL(response.redirect, currentUrl).toString();
      continue;
    }

    return response;
  }

  throw new Error('Too many redirects');
}
