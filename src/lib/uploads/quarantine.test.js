/**
 * Tests for the upload quarantine module and file-type policy.
 *
 * Coverage:
 *  - quarantineUpload: deduplication by SHA-256
 *  - scanNextUpload: happy-path approval
 *  - scanNextUpload: threat/scanner-verdict rejection
 *  - scanNextUpload: unsafe archive rejection (ZIP bomb limits)
 *  - scanNextUpload: scanner crash → SCAN_FAILED state (retryable)
 *  - fileTypePolicy: validateDocumentPolicy — missing file, oversized, unsupported, valid
 *  - fileTypePolicy: validateThumbnailPolicy — oversized, unsupported, optional, valid
 *  - Creator-facing messages are defined for every rejection reason
 *
 * Relevant issue: Eduvault-stellar/eduvault#203
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { quarantineUpload, scanNextUpload, SCAN_STATUS } from './quarantine.js';
import {
  validateDocumentPolicy,
  validateThumbnailPolicy,
  QUARANTINE_REJECTION_REASONS,
  QUARANTINE_CREATOR_MESSAGES,
  MAX_DOCUMENT_BYTES,
  MAX_THUMBNAIL_BYTES,
  ALLOWED_DOCUMENT_TYPES,
  ALLOWED_THUMBNAIL_TYPES,
} from './fileTypePolicy.js';

// ---------------------------------------------------------------------------
// In-memory MongoDB stub
// ---------------------------------------------------------------------------

function makeFakeCollection(initialDocs = []) {
  const docs = [...initialDocs];
  return {
    async findOne(query) {
      if (query.sha256) {
        return docs.find(
          (d) => d.sha256 === query.sha256 && query.status.$in.includes(d.status),
        ) ?? null;
      }
      // findOneAndUpdate stub — return first matching doc
      return docs[0] ?? null;
    },
    async insertOne(doc) {
      const _id = `id_${docs.length}`;
      docs.push({ ...doc, _id });
      return { insertedId: _id };
    },
    async findOneAndUpdate(filter, update, options) {
      const idx = docs.findIndex(
        (d) => filter.status.$in.includes(d.status) &&
               (!d.leaseUntil || d.leaseUntil < new Date()),
      );
      if (idx === -1) return null;
      const doc = { ...docs[idx] };
      // apply $set
      Object.assign(doc, update.$set ?? {});
      // apply $inc
      for (const [k, v] of Object.entries(update.$inc ?? {})) doc[k] = (doc[k] ?? 0) + v;
      docs[idx] = doc;
      return doc;
    },
    async updateOne(filter, update) {
      const idx = docs.findIndex((d) => d._id === (filter._id ?? docs[0]?._id));
      if (idx === -1) return;
      Object.assign(docs[idx], update.$set ?? {});
      for (const k of Object.keys(update.$unset ?? {})) delete docs[idx][k];
    },
    _docs: docs,
  };
}

function makeFakeDb(collection) {
  return { collection: () => collection };
}

// ---------------------------------------------------------------------------
// quarantineUpload
// ---------------------------------------------------------------------------

describe('quarantineUpload', () => {
  it('stores a new upload with QUARANTINED status', async () => {
    const col = makeFakeCollection();
    const db  = makeFakeDb(col);
    const bytes = Buffer.from('%PDF-1.4 test content');

    const result = await quarantineUpload(db, {
      bytes, fileName: 'lecture.pdf', mimeType: 'application/pdf', metadata: { title: 'Lecture 1' },
    });

    expect(result.status).toBe(SCAN_STATUS.QUARANTINED);
    expect(result.sha256).toHaveLength(64);
    expect(result.fileName).toBe('lecture.pdf');
  });

  it('returns the existing record for a duplicate SHA-256 without re-inserting', async () => {
    const bytes   = Buffer.from('duplicate content');
    const existing = {
      sha256: require('node:crypto').createHash('sha256').update(bytes).digest('hex'),
      status: SCAN_STATUS.QUARANTINED,
      fileName: 'notes.pdf',
      _id: 'existing_id',
    };
    const col = makeFakeCollection([existing]);
    const db  = makeFakeDb(col);

    const result = await quarantineUpload(db, {
      bytes, fileName: 'notes.pdf', mimeType: 'application/pdf',
    });

    expect(result._id).toBe('existing_id');
    // only the original doc should be present
    expect(col._docs).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// scanNextUpload — happy path
// ---------------------------------------------------------------------------

describe('scanNextUpload — approval', () => {
  it('approves a clean file and removes payload from the record', async () => {
    const col = makeFakeCollection([{
      _id: 'job1', status: SCAN_STATUS.QUARANTINED, attempts: 0,
      payload: Buffer.from('%PDF-1.4'), fileName: 'notes.pdf',
    }]);
    const db  = makeFakeDb(col);
    const scanner = { scan: vi.fn().mockResolvedValue({ clean: true, verdict: 'ok', archiveEntries: 1, expandedBytes: 100, maxDepth: 1 }) };

    const result = await scanNextUpload(db, scanner, { workerId: 'w1', engineVersion: '0.9', rulesVersion: '2026-09' });

    expect(result.status).toBe(SCAN_STATUS.APPROVED);
    expect(scanner.scan).toHaveBeenCalledOnce();
    // payload should be stripped from the stored record
    expect(col._docs[0].payload).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// scanNextUpload — threat rejection
// ---------------------------------------------------------------------------

describe('scanNextUpload — threat rejection', () => {
  it('marks file REJECTED when scanner returns a threat verdict', async () => {
    const col = makeFakeCollection([{
      _id: 'job2', status: SCAN_STATUS.QUARANTINED, attempts: 0,
      payload: Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR'),
      fileName: 'eicar.txt',
    }]);
    const db  = makeFakeDb(col);
    const scanner = { scan: vi.fn().mockResolvedValue({ clean: false, verdict: 'Eicar-Test-Signature', archiveEntries: 0, expandedBytes: 68, maxDepth: 0 }) };

    const result = await scanNextUpload(db, scanner, { workerId: 'w2', engineVersion: '0.9', rulesVersion: '2026-09' });

    expect(result.status).toBe(SCAN_STATUS.REJECTED);
    // the QUARANTINE_CREATOR_MESSAGES should explain the rejection
    expect(QUARANTINE_CREATOR_MESSAGES[QUARANTINE_REJECTION_REASONS.SCANNER_VERDICT]).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// scanNextUpload — unsafe archive (ZIP bomb)
// ---------------------------------------------------------------------------

describe('scanNextUpload — unsafe archive', () => {
  it('rejects a ZIP with expansion ratio exceeding 100 MB', async () => {
    const col = makeFakeCollection([{
      _id: 'job3', status: SCAN_STATUS.QUARANTINED, attempts: 0,
      payload: Buffer.from('PK\x03\x04 fake zip'), fileName: 'bomb.zip',
    }]);
    const db  = makeFakeDb(col);
    const scanner = { scan: vi.fn().mockResolvedValue({
      clean: true,
      verdict: 'ok',
      archiveEntries: 5000,                // exceeds 1000-entry limit
      expandedBytes: 200 * 1024 * 1024,    // 200 MB — exceeds 100 MB limit
      maxDepth: 3,
    }) };

    const result = await scanNextUpload(db, scanner, { workerId: 'w3', engineVersion: '0.9', rulesVersion: '2026-09' });

    expect(result.status).toBe(SCAN_STATUS.REJECTED);
    expect(QUARANTINE_CREATOR_MESSAGES[QUARANTINE_REJECTION_REASONS.UNSAFE_ARCHIVE]).toContain('100 MB');
  });

  it('rejects a ZIP with nesting depth exceeding 5 levels', async () => {
    const col = makeFakeCollection([{
      _id: 'job4', status: SCAN_STATUS.QUARANTINED, attempts: 0,
      payload: Buffer.from('PK\x03\x04 deep zip'), fileName: 'deep.zip',
    }]);
    const db  = makeFakeDb(col);
    const scanner = { scan: vi.fn().mockResolvedValue({ clean: true, verdict: 'ok', archiveEntries: 10, expandedBytes: 1024, maxDepth: 10 }) };

    const result = await scanNextUpload(db, scanner, { workerId: 'w4', engineVersion: '0.9', rulesVersion: '2026-09' });

    expect(result.status).toBe(SCAN_STATUS.REJECTED);
  });
});

// ---------------------------------------------------------------------------
// scanNextUpload — scanner crash → SCAN_FAILED (retryable)
// ---------------------------------------------------------------------------

describe('scanNextUpload — scanner crash', () => {
  it('transitions to SCAN_FAILED and preserves the record for retry', async () => {
    const col = makeFakeCollection([{
      _id: 'job5', status: SCAN_STATUS.QUARANTINED, attempts: 0,
      payload: Buffer.from('%PDF-1.4'), fileName: 'crashme.pdf',
    }]);
    const db  = makeFakeDb(col);
    const scanner = { scan: vi.fn().mockRejectedValue(new Error('ClamAV daemon unreachable')) };

    const result = await scanNextUpload(db, scanner, { workerId: 'w5', engineVersion: '0.9', rulesVersion: '2026-09' });

    expect(result.status).toBe(SCAN_STATUS.FAILED);
    // Payload must NOT be stripped so the job can be retried
    expect(col._docs[0].payload).toBeDefined();
    expect(QUARANTINE_CREATOR_MESSAGES[QUARANTINE_REJECTION_REASONS.SCAN_ERROR]).toBeTruthy();
  });

  it('returns null when no pending job is available', async () => {
    const col = makeFakeCollection([]);
    const db  = makeFakeDb(col);
    const scanner = { scan: vi.fn() };

    const result = await scanNextUpload(db, scanner, { workerId: 'w6', engineVersion: '0.9', rulesVersion: '2026-09' });

    expect(result).toBeNull();
    expect(scanner.scan).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// validateDocumentPolicy
// ---------------------------------------------------------------------------

describe('validateDocumentPolicy', () => {
  it('rejects a missing file', () => {
    const r = validateDocumentPolicy(null);
    expect(r.valid).toBe(false);
    expect(r.code).toBe('MISSING_FILE');
  });

  it('rejects a file that exceeds the 10 MB size limit', () => {
    const file = { name: 'big.pdf', type: 'application/pdf', size: MAX_DOCUMENT_BYTES + 1 };
    const r = validateDocumentPolicy(file);
    expect(r.valid).toBe(false);
    expect(r.code).toBe('FILE_TOO_LARGE');
    expect(r.message).toMatch(/10 MB/);
  });

  it('rejects an unsupported MIME type with an actionable message listing allowed formats', () => {
    const file = { name: 'script.exe', type: 'application/x-msdownload', size: 1024 };
    const r = validateDocumentPolicy(file);
    expect(r.valid).toBe(false);
    expect(r.code).toBe('UNSUPPORTED_TYPE');
    expect(r.message).toMatch(/PDF/i);
  });

  it('accepts every MIME type in the allow-list', () => {
    for (const mime of ALLOWED_DOCUMENT_TYPES) {
      const r = validateDocumentPolicy({ name: 'file', type: mime, size: 1024 });
      expect(r.valid).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// validateThumbnailPolicy
// ---------------------------------------------------------------------------

describe('validateThumbnailPolicy', () => {
  it('returns valid: true when no thumbnail is provided (optional field)', () => {
    expect(validateThumbnailPolicy(null).valid).toBe(true);
    expect(validateThumbnailPolicy(undefined).valid).toBe(true);
  });

  it('rejects a thumbnail exceeding the 5 MB limit', () => {
    const img = { name: 'big.png', type: 'image/png', size: MAX_THUMBNAIL_BYTES + 1 };
    const r = validateThumbnailPolicy(img);
    expect(r.valid).toBe(false);
    expect(r.code).toBe('THUMBNAIL_TOO_LARGE');
    expect(r.message).toMatch(/5 MB/);
  });

  it('rejects a GIF thumbnail with an actionable message', () => {
    const img = { name: 'anim.gif', type: 'image/gif', size: 512 };
    const r = validateThumbnailPolicy(img);
    expect(r.valid).toBe(false);
    expect(r.code).toBe('UNSUPPORTED_THUMBNAIL_TYPE');
    expect(r.message).toMatch(/JPEG|PNG|WebP/i);
  });

  it('accepts every MIME type in the thumbnail allow-list', () => {
    for (const mime of ALLOWED_THUMBNAIL_TYPES) {
      const r = validateThumbnailPolicy({ name: 'thumb', type: mime, size: 1024 });
      expect(r.valid).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Creator messages exist for every rejection reason
// ---------------------------------------------------------------------------

describe('QUARANTINE_CREATOR_MESSAGES completeness', () => {
  it('defines a non-empty message for every rejection reason code', () => {
    for (const reason of Object.values(QUARANTINE_REJECTION_REASONS)) {
      const msg = QUARANTINE_CREATOR_MESSAGES[reason];
      expect(typeof msg).toBe('string');
      expect(msg.length).toBeGreaterThan(20);
    }
  });
});
