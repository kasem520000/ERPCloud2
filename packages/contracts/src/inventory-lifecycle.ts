export type TransferStatus = 'draft' | 'sent' | 'partially_received' | 'received' | 'cancelled';
export type SerialStatus = 'available' | 'reserved' | 'issued' | 'returned' | 'scrapped';

export function nextTransferStatus(status: TransferStatus, action: 'send' | 'receive' | 'cancel', pending: string): TransferStatus {
  if (action === 'cancel') {
    if (status === 'received' || status === 'cancelled') throw new Error('TRANSFER_NOT_CANCELLABLE');
    return 'cancelled';
  }
  if (action === 'send') {
    if (status !== 'draft') throw new Error('TRANSFER_ALREADY_SENT');
    return 'sent';
  }
  if (status !== 'sent' && status !== 'partially_received') throw new Error('TRANSFER_NOT_RECEIVABLE');
  return pending === '0.0000' ? 'received' : 'partially_received';
}

export function nextSerialStatus(status: SerialStatus, action: 'reserve' | 'issue' | 'return' | 'scrap'): SerialStatus {
  if (action === 'reserve' && status === 'available') return 'reserved';
  if (action === 'issue' && (status === 'available' || status === 'reserved')) return 'issued';
  if (action === 'return' && status === 'issued') return 'returned';
  if (action === 'scrap' && status !== 'scrapped') return 'scrapped';
  throw new Error('INVALID_SERIAL_TRANSITION');
}

export function adjustmentJournalLink(status: 'draft' | 'approved' | 'posted', journalId?: string) {
  if (status !== 'posted' || !journalId) throw new Error('ADJUSTMENT_POSTING_REQUIRED');
  return journalId;
}
