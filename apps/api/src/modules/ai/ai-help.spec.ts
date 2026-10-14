import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { emptyFacts, runAssistantTurn } from './ai-engine.js';
import { NAVIGATION_SNAPSHOT } from './navigation-snapshot.js';
import { navigationArticlesFromSource, workspaceHelpCorpus } from './ai-help.js';

const TENANT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function readNavigation(): string {
  for (const path of [join(process.cwd(), '../staff/lib/navigation.ts'), join(process.cwd(), 'apps/staff/lib/navigation.ts')]) {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      // try the next candidate; the monorepo layout differs by cwd
    }
  }
  throw new Error('apps/staff/lib/navigation.ts was not found');
}

describe('assistant help corpus', () => {
  it('reads ready screens from navigation.ts and keeps the snapshot in step', () => {
    const parsed = navigationArticlesFromSource(readNavigation());
    expect(parsed.map((article) => article.href)).toContain('/sales/invoices/new');
    expect(parsed.map((article) => article.href)).toContain('/accounting/accounts');
    expect(parsed.map((article) => article.href).sort()).toEqual(NAVIGATION_SNAPSHOT.map((article) => article.href).sort());
  });

  it('still explains the sales invoice from the full corpus', async () => {
    const turn = await runAssistantTurn({
      tenantId: TENANT,
      message: 'كيف أنشئ فاتورة مبيعات؟',
      facts: emptyFacts(TENANT),
      articles: workspaceHelpCorpus(),
      now: new Date('2026-09-28T09:00:00Z'),
      llm: {
        async *complete(input) {
          yield { type: 'done' as const, text: input.grounded, tokensIn: 1, tokensOut: 1 };
        },
      },
    });
    expect(turn.text).toContain('/sales/invoices/new');
    expect(turn.text).toContain('اختر الفرع والعميل');
  });

  it('points a chart-of-accounts question at the navigation screen', async () => {
    const turn = await runAssistantTurn({
      tenantId: TENANT,
      message: 'كيف أفتح دليل الحسابات؟',
      facts: emptyFacts(TENANT),
      articles: workspaceHelpCorpus(),
      now: new Date('2026-09-28T09:00:00Z'),
      llm: {
        async *complete(input) {
          yield { type: 'done' as const, text: input.grounded, tokensIn: 1, tokensOut: 1 };
        },
      },
    });
    expect(turn.hrefs).toContain('/accounting/accounts');
    expect(turn.text).toContain('دليل الحسابات');
  });
});
