#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * `pnpm env:setup` — create a working `.env` at the repository root.
 *
 * Copies every documented variable from `.env.example` and fills in the values that
 * cannot have a default:
 *
 *   • the RS256 JWT key pair, the AES-256-GCM data-encryption key and the file-URL
 *     signing secret;
 *   • the four seed passwords (platform operator, demo owner, accountant, cashier), so
 *     `pnpm db:seed` produces accounts that can actually sign in without the operator
 *     inventing anything. They are written in clear text into `.env` (mode 0600, and
 *     git-ignored) and printed once below — this is a development convenience, a
 *     production deployment supplies its own.
 *
 * Never overwrites an existing `.env` unless `--force` is passed.
 */
import { generateKeyPairSync, randomBytes, randomInt } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const target = join(root, '.env');
const force = process.argv.includes('--force');

if (existsSync(target) && !force) {
  console.log(`.env already exists at ${target} — nothing to do (use --force to regenerate).`);
  process.exit(0);
}

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const escape = (pem) => pem.trim().replace(/\r?\n/g, '\\n');
const dataEncKey = randomBytes(32).toString('base64');
const fileSigningSecret = randomBytes(32).toString('base64');
const compatPepper = randomBytes(32).toString('base64');

/**
 * A password that satisfies the platform policy by construction: 20 characters, four
 * character classes, no dictionary word and nothing derived from the account it belongs
 * to. Ambiguous glyphs (O/0, l/1) are left out so it survives being read off a screen.
 */
function strongPassword() {
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const digits = '23456789';
  const symbols = '!@#$%^&*?-_+=';
  const all = lower + upper + digits + symbols;

  const pick = (alphabet) => alphabet[randomInt(alphabet.length)];
  // One of each class first, so the class requirement can never fail by chance.
  const chars = [pick(lower), pick(upper), pick(digits), pick(symbols)];
  while (chars.length < 20) chars.push(pick(all));

  // Fisher–Yates with a CSPRNG so the guaranteed characters are not always in front.
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

const seedPasswords = {
  PLATFORM_ADMIN_PASSWORD: strongPassword(),
  DEMO_OWNER_PASSWORD: strongPassword(),
  DEMO_ACCOUNTANT_PASSWORD: strongPassword(),
  DEMO_CASHIER_PASSWORD: strongPassword(),
};

const templatePath = join(root, '.env.example');
let content = existsSync(templatePath) ? readFileSync(templatePath, 'utf8') : '';

const replacements = {
  JWT_PRIVATE_KEY: `"${escape(privateKey)}"`,
  JWT_PUBLIC_KEY: `"${escape(publicKey)}"`,
  DATA_ENC_KEY: dataEncKey,
  FILE_URL_SIGNING_SECRET: fileSigningSecret,
  COMPAT_KEY_PEPPER: compatPepper,
  ...seedPasswords,
};

for (const [key, value] of Object.entries(replacements)) {
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  content = pattern.test(content) ? content.replace(pattern, `${key}=${value}`) : `${content}\n${key}=${value}\n`;
}

writeFileSync(target, content, { mode: 0o600 });

const readEnv = (key) => {
  const match = content.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return match ? match[1].trim() : '';
};

console.log(`Wrote ${target}`);
console.log('  • generated a fresh RS256 key pair (JWT_PRIVATE_KEY / JWT_PUBLIC_KEY)');
console.log('  • generated DATA_ENC_KEY, FILE_URL_SIGNING_SECRET and COMPAT_KEY_PEPPER (32 random bytes each)');
console.log('  • generated the four seed passwords listed below');
console.log('');
console.log('Accounts `pnpm db:seed` will create (also stored in .env):');
console.log('');
console.log(`  platform console  ${readEnv('PLATFORM_ADMIN_EMAIL')}`);
console.log(`    tenant code     ${readEnv('PLATFORM_TENANT_CODE') || 'platform'}`);
console.log(`    password        ${seedPasswords.PLATFORM_ADMIN_PASSWORD}`);
console.log('');
console.log(`  company owner     ${readEnv('DEMO_OWNER_EMAIL')}`);
console.log(`    tenant code     ${readEnv('DEMO_TENANT_CODE') || 'demo'}`);
console.log(`    password        ${seedPasswords.DEMO_OWNER_PASSWORD}`);
console.log('');
console.log(`  accountant        ${readEnv('DEMO_ACCOUNTANT_EMAIL')}  /  ${seedPasswords.DEMO_ACCOUNTANT_PASSWORD}`);
console.log(`  cashier           ${readEnv('DEMO_CASHIER_EMAIL')}  /  ${seedPasswords.DEMO_CASHIER_PASSWORD}`);
console.log('');
console.log('Next steps:');
console.log('  1. pnpm db:up            # postgres + redis + minio via docker compose');
console.log('  2. pnpm db:roles         # create the erp_api / erp_migrator roles');
console.log('  3. pnpm db:migrate       # apply the SQL migrations');
console.log('  4. pnpm db:seed          # reads the passwords above from .env');
console.log('  5. pnpm dev              # api :3000, admin :3001, customer :3002');
