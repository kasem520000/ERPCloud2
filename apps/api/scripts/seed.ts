/**
 * `pnpm db:seed` — initial data for a fresh database (PHASE_03 §5.7).
 *
 * Two layers, both idempotent:
 *
 *   1. `seedPlatform`  — permission registry, the demo tenant, its owner, the three
 *                        baseline roles, tenant settings, and the platform operator
 *                        (super admin) plus the internal `platform` tenant it logs into.
 *   2. `seedDemoData`  — everything needed to actually *use* the product on first login:
 *                        the billing catalogue and an active licence, organisation
 *                        defaults (currency, branch, warehouse, safe, bank, price list),
 *                        an Arabic chart of accounts wired to the safe and the bank,
 *                        cost centres, the fiscal year with twelve periods, a posted
 *                        opening entry, and an accountant + cashier user.
 *
 * The script lives in the API app because hashing a password is a platform-module
 * concern (Argon2id, PROJECT_CONTRACT §9); `packages/database` only ever receives the
 * finished hash. No password is invented here — an account whose password variable is
 * empty is created as `invited` / `must_change_password`.
 *
 * Usage:
 *   DATABASE_MIGRATOR_URL=postgres://… pnpm db:seed
 *
 * Relevant variables (all optional, all readable in `.env.example`):
 *   DEMO_TENANT_CODE / DEMO_TENANT_NAME / DEMO_OWNER_EMAIL / DEMO_OWNER_NAME / DEMO_OWNER_PASSWORD
 *   PLATFORM_ADMIN_EMAIL / PLATFORM_ADMIN_NAME / PLATFORM_ADMIN_PASSWORD / PLATFORM_TENANT_CODE
 *   DEMO_ACCOUNTANT_EMAIL / DEMO_ACCOUNTANT_NAME / DEMO_ACCOUNTANT_PASSWORD
 *   DEMO_CASHIER_EMAIL / DEMO_CASHIER_NAME / DEMO_CASHIER_PASSWORD
 *   SEED_DEMO_DATA (default true) / DEMO_FISCAL_YEAR / DEMO_PLAN_CODE /
 *   DEMO_SUBSCRIPTION_MONTHS / DEMO_OPENING_ENTRY (default true)
 */
import { env } from '@erp/config';
import { type DemoUserSpec, seedDemoData, seedPlatform } from '@erp/database';

import { PasswordService } from '../src/modules/platform/auth/password.service.js';

const passwords = new PasswordService();

/** Hashes a password after checking it against the policy, or reports why it was skipped. */
async function hashOrSkip(
  label: string,
  email: string,
  password: string | undefined,
  fullName?: string,
): Promise<string | undefined> {
  if (!password) {
    console.log(`  ${label}: no password variable set — created as invited (must set a password to sign in).`);
    return undefined;
  }
  passwords.assertPolicy(password, { email, fullName });
  return passwords.hash(password);
}

function flag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(raw.trim().toLowerCase());
}

function positiveInt(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw || raw.trim() === '') return undefined;
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

async function main(): Promise<void> {
  const connectionString = env.DATABASE_MIGRATOR_URL ?? env.DATABASE_URL;

  const tenantCode = process.env.DEMO_TENANT_CODE ?? 'demo';
  const ownerEmail = process.env.DEMO_OWNER_EMAIL ?? 'owner@demo.test';
  const ownerName = process.env.DEMO_OWNER_NAME ?? 'مالك الحساب';
  const adminEmail = process.env.PLATFORM_ADMIN_EMAIL;
  const adminName = process.env.PLATFORM_ADMIN_NAME;

  console.log('hashing credentials…');
  const ownerPasswordHash = await hashOrSkip('owner', ownerEmail, process.env.DEMO_OWNER_PASSWORD, ownerName);
  const platformAdminPasswordHash = adminEmail
    ? await hashOrSkip('platform admin', adminEmail, process.env.PLATFORM_ADMIN_PASSWORD, adminName)
    : undefined;

  // ---------------------------------------------------------------- layer 1: platform
  const report = await seedPlatform(connectionString, {
    platformAdminEmail: adminEmail,
    platformAdminFullName: adminName,
    platformAdminPasswordHash,
    platformTenantCode: process.env.PLATFORM_TENANT_CODE,
    tenantCode,
    tenantName: process.env.DEMO_TENANT_NAME,
    ownerEmail,
    ownerFullName: ownerName,
    ownerPasswordHash,
    log: (message) => console.log(message),
  });

  console.log(
    `seed  platform — tenant ${report.tenantId}, owner ${report.userId}, ` +
      `roles [${report.roles.join(', ')}], ${report.permissions} permissions` +
      (report.platformAdminUserId ? `, operator ${report.platformAdminUserId}` : ''),
  );

  if (!flag('SEED_DEMO_DATA', true)) {
    console.log('SEED_DEMO_DATA=false — skipping the demo dataset.');
    printCredentials({ tenantCode, ownerEmail, adminEmail, platformTenantCode: report.platformTenantCode, extra: [] });
    return;
  }

  // ------------------------------------------------------------------ layer 2: demo
  const accountantEmail = process.env.DEMO_ACCOUNTANT_EMAIL ?? `accountant@${tenantCode}.test`;
  const accountantName = process.env.DEMO_ACCOUNTANT_NAME ?? 'محاسب الشركة';
  const cashierEmail = process.env.DEMO_CASHIER_EMAIL ?? `cashier@${tenantCode}.test`;
  const cashierName = process.env.DEMO_CASHIER_NAME ?? 'أمين الصندوق';

  const users: DemoUserSpec[] = [
    {
      email: accountantEmail,
      fullName: accountantName,
      roleName: 'Accountant',
      passwordHash: await hashOrSkip('accountant', accountantEmail, process.env.DEMO_ACCOUNTANT_PASSWORD, accountantName),
    },
    {
      email: cashierEmail,
      fullName: cashierName,
      roleName: 'Cashier',
      passwordHash: await hashOrSkip('cashier', cashierEmail, process.env.DEMO_CASHIER_PASSWORD, cashierName),
    },
  ];

  const demo = await seedDemoData(connectionString, {
    tenantCode,
    fiscalYear: positiveInt('DEMO_FISCAL_YEAR'),
    planCode: process.env.DEMO_PLAN_CODE,
    subscriptionMonths: positiveInt('DEMO_SUBSCRIPTION_MONTHS'),
    withOpeningEntry: flag('DEMO_OPENING_ENTRY', true),
    users,
    log: (message) => console.log(message),
  });

  console.log(
    `seed  demo — ${demo.accounts} accounts, ${demo.costCenters} cost centers, ${demo.periods} periods, ` +
      `subscription ${demo.subscription}` +
      (demo.openingEntryNumber ? `, opening entry ${demo.openingEntryNumber}` : ''),
  );

  printCredentials({
    tenantCode,
    ownerEmail,
    adminEmail,
    platformTenantCode: report.platformTenantCode,
    extra: demo.users.map((user) => ({ email: user.email, role: user.role, status: user.status })),
  });
}

/** A single, copy-pasteable summary — the first thing an operator needs after seeding. */
function printCredentials(input: {
  tenantCode: string;
  ownerEmail: string;
  adminEmail?: string;
  platformTenantCode?: string;
  extra: Array<{ email: string; role: string; status: string }>;
}): void {
  const has = (name: string) => (process.env[name] ? 'set in .env' : 'NOT SET → invited');

  console.log('');
  console.log('──────────────────────────────────────────────────────────────');
  console.log(' Sign-in details');
  console.log('──────────────────────────────────────────────────────────────');
  if (input.adminEmail) {
    console.log(' Platform console  http://localhost:3001/platform');
    console.log(`   tenant code     ${input.platformTenantCode ?? 'platform'}`);
    console.log(`   email           ${input.adminEmail}`);
    console.log(`   password        PLATFORM_ADMIN_PASSWORD (${has('PLATFORM_ADMIN_PASSWORD')})`);
    console.log('');
  }
  console.log(' Company workspace  http://localhost:3001');
  console.log(`   tenant code     ${input.tenantCode}`);
  console.log(`   owner           ${input.ownerEmail}`);
  console.log(`   password        DEMO_OWNER_PASSWORD (${has('DEMO_OWNER_PASSWORD')})`);
  for (const user of input.extra) {
    console.log(`   ${user.role.padEnd(14)}  ${user.email} (${user.status})`);
  }
  console.log('──────────────────────────────────────────────────────────────');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
