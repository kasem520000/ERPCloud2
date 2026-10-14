#!/usr/bin/env node
/**
 * Extracts the desktop chart of accounts (`Accounts_Index`) from the legacy
 * SQL Server scripts and generates a typed seed module for tenant provisioning.
 *
 * Sources (newest wins per account code):
 *   1. Desktop_ERP/CrystalLiteDB.txt  — base data (112 accounts)
 *   2. Desktop_ERP/AlterDb.txt        — migration overrides (same codes, newer labels)
 *
 * Desktop → cloud mapping (documented, deterministic):
 *   - `Code`            → `code` (string, kept verbatim: "1", "1211", "4100001"...)
 *   - `AName` (trimmed) → `nameAr`
 *   - `ParentCode`      → `parentCode` ("" = root); every parent must resolve
 *   - root digit        → `type`: 1=asset, 2=liability (21*=equity), 3=expense, 4=revenue
 *   - `normalBalance`   ← derived from `type`, except contra accounts:
 *       3200002/3200003 (purchase returns/discount) → credit
 *       4100002/4100003 (sales returns/discount)    → debit
 *       231* (accumulated depreciation) + 2330001 (allowance) → credit
 *   - `Type = 2`        → postable leaf; `Type = 1` → header group
 *
 * Usage: `node scripts/desktop-seed/extract-coa.mjs`
 * Output: `packages/database/src/desktop-coa.ts` (shared by provisioning + demo seed)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(root, 'packages/database/src/desktop-coa.ts');

/** Split a VALUES(...) list on commas that sit outside N'...' strings. */
function splitValues(list) {
  const parts = [];
  let current = '';
  let inString = false;
  for (let i = 0; i < list.length; i += 1) {
    const ch = list[i];
    if (ch === "'") {
      if (inString && list[i + 1] === "'") {
        current += "''";
        i += 1;
      } else {
        inString = !inString;
        current += ch;
      }
    } else if (ch === ',' && !inString) {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current.trim());
  return parts;
}

function unquote(token) {
  if (token.startsWith("N'") && token.endsWith("'")) return token.slice(2, -1).replace(/''/g, "'");
  return token;
}

function parseFile(relative) {
  const text = readFileSync(join(root, relative), 'utf8');
  const rows = new Map();
  const pattern = /INSERT \[dbo\]\.\[Accounts_Index\]\s*\(([^)]*)\)\s*VALUES \((.*?)\)\r?$/gm;
  for (const match of text.matchAll(pattern)) {
    const cols = match[1].split(',').map((c) => c.trim().replace(/^\[|\]$/g, ''));
    const vals = splitValues(match[2]).map(unquote);
    const row = Object.fromEntries(cols.map((c, i) => [c, vals[i] ?? 'NULL']));
    rows.set(row.Code, row);
  }
  return rows;
}

const CONTRA_CREDIT = new Set(['3200002', '3200003', '2330001']);
const CONTRA_DEBIT = new Set(['4100002', '4100003']);
// 231* — accumulated depreciation under long-term liabilities, credit-normal.
const isContraCredit = (code) => CONTRA_CREDIT.has(code) || code.startsWith('231');

function accountType(code) {
  if (code.startsWith('21')) return 'equity';
  const rootDigit = code[0];
  if (rootDigit === '1') return 'asset';
  if (rootDigit === '2') return 'liability';
  if (rootDigit === '3') return 'expense';
  if (rootDigit === '4') return 'revenue';
  throw new Error(`Unmapped root digit for account ${code}`);
}

function normalBalance(code, type) {
  if (CONTRA_DEBIT.has(code)) return 'debit';
  if (isContraCredit(code)) return 'credit';
  return type === 'asset' || type === 'expense' ? 'debit' : 'credit';
}

// Base first, migration overrides win.
const merged = new Map([...parseFile('Desktop_ERP/CrystalLiteDB.txt')]);
for (const [code, row] of parseFile('Desktop_ERP/AlterDb.txt')) merged.set(code, row);

const accounts = [...merged.values()]
  .map((row) => ({
    code: row.Code,
    nameAr: (row.AName === 'NULL' ? '' : row.AName).trim(),
    parentCode: row.ParentCode === 'NULL' || row.ParentCode === '' ? '' : row.ParentCode,
    type: accountType(row.Code),
    normalBalance: normalBalance(row.Code, accountType(row.Code)),
    isPostable: row.Type === '2',
  }))
  .sort((a, b) => a.code.length - b.code.length || (a.code < b.code ? -1 : 1));

// Integrity: unique codes, resolvable parents, no empty names.
const codes = new Set(accounts.map((a) => a.code));
if (codes.size !== accounts.length) throw new Error('Duplicate account codes in desktop seed');
for (const account of accounts) {
  if (!account.nameAr) throw new Error(`Empty name for account ${account.code}`);
  if (account.parentCode && !codes.has(account.parentCode)) {
    throw new Error(`Account ${account.code} references missing parent ${account.parentCode}`);
  }
}

const header = `/**
 * Desktop default chart of accounts — GENERATED, do not edit by hand.
 *
 * Regenerate: \`node scripts/desktop-seed/extract-coa.mjs\`
 * Sources: \`Desktop_ERP/CrystalLiteDB.txt\` + \`Desktop_ERP/AlterDb.txt\`
 * (${accounts.length} accounts, AlterDb overrides applied).
 *
 * Mapping rules live in the extractor. Every new tenant receives this chart
 * through \`OrgProvisioningService\`; existing tenants via \`pnpm seed:coa\`.
 */
`;

const body = `export type DesktopSeedAccount = {
  code: string;
  nameAr: string;
  /** Parent code; absent on the four roots. */
  parent?: string;
  type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  /** Always explicit — contra accounts override their type's natural side. */
  normalBalance: 'debit' | 'credit';
  /** False on header groups; absent (postable) on leaves. */
  postable?: boolean;
};

export const DESKTOP_DEFAULT_COA: DesktopSeedAccount[] = ${JSON.stringify(
  accounts.map((a) => ({
    code: a.code,
    nameAr: a.nameAr,
    ...(a.parentCode ? { parent: a.parentCode } : {}),
    type: a.type,
    normalBalance: a.normalBalance,
    ...(a.isPostable ? {} : { postable: false }),
  })),
  null,
  2,
)};
`;

writeFileSync(OUT, `${header}\n${body}`);
console.log(`wrote ${OUT} (${accounts.length} accounts)`);
