import { writeFileSync } from 'node:fs';

import { registryMaps } from './registry/maps.js';

const rows = registryMaps.map((map) => `| ${map.wave} | ${map.entity} | ${map.legacyTable} | ${map.target} | ${map.dependsOn?.join(', ') ?? ''} | ${map.quirks.join(' ')} |`);
writeFileSync(new URL('../docs/registry-index.md', import.meta.url), `# Migration Registry Index\n\nGenerated registry summary for Phase 15.\n\n| Wave | Entity | Legacy table | Target | Dependencies | Notes |\n|---|---|---|---|---|---|\n${rows.join('\n')}\n`);
