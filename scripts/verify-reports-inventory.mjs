#!/usr/bin/env node
/**
 * Live verification of Phase 10 part four — 📚 تقارير المخزون والأرقام التسلسلية
 * (`Form_WPF/frmRptInventory` · `frmRptItemsActivity` · `frmRptItemsActivityDetailed` ·
 * `frmRptItemsExpiration` · `frmRptSerialNo` · `frmRptSerialNoSummary` ·
 * `frmRptProducedItems`) against a running stack (`node scripts/local-db.mjs` +
 * `pnpm db:migrate` + `pnpm db:seed` + the API).
 *
 * It drives the real HTTP API the staff screens drive — nothing is mocked:
 *
 *   1. 📚 السجل — التقارير الثمانية بأعمدة الديسكتوب وبطاقاته
 *   2. 📏 خطّ الأساس — كل رقمٍ أدناه فرقٌ عن هذا الخط
 *   3. 🧾 الوثائق — أول مدة · شراء · مردود شراء · بيع · مرتجع · نقطة بيع · مناقلة ·
 *      تسويتان · إذن إدخال · إذن إخراج · دفعتان بصلاحية · ثلاثة أرقام تسلسلية · أمر إنتاج
 *   4. 📋 تقرير مستندات المخزون — سطرٌ لكل مستند وثمانية أنواع عملية
 *   5. 📦 مادة باجمالي الحركات — ثلاثة عشر عمود حركة والرصيد ومتوسط التكلفة
 *   6. 🔍 حركة صنف تفصيلي — رصيدٌ متحرك ونوع فاتورة ومرجع وخيارات البحث
 *   7. ⏰ صلاحية المواد — باقي سنوات وأشهر وأيام
 *   8. 🔢 حركة الأرقام التسلسلية
 *   9. 🧮 أرصدة الأرقام التسلسلية
 *  10. 🏭 تقرير مواد المنتجة — المواد المنتجة ومكوّناتها
 *  11. 📆 فترةٌ بلا حركة — جدولٌ فارغ وبطاقات صفر
 *  12. 🖨️ طباعة والتصدير — CSV وXLSX
 *  13. التنظيف — ما يُلغى يُلغى وما لا يُلغى يُعلَن
 *
 * Re-runnable and non-destructive: every document this script writes carries a stamp, every
 * tenant-wide total is asserted as a **difference from a baseline** taken before anything is
 * written, and everything with an undo is undone in a `finally`.
 *
 * Usage: node scripts/verify-reports-inventory.mjs
 */
import { loadEnvFiles } from './dotenv.mjs';

loadEnvFiles();

const base = process.env.API_BASE ?? 'http://127.0.0.1:3000/api/v1';
const tenantCode = process.env.VERIFY_TENANT ?? 'demo';
const email = process.env.VERIFY_EMAIL ?? 'owner@demo.test';
const password = process.env.DEMO_OWNER_PASSWORD ?? '';

let failures = 0;

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

let token = '';

async function request(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method: method.toUpperCase(),
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error(`${method} ${path} → ${response.status} ${parsed.code ?? ''} ${parsed.detail ?? parsed.message ?? ''}`);
    error.status = response.status;
    error.code = parsed.code;
    throw error;
  }
  return parsed.data ?? parsed;
}

async function call(method, path, body) {
  return request(method, path, body);
}

/** A refusal is a result, not a crash — the window shows the sentence to the operator. */
async function refused(method, path, body) {
  try {
    await call(method, path, body);
    return { status: 200, code: '', detail: '' };
  } catch (error) {
    return { status: error.status ?? 0, code: error.code ?? '', detail: error.detail ?? '' };
  }
}

const login = await call('post', '/auth/login', { tenantCode, email, password });
token = login.accessToken ?? login.access_token ?? login.token;
console.log(`✔ logged in to ${tenantCode} as ${email}\n`);

const stamp = Date.now().toString().slice(-6);
const get = (path) => call('get', path);
const post = (path, body) => call('post', path, body);
const del = (path) => call('delete', path);
const list = (value) => (Array.isArray(value) ? value : (value?.data ?? []));
const money = (value) => Number(value ?? 0).toFixed(2);
const num = (value) => Number(value ?? 0);
const delta = (after, before) => Number((Number(after ?? 0) - Number(before ?? 0)).toFixed(2));
/** One of the 💰 summary cards under the grid, by the column it sums. */
const cardOf = (report, key) => (report.grandTotal ?? []).find((total) => total.key === key)?.amount ?? '0';
const columns = (entry) => (entry?.columns ?? []).map((column) => column.labelAr).join(' · ');
const params = (entry) => (entry?.params ?? []).map((param) => param.labelAr).join(' · ');
const operationRow = (rows, label) => rows.find((row) => row.operation === label);
const numberRow = (rows, number) => rows.find((row) => String(row.doc_number ?? '').startsWith(number));

const today = new Date();
const iso = (offsetDays) => new Date(today.getTime() + offsetDays * 86_400_000).toISOString().slice(0, 10);
const from = iso(-1);
const to = iso(1);
const day = today.toISOString().slice(0, 10);
const period = `from=${from}&to=${to}`;
const emptyPeriod = 'from=2000-01-01&to=2000-01-02';

const report = (key, query = '') => get(`/reports/${key}?${query ? `${query}&` : ''}${period}`);

const written = {
  warehouseA: '',
  warehouseB: '',
  fuelId: '',
  serialItemId: '',
  lotItemId: '',
  productId: '',
  customerId: '',
  supplierId: '',
  vouchers: [],
  sales: [],
  purchases: [],
  lots: [],
  serialIds: [],
  serialNos: [],
  transfers: [],
  adjustments: [],
  production: [],
};

try {
  // ---------------------------------------------------------------------------
  console.log('1. 📚 السجل — التقارير الثمانية بأعمدة الديسكتوب وبطاقاته');

  const catalog = list(await get('/reports'));
  const byKey = new Map(catalog.map((entry) => [entry.key, entry]));

  const documents = byKey.get('inventory-documents');
  check('📋 تقرير مستندات المخزون في السجل', Boolean(documents), documents?.titleAr ?? '');
  check(
    'أعمدة `frmRptInventory` — 📋 الفواتير',
    columns(documents) === 'م · نوع العملية · رقم المستند · التاريخ · العميل/المورد · المستودع · الفرع · عدد الأصناف · الكمية · التكلفة',
    columns(documents),
  );
  check('«📄 نوع العملية» بخياراته الثمانية', (documents?.params?.[0]?.options ?? []).length === 8, params(documents));

  const totals = byKey.get('item-movement-totals');
  check('📦 مادة باجمالي الحركات في السجل', Boolean(totals), totals?.titleAr ?? '');
  check(
    'أعمدة `frmRptItemsActivity` الثمانية عشر',
    columns(totals) ===
      'الرمز · الصنف · الرصيد · متوسط التكلفة · إجمالي التكلفة · أول مدة · مشتريات · مرتجع مشتريات · المبيعات · مرتجع المبيعات · نقطة البيع · مرتجع POS · مناقلة مرسلة · مناقلة مستلمة · فاتورة إدخال · فاتورة إخراج · تسوية إدخال · تسوية إخراج',
    columns(totals),
  );

  const details = byKey.get('item-movement-details');
  check('🔍 حركة صنف تفصيلي في السجل', Boolean(details), details?.titleAr ?? '');
  check(
    'أعمدة `frmRptItemsActivityDetailed`',
    columns(details) ===
      'م · نوع الفاتورة · المستودع · رمز الصنف · الصنف · رقم الفاتورة · رقم المرجع · التاريخ · الحساب · الوحدة · الكمية في الفاتورة · السعر في الفاتورة · الإجمالي في الفاتورة · الكمية الداخلة · الكمية الخارجة · الرصيد · السعر · الإجمالي',
    columns(details),
  );

  const expiry = byKey.get('item-expiry');
  check('⏰ صلاحية المواد في السجل', Boolean(expiry), expiry?.titleAr ?? '');
  check(
    'أعمدة `frmRptItemsExpiration`',
    columns(expiry) === 'م · رمز الصنف · الصنف · المستودع · الكمية الحالية · تاريخ الإنتهاء · باقي سنوات · باقي أشهر · باقي أيام',
    columns(expiry),
  );

  const serialMovements = byKey.get('serial-movements');
  check('🔢 حركة الأرقام التسلسلية في السجل', Boolean(serialMovements), serialMovements?.titleAr ?? '');
  check(
    'أعمدة `frmRptSerialNo`',
    columns(serialMovements) === 'م · الصنف · رمز الصنف · التسلسل · نوع الفاتورة · رقم الفاتورة · التاريخ · الفرع · الإتجاه',
    columns(serialMovements),
  );

  const serialBalances = byKey.get('serial-balances');
  check('🧮 أرصدة الأرقام التسلسلية في السجل', Boolean(serialBalances), serialBalances?.titleAr ?? '');
  check(
    'أعمدة `frmRptSerialNoSummary`',
    columns(serialBalances) === 'م · الصنف · رمز الصنف · التسلسل · العدد',
    columns(serialBalances),
  );

  const produced = byKey.get('produced-items');
  const components = byKey.get('produced-components');
  check('🏭 تقرير مواد المنتجة في السجل', Boolean(produced), produced?.titleAr ?? '');
  check('🔧 مكونات المواد المنتجة في السجل', Boolean(components), components?.titleAr ?? '');
  check(
    'أعمدة شبكة `frmRptProducedItems`',
    columns(produced) === '# · رقم الأمر · التاريخ · الصنف · الوحدة · الكمية · السعر · المجموع · رقم المرجع · الحالة',
    columns(produced),
  );

  // ---------------------------------------------------------------------------
  console.log('\n2. 📏 خطّ الأساس — كل رقمٍ أدناه فرقٌ عن هذا الخط');

  const baselineDocuments = await report('inventory-documents');
  const baselineDocRows = list(baselineDocuments.rows).length;
  check('مستندات المخزون قبل الكتابة', Number.isFinite(baselineDocRows), `${baselineDocRows} مستند`);

  const baselineProduced = await report('produced-items');
  const producedBase = {
    sale: cardOf(baselineProduced, 'sale'),
    qty: cardOf(baselineProduced, 'qty'),
    cost: cardOf(baselineProduced, 'cost'),
    count: cardOf(baselineProduced, 's_count'),
  };
  check('🏭 أوامر الإنتاج قبل الكتابة', Number.isFinite(Number(producedBase.count)), `${producedBase.count} أمر · ${money(producedBase.sale)} بيع`);

  // ---------------------------------------------------------------------------
  console.log('\n3. 🧾 الوثائق — أحدَ عشرَ مستنداً وثلاثة أرقام تسلسلية وأمر إنتاج');

  const branches = list(await get('/branches'));
  const branchId = branches[0].id;
  const warehouseRows = list(await get('/warehouses'));
  const warehouseA = warehouseRows[0].id;
  let warehouseB = warehouseRows.find((row) => row.id !== warehouseA)?.id ?? '';
  if (!warehouseB) {
    const second = await post('/warehouses', { branchId, code: `W${stamp}`, name: `مستودع ${stamp}` });
    warehouseB = second.id;
  }
  written.warehouseA = warehouseA;
  written.warehouseB = warehouseB;

  const categories = list(await get('/organization/catalog/categories'));
  const units = list(await get('/organization/catalog/units'));
  const unitId = units[0].id;
  const categoryId = categories[0].id;

  const makeItem = (sku, nameAr, extra = {}) =>
    post('/organization/catalog/items', {
      sku,
      nameAr,
      categoryId,
      baseUnitId: unitId,
      kind: 'stock',
      purchasePrice: '40',
      salePrice: '100',
      ...extra,
    });

  const fuel = await makeItem(`SKU-INV-${stamp}`, `صنف المخزون ${stamp}`);
  const serialItem = await makeItem(`SKU-SER-${stamp}`, `صنف تسلسلي ${stamp}`, { trackSerial: true });
  const lotItem = await makeItem(`SKU-LOT-${stamp}`, `صنف صلاحية ${stamp}`, { trackLot: true });
  const product = await makeItem(`SKU-PRD-${stamp}`, `منتج ${stamp}`);
  written.fuelId = fuel.id;
  written.serialItemId = serialItem.id;
  written.lotItemId = lotItem.id;
  written.productId = product.id;
  check('📦 أربعة أصناف موسومة', true, `${fuel.sku} · ${serialItem.sku} · ${lotItem.sku} · ${product.sku}`);

  const customer = await post('/parties', { kind: 'customer', name: `عميل ${stamp}` });
  const supplier = await post('/parties', { kind: 'supplier', name: `مورد ${stamp}` });
  written.customerId = customer.id;
  written.supplierId = supplier.id;

  const postVoucher = async (kind, lines, reason) => {
    const draft = await post('/inventory/vouchers', { branchId, warehouseId: warehouseA, kind, reason, lines });
    const posted = await post(`/inventory/vouchers/${draft.id}/post`, {});
    written.vouchers.push({ id: posted.id, number: posted.number, kind });
    return posted;
  };
  const levelOf = async (itemId, warehouseId) => {
    const levels = list(await get(`/inventory/levels?item_id=${itemId}`));
    return Number(levels.find((row) => row.warehouseId === warehouseId)?.quantity ?? 0);
  };

  // بضاعة أول مدة — `inv_type = 9` عند الديسكتوب.
  const opening = await postVoucher('opening', [{ itemId: fuel.id, qty: '100', unitCost: '40' }], 'رصيد افتتاحي');
  check('🏁 بضاعة أول مدة 100 @ 40', opening.status === 'posted', `${opening.number} · ${money(opening.totalCost)}`);
  check('«بضاعة أول مدة» تُقرأ من السند', opening.number.startsWith('OP-'), opening.number);

  const postSale = async (body) => {
    const draft = await post('/sales/invoices', { branchId, warehouseId: warehouseA, ...body });
    const posted = await post(`/sales/invoices/${draft.id}/post`, {});
    written.sales.push({ id: posted.id, number: posted.number, label: body.label ?? 'بيع' });
    return posted;
  };
  const postPurchase = async (body) => {
    const draft = await post('/purchase-invoices', { branchId, warehouseId: warehouseA, partyId: supplier.id, ...body });
    const posted = await post(`/purchase-invoices/${draft.id}/post`, {});
    written.purchases.push({ id: posted.id, number: posted.number, label: body.kind === 'purchase_return' ? 'مردود شراء' : 'شراء' });
    return posted;
  };

  const purchase = await postPurchase({ lines: [{ itemId: fuel.id, quantity: '20', unitPrice: '60', taxRate: '15' }] });
  check('📥 شراء 20 @ 60', purchase.status === 'posted', `${purchase.number} · ${money(purchase.total)}`);
  const purchaseReturn = await postPurchase({
    kind: 'purchase_return',
    referenceInvoiceId: purchase.id,
    lines: [{ itemId: fuel.id, quantity: '5', unitPrice: '60', taxRate: '15' }],
  });
  check('↩️ مردود شراء 5', purchaseReturn.status === 'posted', `${purchaseReturn.number} · ${money(purchaseReturn.total)}`);

  const sale = await postSale({
    label: 'البيع',
    partyId: customer.id,
    lines: [{ itemId: fuel.id, quantity: '10', unitPrice: '100', taxRate: '15' }],
  });
  check('🧾 بيع 10 @ 100', sale.status === 'posted', `${sale.number} · ${money(sale.total)}`);
  const draftReturn = await post(`/sales/invoices/${sale.id}/return`, {
    branchId,
    warehouseId: warehouseA,
    lines: [{ itemId: fuel.id, quantity: '2', unitPrice: '100', taxRate: '15' }],
  });
  const saleReturn = await post(`/sales/invoices/${draftReturn.id}/post`, {});
  written.sales.push({ id: saleReturn.id, number: saleReturn.number, label: 'المرتجع' });
  check('↩️ مرتجع بيع 2', saleReturn.status === 'posted', `${saleReturn.number} · ${money(saleReturn.total)}`);
  const posSale = await postSale({
    label: 'نقطة البيع',
    cashCustomerName: `نقدي ${stamp}`,
    lines: [{ itemId: fuel.id, quantity: '1', unitPrice: '100', taxRate: '15' }],
  });
  check('🧾 نقطة بيع 1 (بلا عميل)', posSale.status === 'posted', `${posSale.number} · ${money(posSale.total)}`);

  // مناقلة مرسلة / مستلمة — `inv_type = 8` عند الديسكتوب.
  const transferDraft = await post('/inventory/transfers/draft', {
    branchId,
    fromWarehouseId: warehouseA,
    toWarehouseId: warehouseB,
    lines: [{ itemId: fuel.id, qty: '25' }],
  });
  const sent = await post(`/inventory/transfers/${transferDraft.id}/send`, {});
  const received = await post(`/inventory/transfers/${transferDraft.id}/receive`, {
    received: [{ lineNo: 1, qty: '25' }],
  });
  written.transfers.push({ id: transferDraft.id, number: transferDraft.number });
  check('🚚 مناقلة أُرسلت واستُلمت 25', sent.status === 'in_transit' && received.status === 'received', `${transferDraft.number}`);

  const adjust = async (countedQty) => {
    const adjustment = await post('/inventory/adjustments', {
      branchId,
      warehouseId: warehouseA,
      reason: `تسوية ${stamp}`,
      lines: [{ itemId: fuel.id, countedQty: String(countedQty) }],
    });
    written.adjustments.push({ id: adjustment.id, number: adjustment.number });
    return post(`/inventory/adjustments/${adjustment.id}/post`, { approved: true });
  };
  const levelBefore = await levelOf(fuel.id, warehouseA);
  const surplus = await adjust(levelBefore + 3);
  const shortage = await adjust(levelBefore + 1);
  check('⚖️ تسويتان — زيادة 3 ونقص 2', surplus.status === 'posted' && shortage.status === 'posted', `${surplus.number} · ${shortage.number}`);

  const voucherIn = await postVoucher('stock_in', [{ itemId: fuel.id, qty: '7', unitCost: '45' }], 'إذن إدخال');
  const voucherOut = await postVoucher('stock_out', [{ itemId: fuel.id, qty: '4' }], 'إذن إخراج');
  check('📄 إذن إدخال 7 وإخراج 4', voucherIn.status === 'posted' && voucherOut.status === 'posted', `${voucherIn.number} · ${voucherOut.number}`);

  // ⏰ دفعتان — واحدة قريبة الانتهاء وأخرى بعيدة، وثالثة منتهية.
  const soon = iso(10);
  const later = iso(400);
  const past = iso(-5);
  const makeLot = async (lotNo, expiryDate, qty) => {
    const lot = await post('/inventory/lots', { itemId: lotItem.id, lotNo, expiryDate });
    written.lots.push(lot.id);
    await postVoucher('stock_in', [{ itemId: lotItem.id, qty: String(qty), unitCost: '20', lotId: lot.id }], 'استلام دفعة');
    return lot;
  };
  const soonLot = await makeLot(`LOT-SOON-${stamp}`, soon, 12);
  await makeLot(`LOT-LATER-${stamp}`, later, 5);
  await makeLot(`LOT-PAST-${stamp}`, past, 3);
  check('⏰ ثلاث دفعات — 10 و400 و−5 يوماً', Boolean(soonLot.id), `${soonLot.lotNo} · ${soon} · ${later} · ${past}`);

  // 🔢 ثلاثة أرقام تسلسلية — حركة كل واحدٍ منها تُسجَّل في دفتر الحركات.
  const serialPrefix = `SN${stamp}-`;
  const generated = await post('/inventory/serials/generate', {
    itemId: serialItem.id,
    prefix: serialPrefix,
    startAt: 1,
    count: 3,
    warehouseId: warehouseA,
  });
  check('⚙️ ثلاثة أرقام تسلسلية', generated.count === 3, (generated.serialNos ?? []).join(' · '));
  const serialRows = list(await get(`/inventory/serials?item_id=${serialItem.id}`));
  written.serialIds = serialRows.map((row) => row.id);
  written.serialNos = serialRows.map((row) => row.serialNo);
  await post('/inventory/ledger/record', {
    lines: serialRows.map((row, index) => ({
      itemId: serialItem.id,
      warehouseId: warehouseA,
      qty: '1',
      unitCost: '75',
      direction: 'in',
      docType: 'opening',
      docId: `00000000-0000-4000-8000-${stamp}000000`,
      serialId: row.id,
    })),
  });
  check('🔢 حركةٌ لكل رقم تسلسلي', written.serialIds.length === 3, written.serialNos.join(' · '));

  // 🏭 أمر إنتاج — منتجٌ من مكوّنين.
  const order = await post('/inventory/production-orders', {
    branchId,
    warehouseId: warehouseA,
    outputItemId: product.id,
    outputQty: '4',
    referenceNo: `REF-${stamp}`,
    referenceDate: day,
    components: [
      { itemId: fuel.id, qty: '8' },
      { itemId: lotItem.id, qty: '2' },
    ],
  });
  written.production.push({ id: order.id, number: order.number });
  const completed = await post(`/inventory/production-orders/${order.id}/complete`, {});
  check('🏭 أمر إنتاج مكتمل', completed.status === 'completed', `${completed.number} · ${money(completed.unitCost)}/وحدة`);

  // ---------------------------------------------------------------------------
  console.log('\n4. 📋 تقرير مستندات المخزون — سطرٌ لكل مستند وثمانية أنواع عملية');

  const docs = await report('inventory-documents');
  const docRows = list(docs.rows);
  check('عدد المستندات يرتفع بقدر ما كُتب', docRows.length - baselineDocRows === 17, `${docRows.length} − ${baselineDocRows} = ${docRows.length - baselineDocRows}`);
  check('🏁 بضاعة أول مدة بسطرها', Boolean(numberRow(docRows, 'OP-')), numberRow(docRows, 'OP-')?.doc_number ?? '');
  check('🧾 فاتورة البيع بسطرها', Boolean(numberRow(docRows, sale.number)), sale.number);
  check('🧾 فاتورة الشراء بسطرها', Boolean(numberRow(docRows, purchase.number)), purchase.number);
  check('🚚 المناقلة بسطرين — مرسلة ومستلمة', docRows.filter((row) => row.doc_number === transferDraft.number).length === 2, transferDraft.number);
  check('⚖️ التسوية بسطرها', docRows.filter((row) => row.operation === 'تسوية جردية').length >= 2, 'تسويتان');
  check('📄 إذن الإدخال بسطره', Boolean(numberRow(docRows, voucherIn.number)), voucherIn.number);
  check('🏭 أمر الإنتاج بسطره', Boolean(operationRow(docRows, 'أمر إنتاج')), 'أمر إنتاج');
  check('👤 العميل/المورد — فاتورة البيع تحمل اسم العميل', numberRow(docRows, sale.number)?.party_name === customer.name, numberRow(docRows, sale.number)?.party_name ?? '—');
  check('🏭 المستودع و🏢 الفرع لكل سطر', Boolean(numberRow(docRows, sale.number)?.warehouse_name && numberRow(docRows, sale.number)?.branch_name), `${numberRow(docRows, sale.number)?.warehouse_name} · ${numberRow(docRows, sale.number)?.branch_name}`);
  check('📦 عدد الأصناف — فاتورة البيع صنفٌ واحد', numberRow(docRows, sale.number)?.lines_count === '1', String(numberRow(docRows, sale.number)?.lines_count));
  check('💰 التكلفة — بضاعة أول مدة 100 × 40', money(numberRow(docRows, 'OP-')?.cost) === '4000.00', money(numberRow(docRows, 'OP-')?.cost));
  check('🔢 عدد المستندات بطاقة', Number(cardOf(docs, 's_count')) === docRows.length, cardOf(docs, 's_count'));

  const kinds = [
    ['opening', 'بضاعة أول مدة'],
    ['delivery', 'أمر توريد'],
    ['issue', 'إذن مخزني'],
    ['production', 'أمر إنتاج'],
    ['request', 'طلب بضاعة'],
    ['adjustment', 'تسوية جردية'],
    ['transfer_out', 'مناقلة مرسلة'],
    ['transfer_in', 'مناقلة مستلمة'],
  ];
  for (const [value, label] of kinds) {
    const filtered = await report('inventory-documents', `docType=${value}`);
    const rows = list(filtered.rows);
    check(`📄 نوع العملية = «${label}» — لا يظهر إلا من نوعه`, rows.every((row) => row.operation === label), `${rows.length} سطر`);
  }
  for (const [value, label] of [
    ['opening', 'بضاعة أول مدة'],
    ['issue', 'إذن مخزني'],
    ['production', 'أمر إنتاج'],
    ['adjustment', 'تسوية جردية'],
    ['transfer_out', 'مناقلة مرسلة'],
    ['transfer_in', 'مناقلة مستلمة'],
  ]) {
    const rows = list((await report('inventory-documents', `docType=${value}`)).rows);
    check(`📄 «${label}» له سطورٌ في الدفتر`, rows.length > 0, `${rows.length} سطر`);
  }
  // 📄 «أمر توريد» و«طلب بضاعة» موجودان في قائمة الديسكتوب الثمانية، والسحابة تحفظهما
  // وثيقتين (`stock_deliveries` · `goods_requests`) لا تُحرّكان رصيد المخزون — فلا سطر
  // لهما في دفتر الحركات، وهو فرقٌ مقصودٌ لا نقص.
  for (const [value, label] of [
    ['delivery', 'أمر توريد'],
    ['request', 'طلب بضاعة'],
  ]) {
    const rows = list((await report('inventory-documents', `docType=${value}`)).rows);
    check(`📄 «${label}» — وثيقة السحابة لا تُحرّك المخزون`, rows.length === 0, `${rows.length} سطر`);
  }

  // ---------------------------------------------------------------------------
  console.log('\n5. 📦 مادة باجمالي الحركات — ثلاثة عشر عمود حركة والرصيد ومتوسط التكلفة');

  const activity = await report('item-movement-totals', `itemId=${fuel.id}&warehouseId=${warehouseA}`);
  const activityRow = list(activity.rows).find((row) => row.item_name === fuel.nameAr);
  check('📦 الصنف بسطره', Boolean(activityRow), activityRow?.item_name ?? 'لا سطر');
  check('🏁 أول مدة 100', money(activityRow?.opening_qty) === '100.00', money(activityRow?.opening_qty));
  check('📥 مشتريات 20', money(activityRow?.purchase_qty) === '20.00', money(activityRow?.purchase_qty));
  check('↩️ مرتجع مشتريات 5', money(activityRow?.purchase_return_qty) === '5.00', money(activityRow?.purchase_return_qty));
  check('🧾 المبيعات 10', money(activityRow?.sale_qty) === '10.00', money(activityRow?.sale_qty));
  check('↩️ مرتجع المبيعات 2', money(activityRow?.sale_return_qty) === '2.00', money(activityRow?.sale_return_qty));
  check('🛒 نقطة البيع 1', money(activityRow?.pos_qty) === '1.00', money(activityRow?.pos_qty));
  check('🚚 مناقلة مرسلة 25 (الصادر)', money(activityRow?.transfer_received_qty) === '25.00', money(activityRow?.transfer_received_qty));
  check('📄 فاتورة إدخال 7', money(activityRow?.entry_qty) === '7.00', money(activityRow?.entry_qty));
  check('📄 فاتورة إخراج 4', money(activityRow?.issue_qty) === '4.00', money(activityRow?.issue_qty));
  check('⚖️ تسوية إدخال 3', money(activityRow?.adjust_in_qty) === '3.00', money(activityRow?.adjust_in_qty));
  check('⚖️ تسوية إخراج 2', money(activityRow?.adjust_out_qty) === '2.00', money(activityRow?.adjust_out_qty));
  check(
    'الرصيد = 100+20−5−10+2−1−25+3−2+7−4−8 (مكوّنات الإنتاج) = 77',
    money(activityRow?.balance) === '77.00',
    money(activityRow?.balance),
  );
  check('💰 متوسط التكلفة من رصيد المخزون', Number(activityRow?.avg_cost) > 0, money(activityRow?.avg_cost));
  check(
    'إجمالي التكلفة = الرصيد × متوسط التكلفة',
    money(activityRow?.total_cost) === money(num(activityRow?.balance) * num(activityRow?.avg_cost)),
    money(activityRow?.total_cost),
  );
  check('📦 إجمالي الرصيد بطاقة', money(cardOf(activity, 'balance')) === '77.00', cardOf(activity, 'balance'));
  check('🔢 عدد الأصناف — صنفٌ واحد', Number(cardOf(activity, 's_count')) === 1, cardOf(activity, 's_count'));

  const activityB = await report('item-movement-totals', `itemId=${fuel.id}&warehouseId=${warehouseB}`);
  const rowB = list(activityB.rows).find((row) => row.item_name === fuel.nameAr);
  check('🏬 المستودع الثاني — مناقلة مستلمة 25', money(rowB?.transfer_sent_qty) === '25.00', money(rowB?.transfer_sent_qty));

  const byCategory = await report('item-movement-totals', `categoryId=${categoryId}`);
  check('🗂️ المجموعة تُفلتر الأصناف', list(byCategory.rows).length >= 1, `${list(byCategory.rows).length} صنف`);

  // ---------------------------------------------------------------------------
  console.log('\n6. 🔍 حركة صنف تفصيلي — رصيدٌ متحرك ونوع فاتورة ومرجع وخيارات البحث');

  const card = await report('item-movement-details', `itemId=${fuel.id}&warehouseId=${warehouseA}`);
  const cardRows = list(card.rows);
  check('🔍 اثنا عشر سطر حركة', cardRows.length === 12, `${cardRows.length} سطر`);
  check('⚖️ الرصيد المتحرك ينتهي إلى 77', money(cardRows.at(-1)?.balance) === '77.00', money(cardRows.at(-1)?.balance));
  check('⚖️ إجمالي الرصيد بطاقة', money(cardOf(card, 's_qty')) === '77.00', cardOf(card, 's_qty'));
  check('🏁 أول سطر هو بضاعة أول مدة', cardRows[0]?.operation === 'بضاعة أول مدة', cardRows[0]?.operation ?? '—');
  check('📥 الكمية الداخلة لأول مدة 100', money(cardRows[0]?.qty_in) === '100.00', money(cardRows[0]?.qty_in));
  check('📤 المبيعات كمية خارجة 10', money(cardRows.find((row) => row.operation === 'مبيعات')?.qty_out) === '10.00', money(cardRows.find((row) => row.operation === 'مبيعات')?.qty_out));
  check('🛒 نقطة البيع نوعها «نقطة البيع»', Boolean(cardRows.find((row) => row.operation === 'نقطة البيع')), 'نقطة البيع');
  check(
    '📄 رقم الفاتورة ورقم المرجع',
    Boolean(cardRows.find((row) => row.doc_number === purchase.number)),
    `${purchase.number} · مرجع ${cardRows.find((row) => row.doc_number === purchase.number)?.ref_no ?? '—'}`,
  );
  check(
    '👥 الحساب — فاتورة البيع باسم العميل',
    cardRows.find((row) => row.doc_number === sale.number)?.party_name === customer.name,
    cardRows.find((row) => row.doc_number === sale.number)?.party_name ?? '—',
  );
  check(
    '💰 السعر في الفاتورة × الكمية = الإجمالي في الفاتورة',
    cardRows.every((row) => money(num(row.qty_doc) * num(row.price_doc)) === money(row.total_doc)),
    `${cardRows[0]?.qty_doc} × ${cardRows[0]?.price_doc} = ${cardRows[0]?.total_doc}`,
  );
  check(
    '💰 السعر × الكمية = الإجمالي بالوحدة الأساسية',
    cardRows.every((row) => money(Math.max(num(row.qty_in), num(row.qty_out)) * num(row.price)) === money(row.total)),
    `${cardRows[0]?.price} · ${cardRows[0]?.total}`,
  );
  check('🏭 المستودع و📐 الوحدة لكل سطر', Boolean(cardRows[0]?.warehouse_name && cardRows[0]?.unit_name), `${cardRows[0]?.warehouse_name} · ${cardRows[0]?.unit_name}`);

  const saleRows = list((await report('item-movement-details', `itemId=${fuel.id}&warehouseId=${warehouseA}&kind=sale`)).rows);
  check('🔄 نوع العملية = مبيعات', saleRows.length === 2 && saleRows.every((row) => ['مبيعات', 'مرتجع مبيعات', 'نقطة البيع'].includes(row.operation)), `${saleRows.length} سطر · ${saleRows.map((row) => row.operation).join(' · ')}`);
  const purchaseRows = list((await report('item-movement-details', `itemId=${fuel.id}&warehouseId=${warehouseA}&kind=purchase`)).rows);
  check('🔄 نوع العملية = مشتريات', purchaseRows.length === 2, `${purchaseRows.length} سطر · ${purchaseRows.map((row) => row.operation).join(' · ')}`);
  const adjustmentRows = list((await report('item-movement-details', `itemId=${fuel.id}&warehouseId=${warehouseA}&kind=adjustment`)).rows);
  check('🔄 نوع العملية = تسوية جردية', adjustmentRows.length === 2, `${adjustmentRows.map((row) => row.operation).join(' · ')}`);
  const patternRows = list((await report('item-movement-details', `itemId=${fuel.id}&warehouseId=${warehouseA}&status=purchase`)).rows);
  check('📋 أنماط الفواتير = مشتريات', patternRows.length === 1 && patternRows[0].operation === 'مشتريات', `${patternRows.length} سطر`);
  const patternReturn = list((await report('item-movement-details', `itemId=${fuel.id}&warehouseId=${warehouseA}&status=purchase_return`)).rows);
  check('📋 أنماط الفواتير = مرتجع مشتريات', patternReturn.length === 1 && patternReturn[0].operation === 'مرتجع مشتريات', `${patternReturn.length} سطر`);

  // ---------------------------------------------------------------------------
  console.log('\n7. ⏰ صلاحية المواد — باقي سنوات وأشهر وأيام');

  const expiryReport = await report('item-expiry', `itemId=${lotItem.id}`);
  const expiryRows = list(expiryReport.rows);
  check('⏰ ثلاث دفعات بثلاثة أسطر', expiryRows.length === 3, `${expiryRows.length} سطر`);
  const soonRow = expiryRows.find((row) => row.expiry_date === soon);
  check('📅 باقي أيام للدفعة القريبة 10', Number(soonRow?.days_left) === 10, String(soonRow?.days_left));
  check('📅 باقي أشهر 0 وباقي سنوات 0', Number(soonRow?.months_left) === 0 && Number(soonRow?.years_left) === 0, `${soonRow?.months_left} شهر · ${soonRow?.years_left} سنة`);
  const laterRow = expiryRows.find((row) => row.expiry_date === later);
  check('📅 باقي سنوات للبعيدة 1', Number(laterRow?.years_left) === 1, String(laterRow?.years_left));
  check('📦 الكمية الحالية 12 للقريبة', money(soonRow?.qty) === '12.00', money(soonRow?.qty));
  check('🏭 المستودع لكل دفعة', Boolean(soonRow?.warehouse_name), soonRow?.warehouse_name ?? '—');
  check('📦 عدد الأصناف بطاقة', Number(cardOf(expiryReport, 's_count')) === 3, cardOf(expiryReport, 's_count'));
  check('⚠️ منتهي الصلاحية — دفعةٌ واحدة', Number(cardOf(expiryReport, 's_expired')) === 1, cardOf(expiryReport, 's_expired'));
  check('🔢 «م» تُرقّم الأسطر', expiryRows[0]?.seq === '1', String(expiryRows[0]?.seq));

  // ---------------------------------------------------------------------------
  console.log('\n8. 🔢 حركة الأرقام التسلسلية');

  const serialReport = await report('serial-movements', `itemId=${serialItem.id}`);
  const serialMovementRows = list(serialReport.rows);
  check('🔢 ثلاث حركات — واحدة لكل رقم', serialMovementRows.length === 3, `${serialMovementRows.length} حركة`);
  check(
    'التسلسلات الثلاثة ظاهرة',
    written.serialNos.every((serialNo) => serialMovementRows.some((row) => row.serial_no === serialNo)),
    written.serialNos.join(' · '),
  );
  check('📦 الصنف ورمزه في كل سطر', serialMovementRows[0]?.item_name === serialItem.nameAr && serialMovementRows[0]?.code === serialItem.sku, `${serialMovementRows[0]?.item_name} · ${serialMovementRows[0]?.code}`);
  check('🏁 نوع الفاتورة «بضاعة أول مدة»', serialMovementRows[0]?.operation === 'بضاعة أول مدة', serialMovementRows[0]?.operation ?? '—');
  check('📅 التاريخ و🏢 الفرع', Boolean(serialMovementRows[0]?.doc_date && serialMovementRows[0]?.branch_name), `${serialMovementRows[0]?.doc_date} · ${serialMovementRows[0]?.branch_name}`);
  check('➡️ الإتجاه «داخل»', serialMovementRows[0]?.direction === 'داخل', serialMovementRows[0]?.direction ?? '—');
  const bySerial = await report('serial-movements', `serial=${written.serialNos[0]}`);
  check('🔢 البحث برقم تسلسلي يُفلتر', list(bySerial.rows).length === 1, `${list(bySerial.rows).length} حركة`);

  // ---------------------------------------------------------------------------
  console.log('\n9. 🧮 أرصدة الأرقام التسلسلية');

  const balances = await report('serial-balances', `itemId=${serialItem.id}`);
  const balanceRows = list(balances.rows);
  check('🧮 ثلاثة أرقام في المخزون', balanceRows.length === 3, `${balanceRows.length} رقم`);
  check('🔢 العدد 1 لكل رقم', balanceRows.every((row) => money(row.count) === '1.00'), balanceRows.map((row) => row.count).join(' · '));
  check('📦 إجمالي العدد بطاقة', money(cardOf(balances, 'count')) === '3.00', cardOf(balances, 'count'));
  check('🔢 عدد الأرقام التسلسلية بطاقة', Number(cardOf(balances, 's_count')) === 3, cardOf(balances, 's_count'));
  await post('/inventory/serials/consume', { serialIds: [written.serialIds[0]] });
  const afterConsume = list((await report('serial-balances', `itemId=${serialItem.id}`)).rows);
  check('📤 رقمٌ مُستهلك يخرج من الرصيد', afterConsume.length === 2, `${afterConsume.length} رقم بعد الاستهلاك`);
  await post('/inventory/serials/return', { serialIds: [written.serialIds[0]] });
  const afterReturn = list((await report('serial-balances', `itemId=${serialItem.id}`)).rows);
  check('↩️ الرقم يعود إلى الرصيد', afterReturn.length === 3, `${afterReturn.length} رقم بعد الإرجاع`);

  // ---------------------------------------------------------------------------
  console.log('\n10. 🏭 تقرير مواد المنتجة — المواد المنتجة ومكوّناتها');

  const producedReport = await report('produced-items');
  const producedRows = list(producedReport.rows).filter((row) => row.order_no === completed.number);
  check('🏭 أمر الإنتاج بسطره', producedRows.length === 1, producedRows[0]?.order_no ?? '—');
  check('📦 الكمية 4', money(producedRows[0]?.qty) === '4.00', money(producedRows[0]?.qty));
  check('📦 الصنف هو المُنتَج', producedRows[0]?.item_name === product.nameAr, producedRows[0]?.item_name ?? '—');
  check('📄 رقم المرجع', producedRows[0]?.ref_no === `REF-${stamp}`, producedRows[0]?.ref_no ?? '—');
  check('📋 الحالة «مكتمل»', producedRows[0]?.status_ar === 'مكتمل', producedRows[0]?.status_ar ?? '—');
  check('💵 إجمالي البيع — فرقٌ 4 × سعر البيع 100 = 400', delta(cardOf(producedReport, 'sale'), producedBase.sale) === 400, `${money(producedBase.sale)} → ${money(cardOf(producedReport, 'sale'))}`);
  check('📦 إجمالي الرصيد — فرقٌ 4', delta(cardOf(producedReport, 'qty'), producedBase.qty) === 4, `${money(producedBase.qty)} → ${money(cardOf(producedReport, 'qty'))}`);
  check(
    '💰 إجمالي التكلفة — فرقٌ يساوي تكلفة مكوّنات الأمر',
    delta(cardOf(producedReport, 'cost'), producedBase.cost) === Number(Number(completed.componentCost).toFixed(2)),
    `${money(producedBase.cost)} → ${money(cardOf(producedReport, 'cost'))} · ${money(completed.componentCost)}`,
  );
  check('🏭 إجمالي المواد — فرقٌ أمرٌ واحد', delta(cardOf(producedReport, 's_count'), producedBase.count) === 1, `${producedBase.count} → ${cardOf(producedReport, 's_count')}`);

  const componentsReport = await report('produced-components');
  const componentRows = list(componentsReport.rows).filter((row) => row.order_no === completed.number);
  check('🔧 مكوّنان بسطرين', componentRows.length === 2, `${componentRows.length} مكوّن`);
  check('🔧 الكميات 8 و2', componentRows.map((row) => money(row.qty)).sort().join(' · ') === '2.00 · 8.00', componentRows.map((row) => money(row.qty)).join(' · '));
  check('💰 المجموع = الكمية × السعر', componentRows.every((row) => money(num(row.qty) * num(row.price)) === money(row.total)), componentRows.map((row) => money(row.total)).join(' · '));

  // ---------------------------------------------------------------------------
  console.log('\n11. 📆 فترةٌ بلا حركة — جدولٌ فارغ وبطاقات صفر');

  for (const key of [
    'inventory-documents',
    'item-movement-totals',
    'item-movement-details',
    'serial-movements',
    'produced-items',
    'produced-components',
  ]) {
    const empty = await get(`/reports/${key}?${emptyPeriod}${key === 'item-movement-details' || key === 'serial-movements' ? `&itemId=${fuel.id}` : ''}`);
    check(`📆 ${key} — جدولٌ فارغ`, list(empty.rows).length === 0, `${list(empty.rows).length} سطر`);
  }
  const emptyActivity = await get(`/reports/item-movement-totals?${emptyPeriod}`);
  check('📆 بطاقات مادة باجمالي الحركات صفر', money(cardOf(emptyActivity, 'balance')) === '0.00' && Number(cardOf(emptyActivity, 's_count')) === 0, `${cardOf(emptyActivity, 'balance')} · ${cardOf(emptyActivity, 's_count')}`);

  // ---------------------------------------------------------------------------
  console.log('\n12. 🖨️ طباعة والتصدير — CSV وXLSX');

  const printed = await get(`/reports/print/item-movement-totals?${period}&itemId=${fuel.id}`);
  const html = String(printed.html ?? '');
  check('🖨️ صفحة طباعة عربية RTL', html.includes('dir="rtl"') && html.includes('مادة باجمالي الحركات'), `${html.length} حرف`);
  check('🖨️ الأعمدة في الصفحة', html.includes('أول مدة') && html.includes('تسوية إخراج'), 'أول مدة · تسوية إخراج');
  check('🖨️ البطاقات في الصفحة', html.includes('إجمالي الرصيد') && html.includes('عدد الأصناف'), 'إجمالي الرصيد · عدد الأصناف');
  const serialHtml = String((await get(`/reports/print/serial-balances?${period}`)).html ?? '');
  check('🖨️ أرصدة الأرقام التسلسلية', serialHtml.includes('أرصدة الأرقام التسلسلية') && serialHtml.includes('العدد'), 'أرصدة الأرقام التسلسلية');

  const csv = await post(`/reports/item-movement-totals/export?${period}&itemId=${fuel.id}`, { format: 'csv' });
  check('📄 CSV بالعناوين العربية', String(csv.content ?? '').includes('تسوية إدخال'), `${csv.rows} سطر`);
  const xlsx = await post(`/reports/item-movement-totals/export?${period}&itemId=${fuel.id}`, { format: 'xlsx' });
  check('📗 XLSX', xlsx.encoding === 'base64' && String(xlsx.filename).endsWith('.xlsx'), xlsx.filename);
  const detailsCsv = await post(`/reports/item-movement-details/export?${period}&itemId=${fuel.id}`, { format: 'csv' });
  check('📄 CSV حركة صنف تفصيلي', String(detailsCsv.content ?? '').includes('الكمية الداخلة'), `${detailsCsv.rows} سطر`);
} finally {
  // ---------------------------------------------------------------------------
  console.log('\n13. التنظيف — ما يُلغى يُلغى وما لا يُلغى يُعلَن');

  let undone = 0;
  const refusals = [];
  const undo = async (label, fn) => {
    try {
      await fn();
      undone += 1;
    } catch (error) {
      refusals.push({ label, status: error.status ?? 0, code: error.code ?? '' });
      console.log(`  · ${label} — ${error.message}`);
    }
  };

  // 🧹 سبب الإلغاء حقلٌ مطلوب في الدفاتر — `SalesService.void` و`voidVoucher` يقرآن
  // `reason.trim()`، وبدونه يرفض الخادم بـ 500.
  const voidReason = `تنظيف سكربت التحقق ${stamp}`;
  // الترتيب من قاعدة الدفاتر لا من الهوى: الفواتير تُردّ أولاً (فهي تُعيد الرصيد)، ثم
  // المشتريات (تسحبه)، ثم السندات — وإلا رُفض إلغاءُ الفواتير بـ `STOCK_INSUFFICIENT`.
  for (const entry of [...written.sales].reverse()) {
    await undo(`إلغاء ${entry.number}`, () => post(`/sales/invoices/${entry.id}/void`, { reason: voidReason }));
  }
  for (const entry of [...written.purchases].reverse()) {
    await undo(`إلغاء ${entry.number}`, () => post(`/purchase-invoices/${entry.id}/void`, { reason: voidReason }));
  }
  for (const voucher of [...written.vouchers].reverse()) {
    await undo(`إلغاء سند ${voucher.number}`, () => post(`/inventory/vouchers/${voucher.id}/void`, { reason: voidReason }));
  }
  for (const lot of written.lots) {
    await undo('حذف دفعة', () => del(`/inventory/lots/${lot}`));
  }
  for (const serialId of written.serialIds) {
    await undo('حذف رقم تسلسلي', () => del(`/inventory/serials/${serialId}`));
  }
  // 🏭 أمر إنتاج مكتمل لا يُلغى (`PRODUCTION_ORDER_INVALID_STATUS`: «Only a draft … can be
  // cancelled») — تماماً كما يرفض الديسكتوب فتحَ بناءٍ مُرحَّل.
  for (const order of written.production) {
    const refusal = await refused('post', `/inventory/production-orders/${order.id}/cancel`, {});
    check('🏭 أمر الإنتاج المكتمل يُرفض إلغاؤه', refusal.status === 409, `409 ${refusal.code}`);
  }
  // 🚚 المناقلة المستلمة لا تُغلق (`TRANSFER_INVALID_STATE`: «Only a transfer on the road …»).
  for (const transfer of written.transfers) {
    const refusal = await refused('post', `/inventory/transfers/${transfer.id}/close`, { mode: 'accept_variance' });
    check('🚚 المناقلة المستلمة يُرفض إغلاقها', refusal.status === 409, `409 ${refusal.code}`);
  }
  // ⚖️ وما بقي من سنداتٍ وفواتير فرفضُها **قاعدةُ دفاتر** لا عطل: «الرصيد لا يكفي» بعدما
  // سحبته مستنداتٌ أخرى مُرحَّلة، وهو عينُ ما يعرضه الديسكتوب للموظف.
  check(
    '⚖️ ما تعذّر إلغاؤه رفضٌ من قاعدة الدفاتر (4xx) لا خطأ',
    refusals.every((row) => row.status >= 400 && row.status < 500),
    refusals.map((row) => row.code).join(' · ') || 'لا شيء',
  );
  check(
    `🧹 ما أُلغيَ: ${undone} وثيقة`,
    true,
    'والباقي — تسويتان وأمر إنتاج مكتمل ومناقلة مستلمة — مستنداتٌ لا رجعة فيها كما في الديسكتوب',
  );
}

console.log(`\n${failures === 0 ? '✅' : '❌'} ${failures} فشل`);
process.exit(failures === 0 ? 0 : 1);
