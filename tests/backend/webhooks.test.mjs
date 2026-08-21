import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  isPrivateIP,
  dispatchWebhook,
  sanitizeWebhookResponse,
  sanitizeStoredAttempt,
  sanitizeDispatchError,
  isPreviewableContentType,
  RESPONSE_LIMITS,
} from '../../src/lib/webhooks/dispatcher.js';
import { redactText, redactHeaders, stripStackFrames } from '../../src/lib/telemetry/redact.js';
import { generateSignature, generateSignaturesHeader, verifySignature } from '../../src/lib/webhooks/signature.js';

describe('Webhooks SSRF Protection', () => {
  test('isPrivateIP identifies private ranges', () => {
    assert.strictEqual(isPrivateIP('127.0.0.1'), true);
    assert.strictEqual(isPrivateIP('10.5.0.1'), true);
    assert.strictEqual(isPrivateIP('172.16.0.0'), true);
    assert.strictEqual(isPrivateIP('192.168.1.1'), true);
    assert.strictEqual(isPrivateIP('169.254.169.254'), true);
    assert.strictEqual(isPrivateIP('::1'), true);
    assert.strictEqual(isPrivateIP('fe80::1'), true);
    assert.strictEqual(isPrivateIP('::ffff:127.0.0.1'), true);

    assert.strictEqual(isPrivateIP('8.8.8.8'), false);
    assert.strictEqual(isPrivateIP('1.1.1.1'), false);
    assert.strictEqual(isPrivateIP('2001:4860:4860::8888'), false);
  });

  test('dispatchWebhook rejects insecure connections', async () => {
    await assert.rejects(
      () => dispatchWebhook('http://example.com', '{}', 'sig'),
      { message: 'Only HTTPS is allowed' }
    );
  });

  test('dispatchWebhook rejects credentials', async () => {
    await assert.rejects(
      () => dispatchWebhook('https://user:pass@example.com', '{}', 'sig'),
      { message: 'URL credentials are not allowed' }
    );
  });

  test('dispatchWebhook rejects unsafe ports', async () => {
    await assert.rejects(
      () => dispatchWebhook('https://example.com:22', '{}', 'sig'),
      { message: 'Unsafe port' }
    );
  });

  test('dispatchWebhook rejects private IPs', async () => {
    // Requires ALLOW_LOCAL_WEBHOOKS to not be set to true
    process.env.ALLOW_LOCAL_WEBHOOKS = '';
    process.env.NODE_ENV = 'production';
    
    // Test a domain that resolves to localhost (e.g., localhost or localtest.me)
    await assert.rejects(
      () => dispatchWebhook('https://localhost', '{}', 'sig'),
      /SSRF Prevention: Cannot connect to private\/reserved IP/
    );

    process.env.NODE_ENV = 'test'; // Restore
  });
});

describe('Webhooks Signature', () => {
  test('verifySignature succeeds for valid signature', () => {
    const payload = '{"test": true}';
    const secret = 'my-secret-key';
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const sig = generateSignature(payload, secret, timestamp);
    const header = `t=${timestamp},${sig}`;

    assert.strictEqual(verifySignature(payload, header, secret), true);
  });

  test('verifySignature fails for invalid payload', () => {
    const payload = '{"test": true}';
    const secret = 'my-secret-key';
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const sig = generateSignature(payload, secret, timestamp);
    const header = `t=${timestamp},${sig}`;

    assert.strictEqual(verifySignature('{"test": false}', header, secret), false);
  });

  test('verifySignature fails for invalid secret', () => {
    const payload = '{"test": true}';
    const secret = 'my-secret-key';
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const sig = generateSignature(payload, secret, timestamp);
    const header = `t=${timestamp},${sig}`;

    assert.strictEqual(verifySignature(payload, header, 'wrong-secret'), false);
  });

  test('verifySignature fails for expired timestamp (replay)', () => {
    const payload = '{"test": true}';
    const secret = 'my-secret-key';
    const timestamp = (Math.floor(Date.now() / 1000) - 10 * 60).toString(); // 10 minutes ago
    const sig = generateSignature(payload, secret, timestamp);
    const header = `t=${timestamp},${sig}`;

    assert.strictEqual(verifySignature(payload, header, secret), false);
  });

  test('generateSignaturesHeader supports overlapping keys', () => {
    const payload = '{"test": true}';
    const secrets = [
      { key: 'old-secret' },
      { key: 'new-secret' }
    ];

    const header = generateSignaturesHeader(payload, secrets);

    // Should verify successfully with either secret
    assert.strictEqual(verifySignature(payload, header, 'old-secret'), true);
    assert.strictEqual(verifySignature(payload, header, 'new-secret'), true);
    assert.strictEqual(verifySignature(payload, header, 'wrong-secret'), false);
  });
});

describe('Webhook response redaction (#173)', () => {
  const secretBody = JSON.stringify({
    message: 'processed',
    session: 'sess_9f8a7b6c5d4e3f2a1b0c',
    api_key: 'ak_live_ZZZ111YYY222XXX333',
    contact: 'learner@example.com',
    token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.7Hs2Q4qKQqBv1sZzYt0i1w',
  });

  test('regression: raw subscriber body is never returned for persistence', () => {
    const safe = sanitizeWebhookResponse({
      status: 200,
      headers: {
        'content-type': 'application/json',
        'set-cookie': ['sid=super-secret-value; HttpOnly'],
        authorization: 'Bearer aaaabbbbccccdddd',
      },
      bodyBuffer: Buffer.from(secretBody, 'utf8'),
    });

    const serialized = JSON.stringify(safe);
    assert.ok(!serialized.includes('sess_9f8a7b6c5d4e3f2a1b0c'), 'session id must not be persisted');
    assert.ok(!serialized.includes('ak_live_ZZZ111YYY222XXX333'), 'api key must not be persisted');
    assert.ok(!serialized.includes('learner@example.com'), 'email must not be persisted');
    assert.ok(!serialized.includes('eyJhbGciOiJIUzI1NiJ9'), 'JWT must not be persisted');
    assert.ok(!serialized.includes('super-secret-value'), 'cookie must not be persisted');

    // The non-sensitive part of the body is still useful for debugging.
    assert.ok(safe.responseBody.includes('processed'));
    assert.strictEqual(safe.responseStatus, 200);
  });

  test('only allowlisted response headers survive', () => {
    const safe = sanitizeWebhookResponse({
      status: 202,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': ['sid=abc'],
        Authorization: 'Bearer aaaabbbbccccdddd',
        Location: 'https://evil.example/callback?token=aaaabbbbccccdddd',
        'X-Request-Id': 'req-123',
        'Retry-After': '30',
        'X-Internal-Debug': '/srv/app/handler.js',
      },
      bodyBuffer: Buffer.from('{}', 'utf8'),
    });

    assert.deepStrictEqual(Object.keys(safe.responseHeaders).sort(), [
      'content-type',
      'retry-after',
      'x-request-id',
    ]);
  });

  test('bodies are bounded and digested', () => {
    const body = Buffer.alloc(RESPONSE_LIMITS.captureBytes, 'a');
    const safe = sanitizeWebhookResponse({
      status: 200,
      headers: { 'content-type': 'application/json' },
      bodyBuffer: body,
      bodyBytes: 5 * 1024 * 1024,
      truncated: true,
    });

    assert.ok(safe.responseBody.length <= RESPONSE_LIMITS.previewChars + '[TRUNCATED]'.length);
    assert.strictEqual(safe.responseBodyBytes, 5 * 1024 * 1024);
    assert.strictEqual(safe.responseBodyTruncated, true);
    assert.match(safe.responseBodyDigest, /^sha256:[0-9a-f]{64}$/);
  });

  test('digest is stable and distinguishes different bodies', () => {
    const digestOf = (text) =>
      sanitizeWebhookResponse({
        status: 200,
        headers: { 'content-type': 'application/json' },
        bodyBuffer: Buffer.from(text, 'utf8'),
      }).responseBodyDigest;

    assert.strictEqual(digestOf('{"a":1}'), digestOf('{"a":1}'));
    assert.notStrictEqual(digestOf('{"a":1}'), digestOf('{"a":2}'));
  });

  test('non-allowlisted content types are digested but not previewed', () => {
    const safe = sanitizeWebhookResponse({
      status: 500,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      bodyBuffer: Buffer.from('<html>session=abc</html>', 'utf8'),
    });

    assert.strictEqual(safe.responseBody, '');
    assert.strictEqual(safe.responseBodyOmittedReason, 'content_type_not_allowlisted');
    assert.match(safe.responseBodyDigest, /^sha256:/);
  });

  test('empty and malformed responses fail safe', () => {
    const empty = sanitizeWebhookResponse({ status: 204, headers: {}, bodyBuffer: Buffer.alloc(0) });
    assert.strictEqual(empty.responseBody, '');
    assert.strictEqual(empty.responseBodyDigest, null);
    assert.strictEqual(empty.responseBodyOmittedReason, 'empty_body');

    const missing = sanitizeWebhookResponse();
    assert.strictEqual(missing.responseStatus, null);
    assert.strictEqual(missing.responseBody, '');
    assert.deepStrictEqual(missing.responseHeaders, {});
    assert.strictEqual(missing.responseBodyBytes, 0);

    const noContentType = sanitizeWebhookResponse({
      status: 200,
      headers: {},
      bodyBuffer: Buffer.from('plain', 'utf8'),
    });
    assert.strictEqual(noContentType.responseBodyOmittedReason, 'content_type_not_allowlisted');
  });

  test('vendor JSON media types are previewable, streams are not', () => {
    assert.strictEqual(isPreviewableContentType('application/vnd.acme.v1+json'), true);
    assert.strictEqual(isPreviewableContentType('APPLICATION/JSON; charset=utf-8'), true);
    assert.strictEqual(isPreviewableContentType('text/plain'), true);
    assert.strictEqual(isPreviewableContentType('text/event-stream'), false);
    assert.strictEqual(isPreviewableContentType('application/octet-stream'), false);
    assert.strictEqual(isPreviewableContentType(undefined), false);
  });

  test('dispatch errors are redacted and bounded', () => {
    const error = new Error(
      `connect failed https://hooks.example.com/x?access_token=aaaabbbbccccdddd ${'x'.repeat(2000)}`
    );
    const message = sanitizeDispatchError(error);

    assert.ok(!message.includes('aaaabbbbccccdddd'));
    assert.ok(message.length <= 512 + '[TRUNCATED]'.length);
    assert.strictEqual(sanitizeDispatchError(null), 'Unknown error');
  });

  test('stored attempts from before the fix are redacted on read', () => {
    const legacy = {
      attemptNumber: 1,
      responseStatus: 200,
      responseBody: 'set-cookie: session=leaked-value; Path=/',
      responseHeaders: { 'set-cookie': 'session=leaked-value', 'content-type': 'application/json' },
      error: 'failed for admin@example.com',
    };

    const safe = sanitizeStoredAttempt(legacy);
    assert.ok(!JSON.stringify(safe).includes('leaked-value'));
    assert.ok(!JSON.stringify(safe).includes('admin@example.com'));
    assert.deepStrictEqual(Object.keys(safe.responseHeaders), ['content-type']);
    assert.strictEqual(safe.attemptNumber, 1);
    assert.strictEqual(sanitizeStoredAttempt(null), null);
  });
});

describe('Telemetry text redaction', () => {
  test('redacts credentials, key material and PII', () => {
    const text = [
      'password=hunter2',
      'Authorization: Bearer aaaabbbbccccdddd',
      'aws AKIAABCDEFGHIJKLMNOP',
      'github ghp_abcdefghijklmnopqrstuvwxyz0123',
      'user bob@example.org',
    ].join('\n');

    const safe = redactText(text);
    assert.ok(!safe.includes('hunter2'));
    assert.ok(!safe.includes('aaaabbbbccccdddd'));
    assert.ok(!safe.includes('AKIAABCDEFGHIJKLMNOP'));
    assert.ok(!safe.includes('ghp_abcdefghijklmnopqrstuvwxyz0123'));
    assert.ok(!safe.includes('bob@example.org'));
  });

  test('keeps benign operational values readable', () => {
    const safe = redactText('order 12345 for GABCDEF status=ok latency=42ms');
    assert.strictEqual(safe, 'order 12345 for GABCDEF status=ok latency=42ms');
  });

  test('strips stack frames', () => {
    const stack = [
      'TypeError: bad input',
      '    at handler (/srv/app/routes/webhook.js:42:11)',
      '    at process (/srv/app/node_modules/express/lib/router.js:9:3)',
    ].join('\n');

    const safe = stripStackFrames(stack);
    assert.ok(safe.startsWith('TypeError: bad input'));
    assert.ok(!safe.includes('/srv/app/routes/webhook.js'));
    assert.ok(!safe.includes('node_modules'));
  });

  test('redactHeaders drops unknown headers and bounds values', () => {
    const safe = redactHeaders({
      'content-type': 'application/json',
      'x-ratelimit-remaining': '9',
      cookie: 'sid=abc',
      'x-vendor': 'anything',
      'x-request-id': 'r'.repeat(1000),
    });

    assert.deepStrictEqual(Object.keys(safe).sort(), [
      'content-type',
      'x-ratelimit-remaining',
      'x-request-id',
    ]);
    assert.ok(safe['x-request-id'].length < 1000);
  });
});
