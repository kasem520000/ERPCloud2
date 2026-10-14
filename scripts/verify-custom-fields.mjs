#!/usr/bin/env node
/** Live smoke verification for Future Enhancement 05.
 * Run against a migrated API with VERIFY_TENANT/VERIFY_EMAIL/DEMO_OWNER_PASSWORD set.
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
let fieldId = '';
let reportId = '';
let partyId = '';

function check(label, condition, detail = '') {
  checks += 1;
  if (condition) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
async function raw(method, path, body, auth = token) {
  const response = await fetch(`${base}${path}`, { method, headers: { accept: 'application/json', 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let parsed = {}; try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { text }; }
  return { status: response.status, body: parsed };
}
const payload = (response) => response.body?.data ?? response.body;
const rows = (response) => { const value = payload(response); return Array.isArray(value) ? value : []; };
function verificationValue(field) {
  switch (field.type) {
    case 'number': return 1;
    case 'date': return '2026-09-27';
    case 'boolean': return true;
    case 'select': return Array.isArray(field.options) ? field.options[0] : undefined;
    default: return 'verification';
  }
}

async function main() {
  console.log(`■ custom fields verification @ ${tenantCode}`);
  const login = await raw('POST', '/auth/login', { tenantCode, email, password }, '');
  token = payload(login)?.accessToken ?? '';
  check('owner login', login.status === 200 && Boolean(token));
  if (!token) throw new Error('No access token');

  const fieldsBefore = await raw('GET', '/custom-fields?entity=party');
  check('field definitions endpoint', fieldsBefore.status === 200 && Array.isArray(payload(fieldsBefore)));
  const party = await raw('POST', '/parties', { kind: 'customer', name: `Phase 05 verification ${randomUUID().slice(0, 8)}` });
  partyId = payload(party)?.id ?? '';
  check('temporary party exists', party.status === 201 && Boolean(partyId));

  const create = await raw('POST', '/custom-fields', { entity: 'party', key: `verify_${Date.now().toString(36)}`, label: 'Verification date', type: 'date', required: true });
  fieldId = payload(create)?.id ?? '';
  check('date field creation', create.status === 201 && Boolean(fieldId));
  check('date type returned', payload(create)?.type === 'date');

  const required = await raw('PUT', '/custom-fields/values', { entity: 'party', entityId: partyId, values: {} });
  check('required value is enforced', required.status >= 400 && required.status < 500);
  const fieldDefinitions = rows(await raw('GET', '/custom-fields?entity=party'));
  const validValues = Object.fromEntries(fieldDefinitions
    .filter((field) => field.required)
    .map((field) => [field.key, verificationValue(field)])
    .filter(([, value]) => value !== undefined));
  validValues[payload(create)?.key] = '2026-09-27';
  const save = await raw('PUT', '/custom-fields/values', { entity: 'party', entityId: partyId, values: validValues });
  check('date value saves', save.status === 200);
  const values = await raw('GET', `/custom-fields/${fieldId}/values?entity_id=${partyId}`);
  check('saved value reads in card API', values.status === 200 && rows(values).some((field) => field.value === '2026-09-27'));

  const bad = await raw('PUT', `/custom-fields/${fieldId}/values`, { entity: 'party', entityId: partyId, value: 'not-a-date' });
  check('invalid date is rejected', bad.status >= 400 && bad.status < 500);
  const duplicate = await raw('POST', '/custom-fields', { entity: 'party', key: payload(create)?.key, label: 'Duplicate', type: 'date' });
  check('tenant/entity key is unique', duplicate.status === 409 || duplicate.status === 400);

  const report = await raw('POST', '/custom-reports', { name: `Phase 05 report ${Date.now()}`, baseEntity: 'party', columns: [{ source: 'native', key: 'name' }, { source: 'custom', key: payload(create)?.key }], filters: [], chartType: 'bar', isPublic: false });
  reportId = payload(report)?.id ?? '';
  check('custom report creation', report.status === 201 && Boolean(reportId));
  const run = await raw('POST', `/custom-reports/${reportId}/run`, {});
  check('report run returns rows and chart', run.status === 201 && Array.isArray(payload(run)?.rows) && payload(run)?.chart?.type === 'bar');
  const csv = await raw('POST', `/custom-reports/${reportId}/export`, { format: 'csv' });
  check('CSV export', csv.status === 201 && payload(csv)?.format === 'csv');
  const pdf = await raw('POST', `/custom-reports/${reportId}/export`, { format: 'pdf' });
  check('PDF/printable export', pdf.status === 201 && payload(pdf)?.printable === true);

  const migration = await readFile(new URL('../packages/database/migrations/0101_custom_fields_reports.sql', import.meta.url), 'utf8');
  check('migration follows approval migration 0100', migration.includes('custom_fields') && migration.includes('custom_reports'));
  check('migration enables RLS for all three tables', migration.includes("['custom_fields', 'custom_field_values', 'custom_reports']") && migration.includes('ROW LEVEL SECURITY'));
  check('migration seeds the four permissions', ['custom_fields.manage', 'custom_fields.view', 'custom_reports.manage', 'custom_reports.view'].every((code) => migration.includes(code)));
}
try { await main(); } catch (error) { failures += 1; console.error(`✘ verification aborted: ${error instanceof Error ? error.message : String(error)}`); }
console.log(`\n${failures ? '✘' : '✔'} custom-fields verification: ${checks} checks, ${failures} failures`);
process.exitCode = failures ? 1 : 0;
