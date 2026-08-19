# Webhook Subscriber Response Handling

Outbound webhook deliveries call endpoints that EduVault does not control. Their
responses are untrusted input: they routinely carry `Set-Cookie` headers, bearer
tokens, framework stack traces and end-user PII. Before #173 the delivery worker
stored the first 1 KB of the raw response body, and the full raw header map was
returned to callers, so any of that could land in `webhook_deliveries` and be
served back through `GET /api/webhooks/:id/deliveries`.

This document describes what is captured today, the limits applied, and the
compatibility behaviour for records written before the change.

## What is captured per attempt

Each entry in `webhook_deliveries.attempts` now holds only a sanitised view,
produced by `sanitizeWebhookResponse()` in
[`src/lib/webhooks/dispatcher.js`](../src/lib/webhooks/dispatcher.js):

| Field | Meaning |
|---|---|
| `responseStatus` | HTTP status code, or `null` if none was received |
| `responseHeaders` | Allowlisted headers only, values redacted and capped at 256 chars |
| `responseBody` | Redacted preview, only for allowlisted content types, capped at 1024 chars |
| `responseBodyDigest` | `sha256:<hex>` over the bytes that were read, or `null` for an empty body |
| `responseBodyBytes` | Number of body bytes received |
| `responseBodyTruncated` | `true` when the body exceeded the capture limit |
| `responseBodyOmittedReason` | `empty_body` or `content_type_not_allowlisted` when no preview was kept |
| `error` | Redacted failure reason (`HTTP 500`, or a redacted dispatch error) |

The digest lets an operator tell whether two attempts returned the same body,
and whether a body changed between retries, without retaining the body itself.

## Limits

Defined once as `RESPONSE_LIMITS` in the dispatcher:

- `maxReadBytes` (64 KB): bytes read from the socket. Past this the response is
  abandoned and the socket released. An oversized response is **not** a delivery
  failure: the status code already decided the outcome, so the attempt is
  recorded with `responseBodyTruncated: true` instead of being retried forever.
- `captureBytes` (8 KB): bytes buffered in memory for the preview. The buffer is
  concatenated before decoding, so multi-byte UTF-8 sequences split across TCP
  chunks are not mangled.
- `previewChars` (1024): characters of the redacted preview that are persisted.

## Allowlists

Headers retained (`SAFE_RESPONSE_HEADERS` in
[`src/lib/telemetry/redact.js`](../src/lib/telemetry/redact.js)):
`content-type`, `content-length`, `date`, `retry-after`, `x-request-id`,
`x-correlation-id`, `x-ratelimit-limit`, `x-ratelimit-remaining`,
`x-ratelimit-reset`. Everything else — including `set-cookie`, `authorization`
and `location` — is dropped. Redirect targets are still followed in-process but
never returned or persisted, because they frequently carry credentials.

Bodies are previewed only for `application/json`, `application/problem+json`,
any `application/*+json` vendor type, and `text/plain`. HTML error pages,
`text/event-stream` and binary payloads are digested only.

## Redaction

`redactText()` runs over every previewed body, every retained header value and
every persisted error message. It removes PEM private keys, credential
assignments (`password=`, `api_key:`, `session=`, `set-cookie: …`), `Bearer`
and `Basic` values, JWTs, common vendor token shapes (AWS, GitHub, Slack),
Stellar secret seeds, email addresses, stack frames (V8, JVM, Python) and
control characters. Wallet addresses and numeric identifiers are deliberately
kept: they are needed to debug a delivery and are not credentials.

## Logs and metrics

Delivery logs carry the status, byte count and digest — never the body. Failed
attempts log the redacted error. `webhook_response_captured_total` is
incremented per attempt with `truncated` and `omitted` labels, so operators can
see how often subscriber responses are being bounded or skipped.

## Compatibility and migration

- **Schema**: `attempts` entries gained optional fields. The validator in
  `schemaContracts.js` documents them without marking them required, so
  delivery documents written before #173 keep validating and can still be
  updated in place.
- **Existing rows are not rewritten.** No backfill migration runs: rewriting
  historic bodies cannot un-leak them, and `webhook_deliveries` is already
  deleted on account deletion (see
  [privacy-data-retention.md](./privacy-data-retention.md)).
- **Read path**: `GET /api/webhooks/:id/deliveries` passes every attempt through
  `sanitizeStoredAttempt()`, so pre-#173 records are redacted and bounded on
  read. Operators who want the old rows gone can drop attempts older than their
  retention window; the API will not expose their raw content in the meantime.
- **Consumers**: `responseBody` keeps its name and remains a string, so existing
  dashboards continue to work — its content is now redacted and may be empty
  with `responseBodyOmittedReason` set.
