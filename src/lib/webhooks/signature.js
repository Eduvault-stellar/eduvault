import crypto from 'node:crypto';

export function generateEventId() {
  return crypto.randomUUID();
}

export function createWebhookPayload(eventId, eventType, data) {
  return {
    id: eventId,
    type: eventType,
    created: new Date().toISOString(),
    data: data,
  };
}

export function getActiveSecrets(secrets, now = new Date()) {
  if (!Array.isArray(secrets)) {
    if (!secrets) return [];
    secrets = [secrets];
  }
  return secrets.filter((s) => {
    if (typeof s === 'string') return true;
    if (!s || !s.key) return false;
    if (s.revokedAt && new Date(s.revokedAt) <= now) return false;
    if (s.expiresAt && new Date(s.expiresAt) <= now) return false;
    return true;
  });
}

export function generateSignature(payloadStr, secretKey, timestamp) {
  const key = typeof secretKey === 'object' ? secretKey.key : secretKey;
  const hmac = crypto.createHmac('sha256', key);
  hmac.update(`${timestamp}.${payloadStr}`);
  return `v1=${hmac.digest('hex')}`;
}

export function generateSignaturesHeader(payloadStr, secrets) {
  const active = getActiveSecrets(secrets);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signatures = active.map((secret) => generateSignature(payloadStr, secret, timestamp));
  return `t=${timestamp},${signatures.join(',')}`;
}

export function verifySignature(payloadStr, signatureHeader, secretOrSecrets) {
  if (!signatureHeader || !secretOrSecrets) return false;

  const validSecrets = getActiveSecrets(
    Array.isArray(secretOrSecrets) ? secretOrSecrets : [secretOrSecrets]
  );
  if (validSecrets.length === 0) return false;

  const parts = signatureHeader.split(',');
  let timestamp;
  const signatures = [];

  for (const part of parts) {
    const [key, value] = part.split('=');
    if (key === 't') {
      timestamp = value;
    } else if (key === 'v1') {
      signatures.push(value);
    }
  }

  if (!timestamp || signatures.length === 0) return false;

  // Prevent replay attacks (5 minute tolerance)
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp, 10)) > 5 * 60) {
    return false;
  }

  for (const secretObj of validSecrets) {
    const key = typeof secretObj === 'object' ? secretObj.key : secretObj;
    const expectedSignature = generateSignature(payloadStr, key, timestamp).split('=')[1];
    const expectedBuffer = Buffer.from(expectedSignature);

    for (const sig of signatures) {
      const sigBuffer = Buffer.from(sig);
      if (sigBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
        return true;
      }
    }
  }

  return false;
}
