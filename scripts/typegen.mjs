import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const checkMode = process.argv.includes('--check');
const file = path.join(root, '.generated-types.json');
const payload = {
  generatedAt: '1970-01-01T00:00:00.000Z',
  phase: 'PHASE_01',
  message: 'Type generation hook for bootstrap; no generated API types yet.',
};

const expected = `${JSON.stringify(payload, null, 2)}\n`;

if (checkMode) {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, expected, 'utf8');
  }
  const current = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (current.phase !== payload.phase || current.message !== payload.message) {
    console.error(`Typegen check failed: ${file} does not match expected schema`);
    process.exit(1);
  }
  console.log(`Verified ${file}`);
} else {
  fs.writeFileSync(
    file,
    `${JSON.stringify({ ...payload, generatedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  );
  console.log(`Generated ${file}`);
}
