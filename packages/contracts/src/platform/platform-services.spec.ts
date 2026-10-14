import { describe, expect, it } from 'vitest';

import {
  DOCUMENT_TYPES,
  QUEUE_NAMES,
  auditListQuerySchema,
  fileContentQuerySchema,
  filePresignSchema,
  formatSequenceNumber,
  isDocumentType,
  isQueueName,
  notificationCreateSchema,
  outboxJobDtoSchema,
} from './index.js';

/**
 * PHASE_04 contract surfaces. These schemas are the boundary the API and the future
 * admin UI both compile against, so the invariants worth pinning are the frozen lists
 * and the coercions that only ever happen on the wire.
 */
describe('platform-services contracts (PHASE_04)', () => {
  it('freezes the BullMQ queue names of TARGET_ARCHITECTURE §6', () => {
    expect([...QUEUE_NAMES]).toEqual([
      'einvoice',
      'notifications',
      'reports-export',
      'migration',
      'maintenance',
    ]);
    expect(isQueueName('einvoice')).toBe(true);
    expect(isQueueName('emails')).toBe(false);
  });

  it('keeps the document types of DATABASE_DESIGN §3 addressable by name', () => {
    expect(DOCUMENT_TYPES).toContain('sales_invoice');
    expect(isDocumentType('sales_invoice')).toBe(true);
    expect(isDocumentType('not_a_document')).toBe(false);
  });

  it('formats sequence numbers, padding without ever truncating', () => {
    expect(formatSequenceNumber(1)).toBe('000001');
    expect(formatSequenceNumber(42, 'INV-', 6)).toBe('INV-000042');
    expect(formatSequenceNumber(1_234_567, 'INV-', 6)).toBe('INV-1234567');
    expect(formatSequenceNumber(0, 'X', 2)).toBe('X00');
  });

  it('validates a presign request and rejects an empty or oversized name', () => {
    const parsed = filePresignSchema.parse({
      name: 'invoice.pdf',
      mime: 'application/pdf',
      sizeBytes: 1024,
    });
    expect(parsed.sizeBytes).toBe(1024);

    expect(() => filePresignSchema.parse({ name: '', mime: 'application/pdf', sizeBytes: 1 })).toThrow();
    expect(() =>
      filePresignSchema.parse({ name: 'a.pdf', mime: 'application/pdf', sizeBytes: 0 }),
    ).toThrow();
  });

  it('coerces the numeric query parameters of a signed content URL', () => {
    const query = fileContentQuerySchema.parse({
      tenant: '01a06e00-0000-7000-8000-0000000000aa',
      expires: '4102444800',
      signature: 'a'.repeat(43),
    });
    expect(query.expires).toBe(4_102_444_800);

    // The tenant travels inside the signed URL, so it must be a real uuid.
    expect(() =>
      fileContentQuerySchema.parse({ tenant: 'not-a-uuid', expires: '1', signature: 'a'.repeat(43) }),
    ).toThrow();
  });

  it('requires a notification type and defaults the payload', () => {
    const created = notificationCreateSchema.parse({ type: 'demo.ping' });
    expect(created.payload).toEqual({});
    expect(() => notificationCreateSchema.parse({})).toThrow();
  });

  it('shapes an outbox DTO without leaking the payload', () => {
    const dto = outboxJobDtoSchema.parse({
      id: '01a06e00-0000-7000-8000-000000000001',
      queue: 'notifications',
      type: 'notification.email',
      status: 'pending',
      attempts: 0,
      runAt: '2026-01-01T00:00:00.000Z',
      processedAt: null,
      lastError: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(Object.keys(dto)).not.toContain('payload');
  });

  it('defaults audit-log pagination to the shared page size (API_CONTRACT §0)', () => {
    const query = auditListQuerySchema.parse({});
    expect(query.limit).toBe(50);
    expect(query.offset).toBe(0);
  });
});
