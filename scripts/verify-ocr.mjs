#!/usr/bin/env node
/**
 * Live verification for future enhancement 02 — purchase-invoice OCR.
 *
 * The API must be running with `OCR_PROVIDER=mock` (or the platform setting
 * `ocr.provider=mock`) for a provider-independent smoke run. The mock is explicit and
 * deterministic; production runs should point `ocr.endpoint` at the configured Arabic/
 * English OCR adapter. The script uploads a tiny PDF-shaped object through the real
 * presign/finalize flow and removes the file in finally.
 *
 * Usage: OCR_PROVIDER=mock node scripts/verify-ocr.mjs
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
const written = { fileId: '' };

function check(label, condition, detail = '') {
  checks += 1;
  if (condition) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    failures += 1;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function request(method, path, body, options = {}) {
  const response = await fetch(`${base}${path}`, {
    method: method.toUpperCase(),
    headers: {
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(options.headers ?? {}),
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

const stamp = Date.now().toString().slice(-8);

try {
  const login = await request('post', '/auth/login', { tenantCode, email, password });
  token = login.accessToken ?? login.token ?? '';
  check('تسجيل الدخول', Boolean(token), tenantCode);

  const malformed = await refused('post', '/ocr/presign', {
    name: `verify-${stamp}.txt`,
    mime: 'text/plain',
    sizeBytes: 4,
  });
  check('رفض نوع ملف غير مدعوم', malformed.status === 422, `${malformed.status} ${malformed.code}`);

  const presign = await request('post', '/ocr/presign', {
    name: `verify-ocr-${stamp}.pdf`,
    mime: 'application/pdf',
    sizeBytes: 32,
  });
  written.fileId = presign.fileId;
  check('إصدار رابط الرفع', Boolean(written.fileId && presign.uploadUrl), written.fileId);

  const upload = await fetch(presign.uploadUrl, {
    method: 'PUT',
    headers: presign.requiredHeaders,
    body: Buffer.from('%PDF-1.4 verify OCR fixture\n%%EOF\n'),
  });
  check('رفع البايتات إلى التخزين مباشرة', upload.ok, String(upload.status));

  const finalized = await request('post', `/files/${written.fileId}/finalize`, {});
  check('إنهاء دورة الملف', finalized.status === 'ready', finalized.status);

  const created = await request('post', '/ocr/jobs', { fileId: written.fileId, entityType: 'purchase_invoice' });
  check('إنشاء مهمة OCR في حالة الانتظار', Boolean(created.id) && ['queued', 'processing', 'done'].includes(created.status), created.id);

  const initial = await request('get', `/ocr/jobs/${created.id}`);
  check('استطلاع المهمة مع عزل المستأجر', initial.id === created.id && initial.file.id === written.fileId, initial.status);

  let current = initial;
  const deadline = Date.now() + Number(process.env.OCR_VERIFY_TIMEOUT_MS ?? 30_000);
  while (Date.now() < deadline && current.status !== 'done' && current.status !== 'failed') {
    await new Promise((resolve) => setTimeout(resolve, 500));
    current = await request('get', `/ocr/jobs/${created.id}`);
  }
  check('إكمال العامل الخلفي', current.status === 'done', current.error ?? current.status);
  check('إرجاع الحقول الموحّدة', current.status === 'done' && typeof current.extracted.total === 'string', current.extracted.total ?? '—');
  check('إرجاع رابط المستند للمراجعة', typeof current.file.downloadUrl === 'string' && current.file.downloadUrl.includes('/files/'), current.file.downloadUrl);
  check('الحالة الفاشلة لا تُخفى', current.status !== 'failed' || Boolean(current.error), current.error ?? 'done');
} finally {
  if (token && written.fileId) await cleanupRequest('delete', `/files/${written.fileId}`);
}

console.log(`\nOCR verification: ${checks - failures}/${checks}`);
if (cleanupErrors.length > 0) {
  console.error(`Cleanup failed for ${cleanupErrors.length} resource(s).`);
  process.exitCode = 1;
}
if (failures > 0) process.exitCode = 1;
