#!/usr/bin/env node
/**
 * Regenerates the assistant's staff-screen snapshot from navigation.ts.
 * The production API image does not contain apps/staff, so chat falls back to this file.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(root, 'apps/staff/lib/navigation.ts'), 'utf8');
const pattern = /screen\(\s*'([^']+)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']+)'\s*,\s*'(ready|api|planned)'/g;
const articles = [];
for (const match of source.matchAll(pattern)) {
  const [, key, labelAr, labelEn, href, status] = match;
  if (status !== 'ready' || !href.startsWith('/')) continue;
  const keywords = [];
  for (const token of `${labelAr} ${labelEn} ${href.replaceAll('/', ' ')}`.split(/[^\p{L}\p{N}]+/u)) {
    if (token.length > 1 && !keywords.includes(token)) keywords.push(token);
  }
  articles.push({
    id: `nav:${key}`,
    title: labelAr,
    href,
    keywords: keywords.slice(0, 12),
    steps: [
      `افتح «${labelAr}» من قائمة النظام.`,
      'أدخل البيانات ثم احفظ. أي ترحيل يتم من الشاشة بعد المراجعة، لا من المساعد.',
    ],
    source: 'navigation',
  });
}

const target = join(root, 'apps/api/src/modules/ai/navigation-snapshot.ts');
const body = `import type { HelpArticle } from './ai-help.js';

/**
 * Ready staff screens extracted from \`apps/staff/lib/navigation.ts\`.
 * Production API images do not contain the staff source, so the assistant
 * falls back to this snapshot. Regenerate with \`node scripts/build-ai-navigation-snapshot.mjs\`.
 */
export const NAVIGATION_SNAPSHOT: readonly HelpArticle[] = ${JSON.stringify(articles, null, 2)};
`;
writeFileSync(target, body);
console.log(`wrote ${articles.length} screens to ${target}`);
