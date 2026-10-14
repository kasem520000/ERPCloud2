import { describe, expect, it } from 'vitest';

import { adjustmentJournalLink, nextSerialStatus, nextTransferStatus } from './inventory-lifecycle.js';

describe('inventory lifecycle invariants', () => {
  it('supports partial transfer receipt and completion', () => {
    expect(nextTransferStatus('draft', 'send', '10.0000')).toBe('sent');
    expect(nextTransferStatus('sent', 'receive', '4.0000')).toBe('partially_received');
    expect(nextTransferStatus('partially_received', 'receive', '0.0000')).toBe('received');
  });
  it('rejects invalid serial transitions', () => {
    expect(nextSerialStatus('available', 'reserve')).toBe('reserved');
    expect(nextSerialStatus('reserved', 'issue')).toBe('issued');
    expect(() => nextSerialStatus('available', 'return')).toThrow('INVALID_SERIAL_TRANSITION');
  });
  it('requires a journal link for posted adjustments', () => {
    expect(adjustmentJournalLink('posted', 'journal-1')).toBe('journal-1');
    expect(() => adjustmentJournalLink('posted')).toThrow('ADJUSTMENT_POSTING_REQUIRED');
  });
  it('keeps transfer cancellation terminal', () => {
    expect(nextTransferStatus('sent', 'cancel', '10.0000')).toBe('cancelled');
    expect(() => nextTransferStatus('cancelled', 'cancel', '10.0000')).toThrow('TRANSFER_NOT_CANCELLABLE');
  });

  it('keeps 64 concurrent receipt decisions deterministic', async () => {
    const decisions = await Promise.all(
      Array.from({ length: 64 }, async (_, index) =>
        nextTransferStatus('partially_received', 'receive', index === 63 ? '0.0000' : '2.0000'),
      ),
    );

    expect(decisions.slice(0, 63).every((status) => status === 'partially_received')).toBe(true);
    expect(decisions[63]).toBe('received');
  });

  it('rejects terminal and backward serial transitions', () => {
    expect(() => nextSerialStatus('scrapped', 'reserve')).toThrow('INVALID_SERIAL_TRANSITION');
    expect(() => nextSerialStatus('returned', 'issue')).toThrow('INVALID_SERIAL_TRANSITION');
    expect(nextSerialStatus('issued', 'return')).toBe('returned');
    expect(nextSerialStatus('returned', 'scrap')).toBe('scrapped');
  });

  it('requires journal links only for posted adjustments', () => {
    expect(() => adjustmentJournalLink('draft')).toThrow('ADJUSTMENT_POSTING_REQUIRED');
    expect(() => adjustmentJournalLink('approved')).toThrow('ADJUSTMENT_POSTING_REQUIRED');
    expect(adjustmentJournalLink('posted', 'journal-64')).toBe('journal-64');
  });
});
