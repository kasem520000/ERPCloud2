#!/usr/bin/env node
/**
 * Live smoke verification for PHASE_06. It checks the API contract and the files that make
 * the staff surface installable; the Vitest suite covers stock conflict/idempotency with a
 * real test database. Run after migrations with the API reachable.
 */
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { loadEnvFiles } from './dotenv.mjs';
loadEnvFiles();

const base = (process.env.API_BASE ?? 'http://127.0.0.1:3000/api/v1').replace(/\/+$/, '');
const tenantCode = process.env.VERIFY_TENANT ?? 'demo';
const email = process.env.VERIFY_EMAIL ?? process.env.DEMO_OWNER_EMAIL ?? 'owner@demo.test';
const password = process.env.DEMO_OWNER_PASSWORD ?? '';
let token = '';
let checks = 0;
let failures = 0;

function check(label, condition, detail = '') {
  checks += 1;
  if (condition) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    failures += 1;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
async function raw(method, path, body, auth = token) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...(auth ? { authorization: `Bearer ${auth}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { text };
  }
  return { status: response.status, body: parsed };
}
const payload = (response) => response.body?.data ?? response.body;

async function main() {
  console.log(`■ offline POS verification @ ${tenantCode}`);
  const login = await raw('POST', '/auth/login', { tenantCode, email, password }, '');
  token = payload(login)?.accessToken ?? '';
  check('owner login', login.status === 200 && Boolean(token));
  if (!token) throw new Error('No access token');

  const snapshotResponse = await raw('GET', '/pos/offline-data');
  const snapshot = payload(snapshotResponse);
  check('offline-data endpoint', snapshotResponse.status === 200 && Array.isArray(snapshot?.items));
  check(
    'snapshot includes prices, customers and taxes',
    Boolean(snapshot?.prices && snapshot?.customers && snapshot?.taxes),
  );
  check('snapshot includes an offline default branch', Boolean(snapshot?.defaults?.branchId));

  if (snapshot?.items?.[0] && snapshot?.defaults?.branchId) {
    const item = snapshot.items[0];
    const itemPrice = item.salePrice ?? '0';
    const offlineId = `OFFLINE-verify-${randomUUID()}`;
    const deviceId = `verify-${randomUUID().slice(0, 12)}`;
    const sync = await raw('POST', '/pos/offline-sync', {
      deviceId,
      invoices: [
        {
          offlineId,
          deviceId,
          sequenceNo: 1,
          payload: {
            branchId: snapshot.defaults.branchId,
            warehouseId: snapshot.defaults.warehouseId ?? undefined,
            cashCustomerName: 'Offline verification',
            priceIncludesVat: true,
            lines: [{ itemId: item.id, quantity: '0.0001', unitPrice: String(itemPrice), taxRate: '0' }],
            payment: {
              method: 'cash',
              cashLocationId: snapshot.defaults.cashLocationId ?? undefined,
              tendered: '0.0001',
            },
          },
        },
      ],
    });
    const result = payload(sync);
    check('offline-sync returns per-invoice results', sync.status === 201 && Array.isArray(result?.results));
    const row = result?.results?.[0];
    check(
      'result is synced or an actionable conflict',
      row?.status === 'synced' || row?.status === 'conflict',
      row?.errorCode ?? row?.number ?? '',
    );

    const replay = await raw('POST', '/pos/offline-sync', {
      deviceId,
      invoices: [
        {
          offlineId,
          deviceId,
          sequenceNo: 1,
          payload: {
            branchId: snapshot.defaults.branchId,
            warehouseId: snapshot.defaults.warehouseId ?? undefined,
            cashCustomerName: 'Offline verification',
            lines: [{ itemId: item.id, quantity: '0.0001', unitPrice: String(itemPrice), taxRate: '0' }],
            payment: {
              method: 'cash',
              cashLocationId: snapshot.defaults.cashLocationId ?? undefined,
              tendered: '0.0001',
            },
          },
        },
      ],
    });
    check(
      'offline-id replay is idempotent',
      replay.status === 201 && payload(replay)?.results?.[0]?.offlineId === offlineId,
    );
  } else {
    check('sync fixture available', false, 'seed at least one POS item and default branch first');
  }

  const [db, sw, manifest, page, queue] = await Promise.all([
    readFile(new URL('../apps/staff/lib/offline-db.ts', import.meta.url), 'utf8'),
    readFile(new URL('../apps/staff/public/sw.js', import.meta.url), 'utf8'),
    readFile(new URL('../apps/staff/public/manifest.webmanifest', import.meta.url), 'utf8'),
    readFile(new URL('../apps/staff/app/pos/offline/page.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../apps/staff/app/pos/offline-queue/page.tsx', import.meta.url), 'utf8'),
  ]);
  check(
    'IndexedDB queue exists',
    db.includes("DB_NAME = 'erpcloud-pos-offline'") && db.includes("createObjectStore('queue'"),
  );
  check(
    'service worker has offline navigation fallback',
    sw.includes("request.mode === 'navigate'") && sw.includes('/pos/offline'),
  );
  check('installable PWA manifest exists', JSON.parse(manifest).start_url === '/pos/offline');
  check(
    'camera fallback and 80mm print UI exists',
    page.includes('BarcodeDetector') && page.includes('إيصال 80mm'),
  );
  check(
    'queue page exposes conflict retry',
    queue.includes('إعادة المحاولة') &&
      queue.includes('retryOfflineConflict') &&
      queue.includes('syncOfflineInvoices'),
  );
}
try {
  await main();
} catch (error) {
  failures += 1;
  console.error(`✘ verification aborted: ${error instanceof Error ? error.message : String(error)}`);
}
console.log(`\n${failures ? '✘' : '✔'} offline-pos verification: ${checks} checks, ${failures} failures`);
process.exitCode = failures ? 1 : 0;
