#!/usr/bin/env node
/**
 * Live verification for future enhancement 01 — التغذية البنكية والمطابقة التلقائية.
 *
 * It uses the same HTTP routes as the staff screens and writes only a uniquely named
 * account/statement/rule, removing them in finally. No bank network is contacted: the
 * imported CSV is the supported R18 input boundary.
 *
 * Usage: node scripts/verify-bank-feeds.mjs
 */
import { loadEnvFiles } from './dotenv.mjs';

loadEnvFiles();

const base = process.env.API_BASE ?? 'http://127.0.0.1:3000/api/v1';
const tenantCode = process.env.VERIFY_TENANT ?? 'demo';
const email = process.env.VERIFY_EMAIL ?? 'owner@demo.test';
const password = process.env.DEMO_OWNER_PASSWORD ?? '';
let token = '';
let failures = 0;
let checks = 0;
const cleanupErrors = [];

function check(label, condition, detail = '') {
  checks += 1;
  if (condition) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    failures += 1;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function request(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method: method.toUpperCase(),
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error(`${method} ${path} → ${response.status} ${payload.code ?? ''} ${payload.detail ?? ''}`);
    error.status = response.status;
    error.code = payload.code;
    throw error;
  }
  return payload.data ?? payload;
}

async function refused(method, path, body) {
  try {
    await request(method, path, body);
    return { status: 200, code: '' };
  } catch (error) {
    return { status: error.status ?? 0, code: error.code ?? '' };
  }
}

async function cleanupRequest(method, path) {
  try {
    await request(method, path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    cleanupErrors.push(`${method} ${path}: ${message}`);
    console.error(`  ! cleanup failed — ${message}`);
  }
}

const written = { accountId: '', statementId: '', ruleId: '' };
const stamp = Date.now().toString().slice(-8);
const csv = [
  'Date,Description,Reference,Amount,Balance',
  `2026-09-01,تحصيل فاتورة,INV-${stamp}-1,100.00,1100.00`,
  `2026-09-02,تحصيل فاتورة,INV-${stamp}-2,200.00,1300.00`,
  `2026-09-03,رسوم بنك,,-10.00,1290.00`,
  `2026-09-04,إيداع نقدي,,50.00,1340.00`,
  `2026-09-05,سداد مورد,, -25.00,1315.00`,
].join('\n');

try {
  const login = await request('post', '/auth/login', { tenantCode, email, password });
  token = login.accessToken ?? login.token;
  check('تسجيل الدخول', Boolean(token), tenantCode);

  const account = await request('post', '/treasury/bank-accounts', {
    bankName: `بنك التحقق ${stamp}`,
    accountNo: `VERIFY-${stamp}`,
    iban: `SA${stamp}VERIFYBANKFEEDS`,
    openingBalance: '1000',
  });
  written.accountId = account.id;
  check('إنشاء حساب بنكي', Boolean(account.id), account.bankName);

  const listed = await request('get', '/treasury/bank-accounts');
  check('قراءة الحسابات البنكية', listed.some((row) => row.id === written.accountId), `${listed.length} حساب`);
  check('إخفاء IBAN في القائمة', listed.find((row) => row.id === written.accountId)?.iban?.includes('••') === true);

  const imported = await request('post', '/treasury/bank-statements/import', {
    bankAccountId: written.accountId,
    fileName: `verify-${stamp}.csv`,
    csv,
    openingBalance: '1000',
  });
  written.statementId = imported.statement.id;
  check('استيراد CSV', imported.importedLines === 5, `${imported.importedLines} سطر`);
  check('الفترة محسوبة من الحركات', imported.statement.periodFrom === '2026-09-01' && imported.statement.periodTo === '2026-09-05');

  const statements = await request('get', `/treasury/bank-statements?bank_account_id=${written.accountId}`);
  check('الكشف مربوط بالحساب', statements.some((row) => row.id === written.statementId && row.rowCount === 5));

  const lines = await request('get', `/treasury/bank-statements/${written.statementId}/lines?filter[status]=pending`);
  check('قراءة 5 حركات معلّقة', lines.length === 5, `${lines.length} حركة`);
  check('المبالغ تحفظ بإشارة صحيحة', lines.some((row) => row.amount === '-10.0000') && lines.some((row) => row.amount === '200.0000'));

  const auto = await request('post', `/treasury/bank-statements/${written.statementId}/auto-match`, {});
  check('تشغيل auto-match', auto.scanned === 5, `${auto.matched} مطابقة · ${auto.suggested} اقتراح`);

  const reconciliation = await request('get', `/treasury/bank-reconciliation?bank_account_id=${written.accountId}`);
  check('تقرير التسوية يعيد الرصيد البنكي', reconciliation.bankBalance === '1315.0000', reconciliation.bankBalance);
  check('تقرير التسوية يعيد الفرق', typeof reconciliation.difference === 'string' && reconciliation.ledgerSource === 'matched bank lines', reconciliation.difference);

  const malformed = await refused('post', '/treasury/bank-statements/import', { bankAccountId: written.accountId, csv: 'date,description,amount\nnot-a-date,broken,10' });
  check('CSV غير صالح يُرفض', malformed.status === 422 && malformed.code === 'BANK_CSV_INVALID', `${malformed.status} ${malformed.code}`);

  const accounts = await request('get', '/accounts');
  const ledgerAccount = Array.isArray(accounts) ? accounts[0] : undefined;
  if (ledgerAccount?.id) {
    const rule = await request('post', '/treasury/bank-reconciliation-rules', {
      keyword: 'رسوم بنك',
      accountId: ledgerAccount.id,
      priority: 1,
    });
    written.ruleId = rule.id;
    check('إنشاء قاعدة مطابقة', Boolean(rule.id), rule.keyword);
    const rules = await request('get', '/treasury/bank-reconciliation-rules');
    check('قراءة قواعد المطابقة', rules.some((row) => row.id === written.ruleId));
  } else {
    check('إنشاء قاعدة مطابقة', false, 'لا يوجد حساب أستاذ في بيانات التحقق');
    check('قراءة قواعد المطابقة', false, 'لا يوجد حساب أستاذ في بيانات التحقق');
  }
} finally {
  if (token && written.ruleId) await cleanupRequest('delete', `/treasury/bank-reconciliation-rules/${written.ruleId}`);
  if (token && written.statementId) await cleanupRequest('delete', `/treasury/bank-statements/${written.statementId}`);
  if (token && written.accountId) await cleanupRequest('delete', `/treasury/bank-accounts/${written.accountId}`);
}

console.log(`\nBank feeds verification: ${checks - failures}/${checks}`);
if (cleanupErrors.length > 0) {
  console.error(`Cleanup failed for ${cleanupErrors.length} resource(s).`);
  process.exitCode = 1;
}
if (failures > 0) process.exitCode = 1;
