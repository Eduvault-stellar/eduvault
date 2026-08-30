/**
 * Shared PII redaction rules for EduVault telemetry (#20).
 * Used by logger, tracing, and metrics so redaction is defined once.
 *
 * It is also used to sanitise untrusted third-party payloads (for example
 * webhook subscriber responses, #173) before they are persisted or logged.
 */

export const REDACTED = "[REDACTED]";

const DENY_FIELDS = new Set([
  "email",
  "password",
  "name",
  "phone",
  "address",
  "ip",
  "token",
  "authorization",
  "cookie",
  "secret",
  "privateKey",
  "jwt",
]);

/**
 * Wallet addresses are pseudonymous identifiers needed for debugging,
 * not personally identifiable information, so they are kept — but we
 * still truncate them for log noise reasons in some contexts.
 */
export function redactFields(obj = {}) {
  const safe = {};
  for (const [key, value] of Object.entries(obj || {})) {
    if (DENY_FIELDS.has(key.toLowerCase())) {
      safe[key] = "[REDACTED]";
    } else if (value !== undefined && value !== null) {
      safe[key] = value;
    }
  }
  return safe;
}

export function isDeniedField(key) {
  return DENY_FIELDS.has(String(key).toLowerCase());
}

/**
 * Free-text redaction rules.
 *
 * These run over opaque text we did not produce (subscriber response bodies,
 * upstream error messages), so they are intentionally conservative: every rule
 * matches a shape that is a credential, key material, a stack frame or an
 * email address, and nothing that is merely numeric or id-like. Rules are
 * applied in order, from the most specific shape to the most generic one.
 */
const TEXT_RULES = [
  // PEM encoded private key material.
  {
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replacement: "[REDACTED_PRIVATE_KEY]",
  },
  // Cookie / header style credential assignments ("set-cookie: session=...")
  // and JSON style ("api_key": "...").
  {
    pattern:
      /\b(api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|secret|password|passwd|pwd|authorization|auth[_-]?token|session[_-]?id|sessionid|session|sid|csrf|xsrf|cookie|private[_-]?key|signature)\b(\s*["']?\s*[:=]\s*["']?)((?:(?:Bearer|Basic|Digest|Token)\s+)?[^"'\s,;&}\]]{1,4096})/gi,
    replacement: (_match, key, separator) => `${key}${separator}${REDACTED}`,
  },
  // Authorization scheme values that survived the rule above.
  {
    pattern: /\b(Bearer|Basic|Digest|Token)\s+[A-Za-z0-9._~+/=-]{8,}/g,
    replacement: (_match, scheme) => `${scheme} ${REDACTED}`,
  },
  // JSON Web Tokens anywhere in the text.
  {
    pattern: /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g,
    replacement: "[REDACTED_JWT]",
  },
  // Well-known vendor token shapes.
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: "[REDACTED_TOKEN]" },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, replacement: "[REDACTED_TOKEN]" },
  { pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, replacement: "[REDACTED_TOKEN]" },
  { pattern: /\bsk-[A-Za-z0-9]{16,}\b/g, replacement: "[REDACTED_TOKEN]" },
  // Stellar secret seeds (S + 55 base32 chars). Public keys (G...) are kept.
  { pattern: /\bS[A-Z2-7]{55}\b/g, replacement: "[REDACTED_SECRET_SEED]" },
  // Email addresses are PII.
  {
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replacement: "[REDACTED_EMAIL]",
  },
];

// Stack frames leak internal paths, package layout and sometimes arguments.
const STACK_FRAME_RULES = [
  // V8: "    at fn (/srv/app/file.js:10:5)"; JVM: "\tat com.foo.Bar(Bar.java:1)".
  /^[ \t]*at [^\n]*$/gm,
  // Python: '  File "/srv/app/main.py", line 42, in handler'.
  /^[ \t]*File "[^"]+", line \d+[^\n]*$/gm,
  // Bare absolute paths with line:column on their own line.
  /^[ \t]*(?:\/[^\s:]+|[A-Za-z]:\\[^\s:]+):\d+:\d+[^\n]*$/gm,
];

// C0/C1 control characters except tab, newline and carriage return.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/**
 * Metric label key patterns.
 *
 * Metrics counters are cardinality-bounded, so wallet/transaction/material
 * identifiers must never be used as label keys or label values. Keys that
 * look like an identifier holder, and values that look like an identifier,
 * are dropped from recorded metrics labels.
 */
const DENY_LABEL_KEY_PATTERNS = [
  /wallet/i,
  /address/i,
  /account/i,
  /pubkey/i,
  /publickey/i,
  /buyer/i,
  /seller/i,
  /payer/i,
  /recipient/i,
  /issuer/i,
  /owner/i,
  /\btx\b/i,
  /transaction/i,
  /txhash/i,
  /\bhash\b/i,
  /ledger/i,
  /material/i,
  /content/i,
  /asset/i,
  /email/i,
  /\bmail\b/i,
  /\burl\b/i,
  /\buri\b/i,
  /\blink\b/i,
  /\bhref\b/i,
];

const STELLAR_ADDRESS_REGEX = /^G[A-Z0-9]{55}$/i;
const STELLAR_CONTRACT_REGEX = /^C[A-Z0-9]{55}$/i;
const EVM_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/i;
const HEX_64_REGEX = /^[a-fA-F0-9]{64}$/i;
const EVM_TX_REGEX = /^0x[a-fA-F0-9]{64}$/i;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_REGEX = /^(https?|ftp|file):\/\/[^\s]+/i;
const MATERIAL_ID_REGEX = /^(mat|material)-[a-zA-Z0-9_\-]+$/i;

/** True when a label key or value could carry a wallet/tx/PII identifier. */
export function isDeniedMetricLabel(key, value) {
  const k = String(key || "").toLowerCase();
  if (DENY_FIELDS.has(k)) return true;

  for (const pattern of DENY_LABEL_KEY_PATTERNS) {
    if (pattern.test(k)) return true;
  }

  if (value !== undefined && value !== null) {
    const v = String(value).trim();
    if (STELLAR_ADDRESS_REGEX.test(v)) return true;
    if (STELLAR_CONTRACT_REGEX.test(v)) return true;
    if (EVM_ADDRESS_REGEX.test(v)) return true;
    if (HEX_64_REGEX.test(v)) return true;
    if (EVM_TX_REGEX.test(v)) return true;
    if (EMAIL_REGEX.test(v)) return true;
    if (URL_REGEX.test(v)) return true;
    if (MATERIAL_ID_REGEX.test(v)) return true;
    if (v.includes("://")) return true;
    if (v.startsWith("ledger:") || v.startsWith("tx:")) return true;
  }

  return false;
}

/** Keep only labels that cannot carry PII or identifiers (cardinality-safe). */
export function sanitizeMetricLabels(labels = {}) {
  if (!labels || typeof labels !== "object") return {};
  const safe = {};
  for (const [key, value] of Object.entries(labels)) {
    if (value === undefined || value === null) continue;
    if (!isDeniedMetricLabel(key, value)) {
      safe[key] = value;
    }
  }
  return safe;
}

/**
 * Remove stack frames from untrusted text, collapsing runs of frames into a
 * single marker so the shape of the error stays legible.
 */
export function stripStackFrames(text) {
  let out = String(text ?? "");
  for (const pattern of STACK_FRAME_RULES) {
    out = out.replace(pattern, "[STACK_FRAME_REDACTED]");
  }
  return out.replace(
    /(?:\[STACK_FRAME_REDACTED\][ \t]*\r?\n?){2,}/g,
    "[STACK_FRAMES_REDACTED]\n",
  );
}

/**
 * Redact credentials, key material and PII from an opaque string.
 *
 * @param {unknown} value raw text
 * @param {{ maxLength?: number, stripStacks?: boolean }} [options]
 * @returns {string} redacted text, truncated to `maxLength` when provided
 */
export function redactText(value, options = {}) {
  const { maxLength, stripStacks = true } = options;
  if (value === null || value === undefined) return "";

  // Strip control characters so an untrusted body cannot forge log records
  // once written to a text sink.
  let out = (typeof value === "string" ? value : String(value)).replace(CONTROL_CHARS, "");

  if (stripStacks) out = stripStackFrames(out);
  for (const { pattern, replacement } of TEXT_RULES) {
    out = out.replace(pattern, replacement);
  }

  if (typeof maxLength === "number" && maxLength >= 0 && out.length > maxLength) {
    out = `${out.slice(0, maxLength)}[TRUNCATED]`;
  }
  return out;
}

/**
 * Response headers that are safe to retain from an untrusted endpoint: they
 * are operationally useful and carry no credentials. Everything else
 * (`set-cookie`, `authorization`, `location`, vendor headers...) is dropped.
 */
export const SAFE_RESPONSE_HEADERS = Object.freeze([
  "content-type",
  "content-length",
  "date",
  "retry-after",
  "x-request-id",
  "x-correlation-id",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
]);

const MAX_HEADER_VALUE_LENGTH = 256;

/**
 * Keep only allowlisted headers, redact their values and bound their length.
 *
 * @param {Record<string, unknown>} headers
 * @param {string[]|Set<string>} [allowlist]
 * @returns {Record<string, string>}
 */
export function redactHeaders(headers, allowlist = SAFE_RESPONSE_HEADERS) {
  const allowed = allowlist instanceof Set ? allowlist : new Set(allowlist);
  const safe = {};
  if (!headers || typeof headers !== "object") return safe;

  for (const [key, value] of Object.entries(headers)) {
    const name = String(key).toLowerCase();
    if (!allowed.has(name)) continue;
    if (value === undefined || value === null) continue;
    const flat = Array.isArray(value) ? value.join(", ") : String(value);
    safe[name] = redactText(flat, { maxLength: MAX_HEADER_VALUE_LENGTH, stripStacks: false });
  }
  return safe;
}
