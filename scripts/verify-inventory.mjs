#!/usr/bin/env node
/**
 * Live verification of the Phase 05 inventory documents against a running stack
 * (`pnpm db:local` + `pnpm db:migrate` + `pnpm db:seed` + `pnpm dev`).
 *
 * It drives the real HTTP API the staff screens drive — nothing is mocked:
 *
 *   1. بضاعة أول المدة — an opening voucher that credits بضاعة أول المدة
 *   2. سند إخراج — an issue at average cost that credits المخزون
 *   3. جرد وتسوية — a counted variance approved and posted as one balanced entry
 *   4. مناقلة — send (بضاعة تحت التحويل) → receive (عودة للمخزون)
 *   5. الرصيد السالب — an issue beyond the balance is refused, then forced
 *   6. حد الطلب — an item drained below its minimum is listed with its shortage
 *   7. وحدات القياس — a document written in boxes moves pieces
 *   8. الباركود — a label resolves to an item, a unit and a factor
 *   9. تواريخ الصلاحية — a lot inside the horizon is reported, one outside is not
 *   10. بضاعة في الطريق — a half-received transfer is listed, then closed
 *   11. بطاقة الصنف — the item card's running balance agrees with the balance table
 *   12. مكوّنات الصنف — a recipe fills a production order and is consumed by it
 *   13. دورة الأرقام التسلسلية — generated, reserved, sold, returned, withdrawn
 *   14. ترويسة أمر الإنتاج — رقم المرجع · تاريخ المرجع · الوحدة on a real build
 *   15. الدفعة على سطر المستند — رقم الدفعة يُنشئ الدفعة، والتاريخ المخالف يُرفض
 *
 * Every step asserts the *ledger*, not just the stock level: a stock document that
 * moves quantity without a journal is the desktop bug this phase exists to remove.
 *
 * Usage: node scripts/verify-inventory.mjs
 */
import { loadEnvFiles } from './dotenv.mjs';

loadEnvFiles();

const base = process.env.API_BASE ?? 'http://127.0.0.1:3000/api/v1';
const tenantCode = process.env.VERIFY_TENANT ?? 'demo';
const email = process.env.VERIFY_EMAIL ?? 'owner@demo.test';
const password = process.env.DEMO_OWNER_PASSWORD ?? '';

const money = (value) => Number(value).toFixed(4);
let failures = 0;

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function call(method, path, token, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error(
      `${method} ${path} → ${response.status} ${parsed.code ?? ''} ${parsed.detail ?? parsed.message ?? ''}`,
    );
    error.status = response.status;
    error.code = parsed.code;
    throw error;
  }
  return parsed.data ?? parsed;
}

const login = async () => {
  const data = await call('post', '/auth/login', undefined, { tenantCode, email, password });
  return data.accessToken ?? data.access_token ?? data.token;
};

const token = await login();
console.log(`✔ logged in to ${tenantCode} as ${email}\n`);

// ---------------------------------------------------------------- reference data
const branches = await call('get', '/branches', token);
const branchId = branches[0].id;
const warehouses =
  (await call('get', '/warehouses', token)).data ?? (await call('get', '/warehouses', token));
const warehouseRows = Array.isArray(warehouses) ? warehouses : warehouses.data;
let warehouseId = warehouseRows[0].id;
if (warehouseRows.length < 2) {
  const second = await call('post', '/warehouses', token, { branchId, code: 'WH2', name: 'مستودع ثانٍ' });
  warehouseRows.push(second);
}
const secondWarehouseId = warehouseRows.find((row) => row.id !== warehouseId).id;

const categories = await call('get', '/organization/catalog/categories', token);
const units = await call('get', '/organization/catalog/units', token);
const stamp = Date.now().toString().slice(-6);
const today = new Date().toISOString().slice(0, 10);
const categoryId = categories[0].id;
const item = await call('post', '/organization/catalog/items', token, {
  sku: `SKU-INV-${stamp}`,
  nameAr: 'صنف اختبار المخزون',
  categoryId: categories[0].id,
  baseUnitId: units[0].id,
  kind: 'stock',
  purchasePrice: '30',
  minQty: '10',
});
const itemId = item.id;
console.log(`✔ item ${item.sku} in ${warehouseRows.length} warehouses\n`);

const profile = await call(
  'get',
  `/branch-posting-profiles/resolve?branchId=${branchId}&docType=stock_voucher`,
  token,
);
const mapping = profile.mapping ?? {};
for (const key of [
  'inventoryAccountId',
  'openingBalanceAccountId',
  'inventoryAdjustmentAccountId',
  'stockInTransitAccountId',
]) {
  check(`profile maps ${key}`, Boolean(mapping[key]), mapping[key]);
}
console.log('');

const levelOf = async (warehouse = warehouseId) => {
  const levels = await call('get', `/inventory/levels?warehouse_id=${warehouse}&item_id=${itemId}`, token);
  const rows = Array.isArray(levels) ? levels : levels.data;
  return Number(rows[0]?.quantity ?? 0);
};

const journalOf = async (match) => {
  const list = await call('get', '/journal-entries?limit=50', token);
  const entries = Array.isArray(list) ? list : list.data;
  const entry = entries.find((row) => (row.description ?? '').includes(match) && row.kind !== 'reversal');
  if (!entry) throw new Error(`journal entry not found: ${match}`);
  const detail = await call('get', `/journal-entries/${entry.id}`, token);
  return detail.lines ?? [];
};

const line = (lines, accountId) => lines.find((row) => row.accountId === accountId);

// ------------------------------------------------------------- 1. opening balance
console.log('1. بضاعة أول المدة');
const opening = await call('post', '/inventory/vouchers', token, {
  branchId,
  warehouseId,
  kind: 'opening',
  reason: 'رصيد افتتاحي',
  lines: [{ itemId, qty: '100', unitCost: '30' }],
});
check('opening voucher numbered', /^OP-\d{6}$/.test(opening.number), opening.number);
const openingPosted = await call('post', `/inventory/vouchers/${opening.id}/post`, token, {});
check(
  'opening posted',
  openingPosted.status === 'posted',
  `${openingPosted.number} @ ${money(openingPosted.totalCost)}`,
);
check('stock rose to 100', (await levelOf()) === 100, String(await levelOf()));
const openingLines = await journalOf(opening.number);
check(
  'المخزون debited 3000',
  money(line(openingLines, mapping.inventoryAccountId)?.debit ?? 0) === '3000.0000',
);
check(
  'بضاعة أول المدة credited 3000',
  money(line(openingLines, mapping.openingBalanceAccountId)?.credit ?? 0) === '3000.0000',
);
console.log('');

// ----------------------------------------------------------------- 2. stock issue
console.log('2. سند إخراج');
const issue = await call('post', '/inventory/vouchers', token, {
  branchId,
  warehouseId,
  kind: 'stock_out',
  reason: 'تالف',
  lines: [{ itemId, qty: '20' }],
});
check('issue voucher numbered', /^SOU-\d{6}$/.test(issue.number), issue.number);
const issuePosted = await call('post', `/inventory/vouchers/${issue.id}/post`, token, {});
check(
  'issue posted at average cost',
  money(issuePosted.totalCost) === '600.0000',
  money(issuePosted.totalCost),
);
check('stock fell to 80', (await levelOf()) === 80, String(await levelOf()));
const issueLines = await journalOf(issue.number);
check(
  'تسويات المخزون debited 600',
  money(line(issueLines, mapping.inventoryAdjustmentAccountId)?.debit ?? 0) === '600.0000',
);
check(
  'المخزون credited 600',
  money(line(issueLines, mapping.inventoryAccountId)?.credit ?? 0) === '600.0000',
);
try {
  await call('post', `/inventory/vouchers/${issue.id}/post`, token, {});
  check('second posting refused', false, 'expected 409');
} catch (error) {
  check('second posting refused', error.status === 409, `${error.status} ${error.code}`);
}
console.log('');

// ------------------------------------------------------------------- 3. counting
console.log('3. جرد وتسوية');
const count = await call('post', '/inventory/adjustments', token, {
  branchId,
  warehouseId,
  reason: 'جرد سنوي',
  lines: [{ itemId, countedQty: '75' }],
});
check('count numbered', /^ADJ-\d{6}$/.test(count.number), count.number);
try {
  await call('post', `/inventory/adjustments/${count.id}/post`, token, {});
  check('unapproved count refused', false, 'expected 422');
} catch (error) {
  check(
    'unapproved count refused',
    error.status === 422 && error.code === 'ADJUSTMENT_APPROVAL_REQUIRED',
    `${error.status} ${error.code}`,
  );
}
const countPosted = await call('post', `/inventory/adjustments/${count.id}/post`, token, { approved: true });
check('count posted', countPosted.status === 'posted');
check('stock corrected to 75', (await levelOf()) === 75, String(await levelOf()));
check('variance recorded', Number(countPosted.lines[0].varianceQty) === -5, countPosted.lines[0].varianceQty);
const countLines = await journalOf(count.number);
const countDebit = countLines.reduce((sum, row) => sum + Number(row.debit), 0);
const countCredit = countLines.reduce((sum, row) => sum + Number(row.credit), 0);
check(
  'variance entry balances',
  countDebit.toFixed(4) === countCredit.toFixed(4),
  `${money(countDebit)} / ${money(countCredit)}`,
);
console.log('');

// ------------------------------------------------------------------ 4. transfer
console.log('4. مناقلة');
const transfer = await call('post', '/inventory/transfers/draft', token, {
  branchId,
  fromWarehouseId: warehouseId,
  toWarehouseId: secondWarehouseId,
  lines: [{ itemId, qty: '25' }],
});
check('transfer numbered', /^TR-\d{6}$/.test(transfer.number), transfer.number);
const sent = await call('post', `/inventory/transfers/${transfer.id}/send`, token, {});
check('transfer sent', sent.status === 'in_transit', `${sent.status} value ${money(sent.value)}`);
check('source fell to 50', (await levelOf()) === 50, String(await levelOf()));
const sendLines = await journalOf(`مناقلة ${transfer.number} — إرسال`);
check(
  'بضاعة تحت التحويل debited',
  money(line(sendLines, mapping.stockInTransitAccountId)?.debit ?? 0) === money(sent.value),
);
check(
  'المخزون credited',
  money(line(sendLines, mapping.inventoryAccountId)?.credit ?? 0) === money(sent.value),
);
const received = await call('post', `/inventory/transfers/${transfer.id}/receive`, token, {
  received: [{ lineNo: 1, qty: '25' }],
});
check('transfer received', received.status === 'received', received.status);
check(
  'destination holds 25',
  (await levelOf(secondWarehouseId)) === 25,
  String(await levelOf(secondWarehouseId)),
);
const receiveLines = await journalOf(`مناقلة ${transfer.number} — استلام`);
check(
  'المخزون debited on receipt',
  money(line(receiveLines, mapping.inventoryAccountId)?.debit ?? 0) === money(sent.value),
);
check(
  'بضاعة تحت التحويل cleared',
  money(line(receiveLines, mapping.stockInTransitAccountId)?.credit ?? 0) === money(sent.value),
);
console.log('');

// ------------------------------------------------------------- 5. negative stock
console.log('5. الرصيد السالب');
const overshoot = await call('post', '/inventory/vouchers', token, {
  branchId,
  warehouseId,
  kind: 'stock_out',
  reason: 'صرف فوق الرصيد',
  lines: [{ itemId, qty: '500' }],
});
try {
  await call('post', `/inventory/vouchers/${overshoot.id}/post`, token, {});
  check('overshoot refused', false, 'expected 422');
} catch (error) {
  check(
    'overshoot refused',
    error.status === 422 && error.code === 'STOCK_INSUFFICIENT',
    `${error.status} ${error.code}`,
  );
}
const forced = await call('post', `/inventory/vouchers/${overshoot.id}/post`, token, { allowNegative: true });
check('overshoot allowed with the override', forced.status === 'posted', `stock ${await levelOf()}`);
const voided = await call('post', `/inventory/vouchers/${overshoot.id}/void`, token, {
  reason: 'تصحيح اختبار',
});
check(
  'void rolls the stock back',
  voided.status === 'voided' && (await levelOf()) === 50,
  String(await levelOf()),
);
console.log('');

console.log('6. حد الطلب');
const healthy = await call('get', `/inventory/below-minimum?warehouse_id=${warehouseId}`, token);
check(
  'reorder report ignores a healthy item',
  !healthy.some((row) => row.itemId === itemId),
  `${healthy.length} row(s)`,
);
const drain = await call('post', '/inventory/vouchers', token, {
  branchId,
  warehouseId,
  kind: 'stock_out',
  reason: 'صرف حتى حد الطلب',
  lines: [{ itemId, qty: '45' }],
});
await call('post', `/inventory/vouchers/${drain.id}/post`, token, {});
const reorder = await call('get', `/inventory/below-minimum?warehouse_id=${warehouseId}`, token);
const shortRow = reorder.find((row) => row.itemId === itemId);
check(
  'reorder report lists the item under its minimum',
  Boolean(shortRow),
  shortRow ? ` shortage ${shortRow.shortage}` : `${reorder.length} row(s)`,
);
check(
  'shortage equals min − on hand',
  shortRow ? Number(shortRow.shortage) === 5 : false,
  shortRow?.shortage ?? '',
);

// ── 7. وحدات القياس المتعددة ────────────────────────────────────────────────
// The desktop stored `ItemUnits.perc` and multiplied every quantity by it
// (`ItemPrimaryQnty = ItemQuantity * UnitEquality`). The cloud does the same: a
// document counts cartons, the ledger stores pieces.
console.log('');
console.log('7. وحدات القياس المتعددة');
const packUnit = await call('post', '/organization/catalog/units', token, {
  code: `BOX${stamp}`,
  nameAr: 'علبة',
});
await call('post', `/organization/catalog/items/${itemId}/units`, token, {
  unitId: packUnit.id,
  ratio: '12',
  isDefaultSale: true,
});
const unitRows = await call('get', `/organization/catalog/items/${itemId}/units`, token);
check(
  'the box is listed with its factor',
  unitRows.some((row) => row.unitId === packUnit.id && Number(row.ratio) === 12),
  `${unitRows.length} unit(s)`,
);
check('the base unit is still 1:1', Number(unitRows[0].ratio) === 1, unitRows[0]?.ratio ?? '');
try {
  await call('post', `/organization/catalog/items/${itemId}/units`, token, {
    unitId: item.baseUnitId,
    ratio: '6',
  });
  check('the base unit cannot be re-scaled', false, 'expected 422');
} catch (error) {
  check(
    'the base unit cannot be re-scaled',
    error.status === 422 && error.code === 'CATALOG_UNIT_RATIO_INVALID',
    `${error.status} ${error.code}`,
  );
}

const levelBeforeBoxes = Number(await levelOf());
const boxReceipt = await call('post', '/inventory/vouchers', token, {
  branchId,
  warehouseId,
  kind: 'stock_in',
  reason: 'استلام بالعلب',
  lines: [{ itemId, qty: '2', unitId: packUnit.id, unitCost: '120' }],
});
await call('post', `/inventory/vouchers/${boxReceipt.id}/post`, token, {});
check(
  '2 boxes × 12 move 24 base units',
  Number(await levelOf()) === levelBeforeBoxes + 24,
  `${levelBeforeBoxes} → ${await levelOf()}`,
);
const boxValue = await call('get', `/inventory/vouchers/${boxReceipt.id}`, token);
check('the line is worth 2 × 120, not 24 × 120', Number(boxValue.totalCost) === 240, boxValue.totalCost);
const boxMovements = await call('get', `/inventory/movements?item_id=${itemId}`, token);
const boxMovement = boxMovements.find((row) => row.docId === boxReceipt.id);
check(
  'the movement keeps the unit it was counted in',
  Number(boxMovement?.qty) === 2 &&
    Number(boxMovement?.baseQty) === 24 &&
    Number(boxMovement?.factor) === 12 &&
    boxMovement?.unitId === packUnit.id,
  `${boxMovement?.qty} ${boxMovement?.unitId ?? ''} → ${boxMovement?.baseQty} base`,
);

// ── 8. الباركود ────────────────────────────────────────────────────────────
console.log('');
console.log('8. الباركود المتعدد');
const label = `BOX-${stamp}`;
await call('post', `/organization/catalog/items/${itemId}/barcodes`, token, {
  barcode: label,
  unitId: packUnit.id,
});
const scanned = await call('get', `/inventory/barcode/${label}`, token);
check(
  'a scan answers the item, the unit and the factor',
  scanned.itemId === itemId && scanned.unitId === packUnit.id && Number(scanned.factor) === 12,
  `${scanned.matchedBy} ×${scanned.factor}`,
);
try {
  await call('get', `/inventory/barcode/NOPE-${stamp}`, token);
  check('an unknown label is a 404', false, 'expected 404');
} catch (error) {
  check(
    'an unknown label is a 404',
    error.status === 404 && error.code === 'BARCODE_NOT_FOUND',
    `${error.status} ${error.code}`,
  );
}
const secondItem = await call('post', '/organization/catalog/items', token, {
  sku: `SKU2-${stamp}`,
  nameAr: 'صنف ثانٍ',
  categoryId,
  baseUnitId: item.baseUnitId,
});
try {
  await call('post', `/organization/catalog/items/${secondItem.id}/barcodes`, token, { barcode: label });
  check('one label cannot belong to two items', false, 'expected 409');
} catch (error) {
  check(
    'one label cannot belong to two items',
    error.status === 409 && error.code === 'CATALOG_BARCODE_TAKEN',
    `${error.status} ${error.code}`,
  );
}
const strayUnit = await call('post', '/inventory/vouchers', token, {
  branchId,
  warehouseId,
  kind: 'stock_out',
  reason: 'وحدة غير معرّفة على الصنف',
  lines: [{ itemId: secondItem.id, qty: '1', unitId: packUnit.id }],
});
try {
  await call('post', `/inventory/vouchers/${strayUnit.id}/post`, token, {});
  check('an undefined unit cannot be posted', false, 'expected 422');
} catch (error) {
  check(
    'an undefined unit cannot be posted',
    error.status === 422 && error.code === 'INVENTORY_UNIT_NOT_ALLOWED',
    `${error.status} ${error.code}`,
  );
}

// ── 9. تواريخ الصلاحية ─────────────────────────────────────────────────────
console.log('');
console.log('9. تواريخ الصلاحية');
const soon = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
const later = new Date(Date.now() + 400 * 86_400_000).toISOString().slice(0, 10);
await call('post', '/inventory/lots', token, { itemId, lotNo: `LOT-SOON-${stamp}`, expiryDate: soon });
await call('post', '/inventory/lots', token, { itemId, lotNo: `LOT-LATER-${stamp}`, expiryDate: later });
const expiring = await call('get', '/inventory/expiry?days=30', token);
const soonRow = expiring.find((row) => row.lotNo === `LOT-SOON-${stamp}`);
check(
  'a lot inside the horizon is reported',
  Boolean(soonRow) && soonRow.daysLeft > 0 && soonRow.daysLeft <= 10,
  soonRow ? `${soonRow.lotNo} in ${soonRow.daysLeft} day(s)` : `${expiring.length} row(s)`,
);
check(
  'a lot beyond the horizon is not',
  !expiring.some((row) => row.lotNo === `LOT-LATER-${stamp}`),
  `${expiring.length} row(s)`,
);

// ── 10. بضاعة في الطريق وإقفال المناقلة ─────────────────────────────────────
// A transfer that is sent but never fully received used to stay open for ever: the
// source warehouse had already lost the goods and بضاعة تحت التحويل kept a balance
// nobody could explain. Closure settles the remainder — home, or written off.
console.log('');
console.log('10. بضاعة في الطريق');
const shipItem = await call('post', '/organization/catalog/items', token, {
  sku: `SKU-SHIP-${stamp}`,
  nameAr: 'صنف مناقلة',
  categoryId,
  baseUnitId: item.baseUnitId,
});
const restock = await call('post', '/inventory/vouchers', token, {
  branchId,
  warehouseId,
  kind: 'stock_in',
  reason: 'تمويل للمناقلة',
  lines: [{ itemId: shipItem.id, qty: '100', unitCost: '10' }],
});
await call('post', `/inventory/vouchers/${restock.id}/post`, token, {});
const shipDraft = await call('post', '/inventory/transfers/draft', token, {
  branchId,
  fromWarehouseId: warehouseId,
  toWarehouseId: secondWarehouseId,
  lines: [{ itemId: shipItem.id, qty: '30', unitCost: '10' }],
});
await call('post', `/inventory/transfers/${shipDraft.id}/send`, token, {});
await call('post', `/inventory/transfers/${shipDraft.id}/receive`, token, {
  received: [{ lineNo: 1, qty: '12' }],
});
const transit = await call('get', `/inventory/in-transit?warehouse_id=${warehouseId}`, token);
const transitRow = transit.find((row) => row.transferId === shipDraft.id);
check(
  'the outstanding 18 are listed as in transit',
  Boolean(transitRow) && Number(transitRow.qty) === 18,
  transitRow ? `${transitRow.number} — ${transitRow.qty} in transit` : `${transit.length} row(s)`,
);
check('the transit value is carried too', Number(transitRow?.value) === 180, transitRow?.value ?? '');

const closed = await call('post', `/inventory/transfers/${shipDraft.id}/close`, token, {
  mode: 'return',
  reason: 'رفض الاستلام',
});
check(
  'the transfer closes as a return',
  closed.status === 'closed' && closed.mode === 'return',
  `${closed.status}/${closed.mode}`,
);
check('the closure posts a journal entry', Boolean(closed.journalEntryId), String(closed.journalEntryId));
const closedDetail = await call('get', `/inventory/transfers/${shipDraft.id}`, token);
check(
  'the return is not counted as a receipt',
  Number(closedDetail.lines[0].receivedQty) === 12 && Number(closedDetail.lines[0].closedQty) === 18,
  `received ${closedDetail.lines[0].receivedQty}, closed ${closedDetail.lines[0].closedQty}`,
);
const afterClosure = await call('get', `/inventory/in-transit?warehouse_id=${warehouseId}`, token);
check(
  'nothing of it is in transit any more',
  !afterClosure.some((row) => row.transferId === shipDraft.id),
  `${afterClosure.length} row(s)`,
);

// A second transfer ends the other way: the goods are gone, so the transit asset is
// written off and no stock moves anywhere.
const lostDraft = await call('post', '/inventory/transfers/draft', token, {
  branchId,
  fromWarehouseId: warehouseId,
  toWarehouseId: secondWarehouseId,
  lines: [{ itemId: shipItem.id, qty: '5', unitCost: '10' }],
});
await call('post', `/inventory/transfers/${lostDraft.id}/send`, token, {});
const levelsBefore = await call(
  'get',
  `/inventory/levels?warehouse_id=${secondWarehouseId}&item_id=${shipItem.id}`,
  token,
);
const lost = await call('post', `/inventory/transfers/${lostDraft.id}/close`, token, {
  mode: 'shortage',
  reason: 'تلف أثناء النقل',
});
check(
  'a shortage closes without returning stock',
  lost.mode === 'shortage' && Number(lost.returnedQty) === 0,
  lost.mode,
);
const levelsAfter = await call(
  'get',
  `/inventory/levels?warehouse_id=${secondWarehouseId}&item_id=${shipItem.id}`,
  token,
);
check(
  'the destination is untouched by a write-off',
  Number(levelsAfter[0]?.quantity ?? 0) === Number(levelsBefore[0]?.quantity ?? 0),
  `${levelsBefore[0]?.quantity ?? 0} → ${levelsAfter[0]?.quantity ?? 0}`,
);
try {
  await call('post', `/inventory/transfers/${lostDraft.id}/close`, token, { mode: 'shortage' });
  check('closing twice is refused', false, 'expected 409');
} catch (error) {
  check(
    'closing twice is refused',
    error.status === 409 && error.code === 'TRANSFER_ALREADY_CLOSED',
    `${error.status} ${error.code}`,
  );
}

// ── 11. بطاقة الصنف ─────────────────────────────────────────────────────────
// The desktop read this from `Inventorybalance()` and `TotalItemStock(branch, date)`:
// opening, every movement with its running balance, and a closing that has to agree
// with the balance table.
console.log('');
console.log('11. بطاقة الصنف');
const cardItem = await call('post', '/organization/catalog/items', token, {
  sku: `SKU-CARD-${stamp}`,
  nameAr: 'صنف بطاقة',
  categoryId,
  baseUnitId: item.baseUnitId,
});
const first = await call('post', '/inventory/vouchers', token, {
  branchId,
  warehouseId,
  kind: 'stock_in',
  reason: 'وارد أول',
  lines: [{ itemId: cardItem.id, qty: '10', unitCost: '20' }],
});
await call('post', `/inventory/vouchers/${first.id}/post`, token, {});
const second = await call('post', '/inventory/vouchers', token, {
  branchId,
  warehouseId,
  kind: 'stock_in',
  reason: 'وارد ثانٍ',
  lines: [{ itemId: cardItem.id, qty: '4', unitCost: '25' }],
});
await call('post', `/inventory/vouchers/${second.id}/post`, token, {});
const cardIssue = await call('post', '/inventory/vouchers', token, {
  branchId,
  warehouseId,
  kind: 'stock_out',
  reason: 'صرف',
  lines: [{ itemId: cardItem.id, qty: '5' }],
});
await call('post', `/inventory/vouchers/${cardIssue.id}/post`, token, {});

const card = await call(
  'get',
  `/inventory/item-card?item_id=${cardItem.id}&warehouse_id=${warehouseId}`,
  token,
);
check(
  'opening + in − out = closing',
  Number(card.opening.quantity) + Number(card.totals.inQty) - Number(card.totals.outQty) ===
    Number(card.closing.quantity),
  `${card.opening.quantity} + ${card.totals.inQty} − ${card.totals.outQty} = ${card.closing.quantity}`,
);
const cardLevels = await call(
  'get',
  `/inventory/levels?warehouse_id=${warehouseId}&item_id=${cardItem.id}`,
  token,
);
check(
  'the closing agrees with the balance table',
  Number(card.closing.quantity) === Number(cardLevels[0]?.quantity ?? 0),
  `card ${card.closing.quantity} vs balance ${cardLevels[0]?.quantity ?? 0}`,
);
check(
  'the card is valued, not only counted',
  Number(card.totals.inValue) === 300 && Number(card.closing.value) > 0,
  `in ${card.totals.inValue}, closing ${card.closing.value}`,
);
const running = card.rows.map((row) => Number(row.balanceQty));
check(
  'every row carries its own running balance',
  running.length === 3 && running[running.length - 1] === Number(card.closing.quantity),
  running.join(' → '),
);

// ── 12. مكوّنات الصنف (BOM) ──────────────────────────────────────────────────
// The desktop kept this in `ItemComponents`, filled `frmProductionOrder`'s grid from
// it in `LoadComponent()`, and scaled every line by `Qty = qty × BaseQty × UnitEquality`
// (frmProductionOrder.xaml.cs:567-570). Nothing is typed on the order here: the card's
// recipe is the only input, and the warehouse has to end up short by exactly that.
console.log('');
console.log('12. مكوّنات الصنف');
const bomPart = await call('post', '/organization/catalog/items', token, {
  sku: `SKU-PRT-${stamp}`,
  nameAr: 'مكوّن تجميع',
  categoryId,
  baseUnitId: item.baseUnitId,
  purchasePrice: '5',
});
const bomAssembly = await call('post', '/organization/catalog/items', token, {
  sku: `SKU-ASM-${stamp}`,
  nameAr: 'صنف مجمَّع',
  categoryId,
  baseUnitId: item.baseUnitId,
  kind: 'stock',
});
const partStock = await call('post', '/inventory/vouchers', token, {
  branchId,
  warehouseId,
  kind: 'stock_in',
  reason: 'تغذية المكوّنات',
  lines: [{ itemId: bomPart.id, qty: '40', unitCost: '5' }],
});
await call('post', `/inventory/vouchers/${partStock.id}/post`, token, {});

const savedComponent = await call('post', `/organization/catalog/items/${bomAssembly.id}/components`, token, {
  componentItemId: bomPart.id,
  qty: '3',
  warehouseId,
});
check(
  'the component is stored on the card',
  savedComponent.componentItemId === bomPart.id && Number(savedComponent.qty) === 3,
  `${savedComponent.sku} × ${savedComponent.qty} ${savedComponent.unitCode}`,
);
const listed = await call('get', `/organization/catalog/items/${bomAssembly.id}/components`, token);
check('the card lists its recipe', listed.length === 1 && listed[0].sku === bomPart.sku, listed.length);
try {
  await call('post', `/organization/catalog/items/${bomAssembly.id}/components`, token, {
    componentItemId: bomAssembly.id,
    qty: '1',
  });
  check('an item cannot be its own component', false, 'expected 422');
} catch (error) {
  check(
    'an item cannot be its own component',
    error.status === 422 && error.code === 'CATALOG_COMPONENT_SELF',
    `${error.status} ${error.code}`,
  );
}
try {
  await call('post', `/organization/catalog/items/${bomPart.id}/components`, token, {
    componentItemId: bomAssembly.id,
    qty: '1',
  });
  check('a cycle is refused', false, 'expected 409');
} catch (error) {
  check('a cycle is refused', error.status === 409 && error.code === 'CATALOG_COMPONENT_CYCLE', `${error.status} ${error.code}`);
}

const partLevel = async () => {
  const rows = await call('get', `/inventory/levels?warehouse_id=${warehouseId}&item_id=${bomPart.id}`, token);
  return Number(rows[0]?.quantity ?? 0);
};
const assemblyLevel = async () => {
  const rows = await call('get', `/inventory/levels?warehouse_id=${warehouseId}&item_id=${bomAssembly.id}`, token);
  return Number(rows[0]?.quantity ?? 0);
};

// No components on the order: the recipe has to fill it, 3 per unit × 4 built = 12.
const bomOrder = await call('post', '/inventory/production-orders', token, {
  warehouseId,
  outputItemId: bomAssembly.id,
  outputQty: '4',
});
const bomLines = bomOrder.components ?? [];
check(
  'the recipe filled the order',
  bomLines.length === 1 && Number(bomLines[0].qty) === 12,
  `${bomLines[0]?.qty ?? 0} of ${bomLines.length} line(s)`,
);
const partBefore = await partLevel();
const bomDone = await call('post', `/inventory/production-orders/${bomOrder.id}/complete`, token, {});
check('the order is completed', bomDone.status === 'completed', bomDone.number);
check(
  'the component left the warehouse by the scaled quantity',
  partBefore - (await partLevel()) === 12,
  `${partBefore} → ${await partLevel()}`,
);
check('the assembly came in by the built quantity', (await assemblyLevel()) === 4, String(await assemblyLevel()));
check(
  'the assembly is valued at exactly what left it',
  money(bomDone.componentCost) === money(60) && money(bomDone.unitCost) === money(15),
  `${money(bomDone.componentCost)} / 4 = ${money(bomDone.unitCost)}`,
);

const noRecipe = await call('post', '/organization/catalog/items', token, {
  sku: `SKU-NOR-${stamp}`,
  nameAr: 'صنف بلا تركيبة',
  categoryId,
  baseUnitId: item.baseUnitId,
});
try {
  await call('post', '/inventory/production-orders', token, {
    warehouseId,
    outputItemId: noRecipe.id,
    outputQty: '1',
  });
  check('an order with neither a recipe nor typed components is refused', false, 'expected 422');
} catch (error) {
  check(
    'an order with neither a recipe nor typed components is refused',
    error.status === 422 && error.code === 'PRODUCTION_COMPONENTS_REQUIRED',
    `${error.status} ${error.code}`,
  );
}

// ── 13. دورة الأرقام التسلسلية ───────────────────────────────────────────────
// `frmItemSerialNo.xaml` split the shelf in two — `📋 الأرقام المتاحة` and
// `📤 الأرقام المباعة` — generated numbers off a prefix with `⚙️ توليد`, and took a
// number back out with `🗑️`. The cloud had the state machine all along; this walks it
// end to end, then puts the order's own header (📄 رقم المرجع · 📅 تاريخ المرجع ·
// 📐 الوحدة) on a build and checks the output lands in the unit it was counted in.
console.log('');
console.log('13. دورة الأرقام التسلسلية');
const serialItem = await call('post', '/organization/catalog/items', token, {
  sku: `SKU-SER-${stamp}`,
  nameAr: 'صنف مُرقّم',
  categoryId,
  baseUnitId: item.baseUnitId,
});
// The prefix carries the run's stamp: a serial number is unique per tenant, and the
// script has to stay re-runnable.
const serialPrefix = `SN${stamp}-`;
const generated = await call('post', '/inventory/serials/generate', token, {
  itemId: serialItem.id,
  prefix: serialPrefix,
  startAt: 1,
  count: 5,
  warehouseId,
});
check(
  '⚙️ توليد makes a batch off one prefix',
  generated.count === 5 &&
    generated.serialNos[0] === `${serialPrefix}1` &&
    generated.serialNos[4] === `${serialPrefix}5`,
  generated.serialNos.join(', '),
);
try {
  await call('post', '/inventory/serials/generate', token, {
    itemId: serialItem.id,
    prefix: serialPrefix,
    startAt: 3,
    count: 3,
    warehouseId,
  });
  check('a batch that clashes with a live number is refused', false, 'expected 409');
} catch (error) {
  check(
    'a batch that clashes with a live number is refused',
    error.status === 409 && error.code === 'SERIAL_DUPLICATE',
    `${error.status} ${error.code}`,
  );
}
const found = await call('get', `/inventory/serials?item_id=${serialItem.id}&q=${serialPrefix}1`, token);
check(
  'a number can be found by searching for it',
  found.length === 1 && found[0].serialNo === `${serialPrefix}1`,
  found.map((row) => row.serialNo).join(', '),
);
const serialRows = await call('get', `/inventory/serials?item_id=${serialItem.id}`, token);
check('the whole batch is on the shelf', serialRows.length === 5, `${serialRows.length} numbers`);

const firstSerial = serialRows[0];
const reserved = await call('post', '/inventory/serials/reserve', token, { serialIds: [firstSerial.id] });
check('حجز moves it off the shelf', reserved.status === 'reserved', reserved.status);
try {
  await call('post', '/inventory/serials/reserve', token, { serialIds: [firstSerial.id] });
  check('reserving twice is refused', false, 'expected 422');
} catch (error) {
  check(
    'reserving twice is refused',
    error.status === 422 && error.code === 'SERIAL_INVALID_STATE',
    `${error.status} ${error.code}`,
  );
}
const released = await call('post', '/inventory/serials/release', token, { serialIds: [firstSerial.id] });
check('إفراج puts it back', released.status === 'available', released.status);

const toSell = serialRows.slice(0, 3).map((row) => row.id);
await call('post', '/inventory/serials/consume', token, { serialIds: toSell });
const sold = await call('get', `/inventory/serials?item_id=${serialItem.id}&status=sold`, token);
check('📤 الأرقام المباعة holds what left', sold.length === 3, `${sold.length} sold`);
const broughtBack = await call('post', '/inventory/serials/return', token, { serialIds: [toSell[0]] });
check('إرجاع brings a sold number home', broughtBack.status === 'available', broughtBack.status);

try {
  await call('delete', `/inventory/serials/${toSell[1]}`, token);
  check('a sold number cannot be withdrawn', false, 'expected 422');
} catch (error) {
  check(
    'a sold number cannot be withdrawn',
    error.status === 422 && error.code === 'SERIAL_INVALID_STATE',
    `${error.status} ${error.code}`,
  );
}
const withdrawn = serialRows[4].id;
await call('delete', `/inventory/serials/${withdrawn}`, token);
const afterDelete = await call('get', `/inventory/serials?item_id=${serialItem.id}`, token);
check(
  '🗑️ an available number can be withdrawn',
  afterDelete.length === 4 && !afterDelete.some((row) => row.id === withdrawn),
  `${afterDelete.length} left`,
);

// ── 14. ترويسة أمر الإنتاج: رقم المرجع · تاريخ المرجع · الوحدة ─────────────────
console.log('');
console.log('14. ترويسة أمر الإنتاج');
const refUnit = await call('post', '/organization/catalog/units', token, { code: `BX${stamp}`, nameAr: 'علبة' });
await call('post', `/organization/catalog/items/${serialItem.id}/units`, token, {
  unitId: refUnit.id,
  ratio: '6',
});
const packPart = await call('post', '/organization/catalog/items', token, {
  sku: `SKU-BXP-${stamp}`,
  nameAr: 'مكوّن الصندقة',
  categoryId,
  baseUnitId: item.baseUnitId,
});
const partFeed = await call('post', '/inventory/vouchers', token, {
  branchId,
  warehouseId,
  kind: 'stock_in',
  reason: 'تغذية المكوّن',
  lines: [{ itemId: packPart.id, qty: '60', unitCost: '10' }],
});
await call('post', `/inventory/vouchers/${partFeed.id}/post`, token, {});

const refOrder = await call('post', '/inventory/production-orders', token, {
  warehouseId,
  outputItemId: serialItem.id,
  outputQty: '2',
  unitId: refUnit.id,
  referenceNo: 'SO-4417',
  referenceDate: today,
  components: [{ itemId: packPart.id, qty: '4' }],
});
check(
  'the order remembers its reference',
  refOrder.referenceNo === 'SO-4417' && refOrder.referenceDate === today,
  `${refOrder.referenceNo} — ${refOrder.referenceDate}`,
);
check('the order remembers the unit', refOrder.unitId === refUnit.id, refOrder.unitId);
const refDone = await call('post', `/inventory/production-orders/${refOrder.id}/complete`, token, {});
check('the order is completed', refDone.status === 'completed', refDone.number);
const packLevels = await call(
  'get',
  `/inventory/levels?warehouse_id=${warehouseId}&item_id=${serialItem.id}`,
  token,
);
check(
  '2 علب × 6 = 12 pieces came in, not 2',
  Number(packLevels[0]?.quantity ?? 0) === 12,
  String(packLevels[0]?.quantity ?? 0),
);

// ── 15. الرقم التسلسلي على سطر المستند ───────────────────────────────────────
// `Class/InvoiceOper.cs:1635` carries `ItemSerialNo` on the document line, and
// `frmItemSerialNo.xaml.cs:524` reads a number's history back out of it. Until now the
// cloud had a serial's state and no idea which document moved it: a receipt invented no
// pieces, and a sold number could not be traced to the voucher that sold it. This walks
// one number from the receipt that created it, through the issue that sold it, to the
// void that brought it home.
console.log('');
console.log('15. الرقم التسلسلي على سطر المستند');
const tracedItem = await call('post', '/organization/catalog/items', token, {
  sku: `SKU-TRC-${stamp}`,
  nameAr: 'صنف مُرقّم بالسند',
  categoryId,
  baseUnitId: item.baseUnitId,
});
const tracePrefix = `TR${stamp}-`;

const inVoucher = await call('post', '/inventory/vouchers', token, {
  branchId,
  warehouseId,
  kind: 'stock_in',
  reason: 'إدخال أجهزة مُرقّمة',
  lines: [{ itemId: tracedItem.id, qty: '3', unitCost: '100', serialNos: [`${tracePrefix}1`, `${tracePrefix}2`, `${tracePrefix}3`] }],
});
check(
  'the draft remembers the numbers before the stock arrives',
  inVoucher.lines[0].serialNos.length === 3,
  inVoucher.lines[0].serialNos.join(', '),
);
await call('post', `/inventory/vouchers/${inVoucher.id}/post`, token, {});
const createdSerials = await call('get', `/inventory/serials?item_id=${tracedItem.id}`, token);
check(
  'إدخال brings three pieces in, one number each',
  createdSerials.length === 3 && createdSerials.every((row) => row.status === 'available'),
  createdSerials.map((row) => `${row.serialNo}:${row.status}`).join(' · '),
);

// 3 pieces, 2 numbers: the count is the whole point of serialising the item.
const shortVoucher = await call('post', '/inventory/vouchers', token, {
  branchId,
  warehouseId,
  kind: 'stock_in',
  reason: 'إدخال ناقص الأرقام',
  lines: [{ itemId: tracedItem.id, qty: '3', unitCost: '100', serialNos: [`${tracePrefix}7`, `${tracePrefix}8`] }],
});
try {
  await call('post', `/inventory/vouchers/${shortVoucher.id}/post`, token, {});
  check('3 pieces with 2 numbers is refused', false, 'expected 422');
} catch (error) {
  check(
    '3 pieces with 2 numbers is refused',
    error.status === 422 && error.code === 'SERIAL_COUNT_MISMATCH',
    `${error.status} ${error.code}`,
  );
}
const untouched = await call('get', `/inventory/vouchers/${shortVoucher.id}`, token);
check('a refused document stays a draft and invents nothing', untouched.status === 'draft', untouched.status);

const outVoucher = await call('post', '/inventory/vouchers', token, {
  branchId,
  warehouseId,
  kind: 'stock_out',
  reason: 'صرف جهازين',
  lines: [{ itemId: tracedItem.id, qty: '2', serialNos: [`${tracePrefix}1`, `${tracePrefix}2`] }],
});
await call('post', `/inventory/vouchers/${outVoucher.id}/post`, token, {});
const afterIssue = await call('get', `/inventory/serials?item_id=${tracedItem.id}`, token);
const stateOf = (rows, serialNo) => rows.find((row) => row.serialNo === serialNo)?.status;
check(
  'إخراج sells exactly the numbers it names',
  stateOf(afterIssue, `${tracePrefix}1`) === 'sold' &&
    stateOf(afterIssue, `${tracePrefix}2`) === 'sold' &&
    stateOf(afterIssue, `${tracePrefix}3`) === 'available',
  afterIssue.map((row) => `${row.serialNo}:${row.status}`).join(' · '),
);

try {
  const twice = await call('post', '/inventory/vouchers', token, {
    branchId,
    warehouseId,
    kind: 'stock_out',
    reason: 'صرف رقم مباع',
    lines: [{ itemId: tracedItem.id, qty: '1', serialNos: [`${tracePrefix}1`] }],
  });
  await call('post', `/inventory/vouchers/${twice.id}/post`, token, {});
  check('selling the same number twice is refused', false, 'expected 422');
} catch (error) {
  check(
    'selling the same number twice is refused',
    error.status === 422 && error.code === 'SERIAL_INVALID_STATE',
    `${error.status} ${error.code}`,
  );
}

const tracedOne = afterIssue.find((row) => row.serialNo === `${tracePrefix}1`);
const trace = await call('get', `/inventory/serials/${tracedOne.id}/documents`, token);
check(
  'the number carries the documents that moved it',
  trace.documents.length === 2 && trace.documents.every((row) => row.docType === 'stock_voucher'),
  trace.documents.map((row) => row.docType).join(' → '),
);

// Voiding the receipt takes the pieces it invented back out; voiding the issue puts the
// piece it sold back on the shelf.
await call('post', `/inventory/vouchers/${outVoucher.id}/void`, token, { reason: 'تراجع عن الصرف' });
const afterVoid = await call('get', `/inventory/serials?item_id=${tracedItem.id}`, token);
check(
  'إلغاء الصرف يعيد الرقم إلى الرف',
  stateOf(afterVoid, `${tracePrefix}1`) === 'available' && stateOf(afterVoid, `${tracePrefix}2`) === 'available',
  afterVoid.map((row) => `${row.serialNo}:${row.status}`).join(' · '),
);
await call('post', `/inventory/vouchers/${inVoucher.id}/void`, token, { reason: 'خطأ في الإدخال' });
const afterBoth = await call('get', `/inventory/serials?item_id=${tracedItem.id}`, token);
check(
  'إلغاء الإدخال يمحو الأرقام التي أنشأها',
  afterBoth.length === 0,
  `${afterBoth.length} left`,
);

// A مناقلة moves pieces the source already owns: the numbers ride with the goods and
// only change warehouse, never leave the shelf for good.
const transferItem = await call('post', '/organization/catalog/items', token, {
  sku: `SKU-TRF-${stamp}`,
  nameAr: 'صنف مُرقّم للمناقلة',
  categoryId,
  baseUnitId: item.baseUnitId,
});
const trfPrefix = `TF${stamp}-`;
await call(
  'post',
  `/inventory/vouchers/${(await call('post', '/inventory/vouchers', token, {
    branchId,
    warehouseId,
    kind: 'stock_in',
    reason: 'تجهيز المناقلة',
    lines: [{ itemId: transferItem.id, qty: '2', unitCost: '80', serialNos: [`${trfPrefix}1`, `${trfPrefix}2`] }],
  })).id}/post`,
  token,
  {},
);
const dossier = await call('post', '/warehouses', token, { branchId, code: `WH-T-${stamp}`, name: 'مستودع المناقلة' });
const named = await call('post', '/inventory/transfers/draft', token, {
  branchId,
  fromWarehouseId: warehouseId,
  toWarehouseId: dossier.id,
  lines: [{ itemId: transferItem.id, qty: '1', serialNos: [`${trfPrefix}1`] }],
});
await call('post', `/inventory/transfers/${named.id}/send`, token, {});
const onRoad = await call('get', `/inventory/serials?item_id=${transferItem.id}`, token);
check(
  'المناقلة تحجز الرقم المسمّى ولا تبيعه',
  onRoad.find((row) => row.serialNo === `${trfPrefix}1`)?.status === 'reserved',
  onRoad.map((row) => `${row.serialNo}:${row.status}`).join(' · '),
);
await call('post', `/inventory/transfers/${named.id}/receive`, token, {
  received: [{ lineNo: 1, qty: '1' }],
});
const arrived = await call('get', `/inventory/serials?item_id=${transferItem.id}`, token);
const movedOne = arrived.find((row) => row.serialNo === `${trfPrefix}1`);
check(
  'الاستلام يعيده متاحاً في المستودع الجديد',
  movedOne?.status === 'available' && movedOne?.warehouseId === dossier.id,
  `${movedOne?.status} @ ${movedOne?.warehouseId === dossier.id ? 'الوجهة' : 'المصدر'}`,
);
const movedTrace = await call('get', `/inventory/serials/${movedOne.id}/documents`, token);
check(
  'المسار يذكر الرحلة كاملة: إدخال ← مناقلة ← استلام',
  movedTrace.documents.map((row) => row.docType).join(' → ') ===
    'stock_voucher → stock_transfer → stock_transfer_receipt',
  movedTrace.documents.map((row) => row.docType).join(' → '),
);

console.log('');
console.log('16. الدفعة على سطر المستند');

// --------------------------------------------------------------------- 16. الدفعة (R5)
//
// `Class/InvoiceOper.cs:1635` puts the batch on the line: a clerk writes the number and
// the two dates off the pack, and the document carries them. So the line must be able to
// *create* the batch, and a date that contradicts what is already recorded must be
// refused instead of quietly overwriting it.

const batchItem = await call('post', '/organization/catalog/items', token, {
  sku: `SKU-BAT-${stamp}`,
  nameAr: 'صنف مُتتبَّع بالدفعات',
  categoryId,
  baseUnitId: item.baseUnitId,
  trackLot: true,
});
const plainItem = await call('post', '/organization/catalog/items', token, {
  sku: `SKU-NOBAT-${stamp}`,
  nameAr: 'صنف بلا دفعات',
  categoryId,
  baseUnitId: item.baseUnitId,
  trackLot: false,
});
const batchNo = `B-${stamp}`;
// 📅 صنع قبل شهرين ووصل اليوم — والحقلان يجب أن يبقيا مختلفين.
const producedOn = new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10);

const batched = await call('post', '/inventory/vouchers', token, {
  branchId,
  warehouseId,
  kind: 'stock_in',
  reason: 'وارد دفعة',
  lines: [
    {
      itemId: batchItem.id,
      qty: '10',
      unitCost: '15',
      batchNo,
      productionDate: producedOn,
      expiryDate: `${new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10)}`,
    },
  ],
});
const batchedLine = batched.lines[0];
check(
  'السطر يحمل رقم الدفعة وتاريخيها كما كُتبا',
  batchedLine.batchNo === batchNo && batchedLine.productionDate === producedOn && Boolean(batchedLine.lotId),
  `${batchedLine.batchNo} · 📅 ${batchedLine.productionDate} · ⏳ ${batchedLine.expiryDate}`,
);
await call('post', `/inventory/vouchers/${batched.id}/post`, token, {});

const registered = await call('get', `/inventory/lots?item_id=${batchItem.id}&q=${batchNo}`, token);
check(
  'الرقم على السطر أنشأ الدفعة بتواريخها — لا شاشةٌ أخرى تُزار قبله',
  registered.length === 1 && registered[0].expiryDate === batchedLine.expiryDate,
  registered.map((row) => `${row.lotNo} · 📅 ${row.productionDate} · ⏳ ${row.expiryDate}`).join(' · '),
);
check(
  'تاريخ الإنتاج ليس تاريخ الاستلام',
  registered[0]?.productionDate === producedOn &&
    (registered[0]?.receivedAt ?? '').slice(0, 10) === today,
  `إنتاج ${registered[0]?.productionDate} · استلام ${(registered[0]?.receivedAt ?? '').slice(0, 10)}`,
);

const expiringNow = await call('get', '/inventory/expiry?days=30', token);
check(
  'تقرير الصلاحية يرى الدفعة التي وُلدت من السطر',
  expiringNow.some((row) => row.lotNo === batchNo && row.expiryDate === batchedLine.expiryDate),
  expiringNow.find((row) => row.lotNo === batchNo)?.expiryDate ?? 'غير موجودة',
);

// A second carton of the same batch, this time with only the number written on it.
const refilled = await call('post', '/inventory/vouchers', token, {
  branchId,
  warehouseId,
  kind: 'stock_in',
  reason: 'وارد نفس الدفعة',
  lines: [{ itemId: batchItem.id, qty: '4', unitCost: '15', batchNo }],
});
check(
  'سطرٌ يذكر الرقم وحده يأخذ تاريخ الدفعة ولا يمحوه',
  refilled.lines[0].lotId === batchedLine.lotId && refilled.lines[0].expiryDate === batchedLine.expiryDate,
  `${refilled.lines[0].lotId === batchedLine.lotId ? 'نفس الدفعة' : 'دفعة أخرى'} · ⏳ ${refilled.lines[0].expiryDate}`,
);

// …and a third that disagrees with what is recorded.
let clash;
try {
  await call('post', '/inventory/vouchers', token, {
    branchId,
    warehouseId,
    kind: 'stock_in',
    reason: 'وارد بتاريخ مخالف',
    lines: [{ itemId: batchItem.id, qty: '1', unitCost: '15', batchNo, expiryDate: '2030-01-01' }],
  });
} catch (error) {
  clash = error;
}
check(
  'تاريخٌ مخالف لدفعةٍ مسجَّلة يُرفض 409 بدل أن يُكتب تاريخان لدفعةٍ واحدة',
  clash?.status === 409 && clash?.code === 'LOT_EXPIRY_MISMATCH',
  `${clash?.status ?? 'بلا رفض'} ${clash?.code ?? ''}`,
);

let untracked;
try {
  await call('post', '/inventory/vouchers', token, {
    branchId,
    warehouseId,
    kind: 'stock_in',
    reason: 'دفعة على صنف لا يُتتبَّع بها',
    lines: [{ itemId: plainItem.id, qty: '1', unitCost: '5', batchNo: `N-${stamp}` }],
  });
} catch (error) {
  untracked = error;
}
check(
  'صنفٌ لا يُتتبَّع بالدفعات يرفض رقم الدفعة 422',
  untracked?.status === 422 && untracked?.code === 'LOT_NOT_TRACKED',
  `${untracked?.status ?? 'بلا رفض'} ${untracked?.code ?? ''}`,
);

// The same batch, moved: the line keeps the number and the movement reads `lot_id`.
const batchMove = await call('post', '/inventory/transfers/draft', token, {
  branchId,
  fromWarehouseId: warehouseId,
  toWarehouseId: secondWarehouseId,
  lines: [{ itemId: batchItem.id, qty: '2', batchNo }],
});
const batchMoveLine = batchMove.lines?.[0] ?? (await call('get', `/inventory/transfers/${batchMove.id}`, token)).lines[0];
check(
  'المناقلة تنقل الدفعة نفسها — رقمها على السطر و`lot_id` يقرؤه الدفتر',
  batchMoveLine.batchNo === batchNo && batchMoveLine.lotId === batchedLine.lotId,
  `${batchMoveLine.batchNo} · ${batchMoveLine.lotId === batchedLine.lotId ? 'نفس الدفعة' : 'دفعة أخرى'}`,
);

console.log(failures === 0 ? '\n✔ Phase 05 inventory documents verified' : `\n✗ ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
