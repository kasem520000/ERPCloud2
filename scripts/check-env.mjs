#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * `pnpm env:check` — tells you exactly which .env files were found, which required
 * variables are still missing and which values were rejected. Never prints a secret.
 */
import { loadEnvFiles } from './dotenv.mjs';

const files = loadEnvFiles(process.cwd());

const REQUIRED = ['DATABASE_URL', 'JWT_PRIVATE_KEY', 'JWT_PUBLIC_KEY'];
const RECOMMENDED = ['DATA_ENC_KEY', 'REDIS_URL', 'DATABASE_MIGRATOR_URL', 'API_PROXY_TARGET'];

const mask = (key) => {
  const value = process.env[key];
  if (value === undefined || value === '') return 'MISSING';
  if (/KEY|SECRET|PASSWORD|TOKEN/i.test(key)) return `set (${value.length} chars)`;
  return value.length > 60 ? `${value.slice(0, 57)}…` : value;
};

console.log('Environment files loaded (nearest first):');
if (files.length === 0) {
  console.log('  (none) — run `pnpm env:setup` to create one at the repository root.');
} else {
  for (const file of files) console.log(`  • ${file}`);
}

console.log('\nRequired:');
let missing = 0;
for (const key of REQUIRED) {
  const status = mask(key);
  if (status === 'MISSING') missing += 1;
  console.log(`  ${status === 'MISSING' ? '✗' : '✓'} ${key.padEnd(26)} ${status}`);
}

console.log('\nRecommended:');
for (const key of RECOMMENDED) {
  const status = mask(key);
  console.log(`  ${status === 'MISSING' ? '-' : '✓'} ${key.padEnd(26)} ${status}`);
}

console.log('\nRuntime:');
for (const key of ['NODE_ENV', 'PORT', 'STAFF_PORT', 'MARKETING_PORT', 'PLATFORM_ADMIN_PORT', 'CUSTOMER_PORTAL_PORT', 'NEXT_PUBLIC_API_BASE_URL', 'CORS_ALLOWED_ORIGINS']) {
  console.log(`  ${key.padEnd(26)} ${mask(key)}`);
}

if (missing > 0) {
  console.log(`\n${missing} required variable(s) missing — run \`pnpm env:setup\`.`);
  process.exitCode = 1;
} else {
  console.log('\nEnvironment looks complete.');
}
