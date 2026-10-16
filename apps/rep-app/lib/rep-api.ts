/**
 * M5 — typed wrappers for the two online-only rep-workspace reads and the closing
 * submit. The field-sync calls (snapshot/delta/replay/queue) live in
 * `lib/offline/rep-sync.ts` because they are the offline engine's own transport.
 */
import { apiData, apiPost } from '@erp/web-core/api';

import type { RepCustody, RepDay } from './offline/types';

/** `GET /rep-workspace/day?date=YYYY-MM-DD` (M4). */
export async function fetchRepDay(date: string): Promise<RepDay> {
  return apiData<RepDay>(`/rep-workspace/day?date=${encodeURIComponent(date)}`);
}

/** `GET /rep-workspace/custody` (M4). */
export async function fetchRepCustody(): Promise<RepCustody> {
  return apiData<RepCustody>('/rep-workspace/custody');
}

/**
 * `POST /rep-workspace/closing` (M4) — the ONLINE route-close submit. The body is the
 * controller's own shape (`actualRemainingQty` is the rep's counted remaining,
 * `closingNotes` the free text). The shortage acknowledgment is a UI-side gate (D-008):
 * the checkbox forces the rep to state he understands the difference goes to the
 * accountant; the server never settles silently (`pending_policy_approval` upstream)
 * regardless.
 */
export async function submitRepClosing(input: {
  loadOrderId: string;
  returnedQty: string;
  collectedCash: string;
  actualRemainingQty: string;
  damagedQty?: string;
  damageReason?: string;
  closingNotes?: string;
}): Promise<Record<string, unknown>> {
  return apiPost<Record<string, unknown>>('/rep-workspace/closing', {
    loadOrderId: input.loadOrderId,
    returnedQty: input.returnedQty,
    collectedCash: input.collectedCash,
    actualRemainingQty: input.actualRemainingQty,
    damagedQty: input.damagedQty,
    damageReason: input.damageReason,
    closingNotes: input.closingNotes,
  });
}
