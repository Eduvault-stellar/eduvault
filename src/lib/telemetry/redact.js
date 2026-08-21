/**
 * Shared PII redaction rules for EduVault telemetry (#20).
 * Used by logger, tracing, and metrics so redaction is defined once.
 */

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