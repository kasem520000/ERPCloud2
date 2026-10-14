#!/usr/bin/env node
import { writeFileSync } from 'node:fs';

import { MigrationEngine } from './engine.js';
import { registryMaps } from './registry/maps.js';
import { migrationModes, type MigrationMode } from './types.js';

const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (key?.startsWith('--') && value && !value.startsWith('--')) { args.set(key.slice(2), value); index += 1; }
}

if (process.argv.includes('--help')) {
  console.log('Usage: migrator --mode analyze|dry_run|import|reconcile|rollback --tenant <uuid> [--out result.json]');
  process.exit(0);
}

const mode = args.get('mode') as MigrationMode | undefined;
if (!mode || !migrationModes.includes(mode)) throw new Error('mode is required');
const tenant = args.get('tenant') ?? '00000000-0000-4000-8000-000000000015';
const engine = new MigrationEngine({ tenantId: tenant });
const importRun = mode === 'reconcile' || mode === 'rollback' ? await engine.start('import') : undefined;
const run = await engine.start(mode);
const output = JSON.stringify({ run, prerequisiteRunId: importRun?.id, registry: registryMaps.map(({ transform: _transform, ...map }) => map) }, null, 2);
const out = args.get('out');
if (out) writeFileSync(out, output);
else console.log(output);
