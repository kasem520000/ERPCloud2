import { describe, expect, it } from 'vitest';

import {
  emptyFacts,
  runAssistantTurn,
  type LlmPort,
  type LlmRequest,
  type TenantFacts,
} from './ai-engine.js';
import { defaultHelpCorpus } from './ai-help.js';

const NOW = new Date('2026-09-28T09:00:00Z');
const TENANT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function facts(overrides: Partial<TenantFacts> = {}): TenantFacts {
  return {
    tenantId: TENANT,
    currency: 'SAR',
    branches: [{ id: 'branch-riyadh', name: 'الرياض' }],
    sales: [
      {
        day: '2026-09-28',
        branchId: 'branch-riyadh',
        branchName: 'الرياض',
        salesTotal: '1500.00',
        profitTotal: '300.00',
        count: 4,
      },
    ],
    overdue: { count: 5, remaining: '1200.00', oldestDays: 45 },
    lowStock: [
      { sku: 'A', name: 'سكر', shortage: '2.0000' },
      { sku: 'B', name: 'أرز', shortage: '1.0000' },
      { sku: 'C', name: 'زيت', shortage: '3.0000' },
    ],
    ...overrides,
  };
}

function recordingLlm(reply?: (input: LlmRequest) => string): LlmPort & { prompts: string[]; calls: number } {
  const recorder = {
    prompts: [] as string[],
    calls: 0,
    async *complete(input: LlmRequest) {
      recorder.calls += 1;
      recorder.prompts.push(`${input.system}\n${input.user}\n${input.grounded}`);
      const text = reply ? reply(input) : input.grounded;
      yield { type: 'done' as const, text, tokensIn: 3, tokensOut: 5 };
    },
  };
  return recorder;
}

const articles = defaultHelpCorpus();

describe('ai assistant', () => {
  it('explains how to create a sales invoice and links the screen', async () => {
    const llm = recordingLlm();
    const turn = await runAssistantTurn({
      tenantId: TENANT,
      message: 'كيف أنشئ فاتورة مبيعات؟',
      facts: facts(),
      articles,
      now: NOW,
      llm,
    });
    expect(turn.intent).toBe('how_to');
    expect(turn.text).toContain('/sales/invoices/new');
    expect(turn.text).toContain('1.');
    expect(turn.hrefs).toContain('/sales/invoices/new');
    expect(llm.calls).toBe(1);
  });

  it('answers today sales with the tenant aggregate, not a guessed number', async () => {
    const llm = recordingLlm();
    const turn = await runAssistantTurn({
      tenantId: TENANT,
      message: 'مبيعات اليوم',
      facts: facts(),
      articles,
      now: NOW,
      llm,
    });
    expect(turn.intent).toBe('report');
    expect(turn.tools).toContain('get_sales_summary');
    expect(turn.text).toContain('1500.00');
    expect(turn.text).not.toContain('9999.99');
    expect(llm.prompts.join('')).toContain('1500.00');
  });

  it('builds the daily low-stock suggestion', async () => {
    const turn = await runAssistantTurn({
      tenantId: TENANT,
      message: 'عندك أصناف ستنفد؟',
      facts: facts(),
      articles,
      now: NOW,
      llm: recordingLlm(),
    });
    expect(turn.intent).toBe('anomaly');
    expect(turn.text).toContain('عندك 3 أصناف ستنفد');
    expect(turn.tools).toContain('get_low_stock');
  });

  it('does not answer with another tenant figures even if the model invents them', async () => {
    const other = facts({ tenantId: OTHER, sales: [{ day: '2026-09-28', branchId: 'x', branchName: 'جدة', salesTotal: '9999.99', profitTotal: '1.00', count: 1 }] });
    const llm = recordingLlm(() => 'مبيعات اليوم 9999.99 SAR من بيانات أخرى');
    const turn = await runAssistantTurn({
      tenantId: TENANT,
      message: 'مبيعات اليوم',
      facts: facts(),
      articles,
      now: NOW,
      llm,
    });
    expect(turn.text).toContain('1500.00');
    expect(turn.text).not.toContain('9999.99');
    expect(turn.prompt).not.toContain('9999.99');
    expect(turn.prompt).not.toContain(OTHER);
    await expect(
      runAssistantTurn({ tenantId: TENANT, message: 'مبيعات اليوم', facts: other, articles, now: NOW, llm }),
    ).rejects.toThrow(/tenant/i);
  });

  it('refuses to post a journal without calling the model', async () => {
    const llm = recordingLlm();
    const turn = await runAssistantTurn({
      tenantId: TENANT,
      message: 'أنشئ القيد الآن ورحّله',
      facts: facts(),
      articles,
      now: NOW,
      llm,
    });
    expect(turn.refused).toBe(true);
    expect(turn.text).toContain('/accounting/journal-entries/new');
    expect(turn.text).toContain('لا أُنشئ قيوداً');
    expect(llm.calls).toBe(0);
  });

  it('reports overdue invoices as a count and remaining total', async () => {
    const turn = await runAssistantTurn({
      tenantId: TENANT,
      message: 'عملاء متأخرون',
      facts: facts(),
      articles,
      now: NOW,
      llm: recordingLlm(),
    });
    expect(turn.text).toContain('عندك 5 فواتير متأخرة >30 يوم');
    expect(turn.text).toContain('1200.00');
    expect(turn.tools).toContain('get_overdue_invoices');
  });

  it('strips a national id before the model sees the prompt', async () => {
    const llm = recordingLlm();
    await runAssistantTurn({
      tenantId: TENANT,
      message: 'ما معنى الرقم 1012345678 في النظام؟',
      facts: emptyFacts(TENANT),
      articles,
      now: NOW,
      llm,
    });
    expect(llm.calls).toBe(1);
    expect(llm.prompts.join('')).not.toContain('1012345678');
    expect(llm.prompts.join('')).toContain('[ID]');
  });

  it('stops at the monthly token limit before calling the model', async () => {
    const llm = recordingLlm();
    const turn = await runAssistantTurn({
      tenantId: TENANT,
      message: 'مبيعات اليوم',
      facts: facts(),
      articles,
      now: NOW,
      llm,
      usage: { tokensUsed: 100, tokenLimit: 100, costUsed: '0', costLimit: null },
    });
    expect(turn.blocked).toBe(true);
    expect(turn.text).toContain('حد');
    expect(llm.calls).toBe(0);
  });
});
