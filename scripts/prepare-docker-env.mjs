#!/usr/bin/env node
/* eslint-disable no-console */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, '.env');
const target = join(root, 'deploy', '.env');
const force = process.argv.includes('--force');

if (!existsSync(source) || readFileSync(source, 'utf8').trim() === '') {
  console.error('Root .env is missing or empty. Run `pnpm env:setup` first.');
  process.exit(1);
}

if (existsSync(target) && !force) {
  console.log('deploy/.env already exists; leaving it unchanged (use --force to regenerate).');
  process.exit(0);
}

const content = readFileSync(source, 'utf8').replace(
  /^([\t ]*[A-Za-z_][A-Za-z0-9_]*=)(.*)$/gm,
  (_match, assignment, value) =>
    value.includes('$') ? assignment + "'" + value.replace(/'/g, "\\'") + "'" : assignment + value,
);

writeFileSync(target, content, { mode: 0o600 });
console.log('Generated deploy/.env from the root environment without displaying values.');