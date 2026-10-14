import { Decimal } from 'decimal.js';

import type { HelpArticle } from './ai-help.js';

/**
 * Grounded assistant turn — no database and no network.
 *
 * Numbers in an answer come only from the tenant facts passed in. A model may
 * rephrase that text, but a figure it invents is discarded. Identity numbers
 * are stripped before the prompt is built. Automatic journal posting is refused
 * without calling the model.
 */

export type Intent = 'how_to' | 'report' | 'anomaly' | 'general';
export type AiProviderName = 'openai' | 'anthropic' | 'gemini' | 'custom' | 'local';

export type SalesBucket = {
  day: string;
  branchId: string;
  branchName: string;
  salesTotal: string;
  profitTotal: string;
  count: number;
};

export type TenantFacts = {
  tenantId: string;
  currency: string;
  branches: Array<{ id: string; name: string }>;
  sales: SalesBucket[];
  overdue: { count: number; remaining: string; oldestDays: number };
  lowStock: Array<{ sku: string; name: string; shortage: string }>;
};

export type UsageSnapshot = {
  tokensUsed: number;
  tokenLimit: number | null;
  costUsed: string;
  costLimit: string | null;
};

export type LlmRequest = {
  system: string;
  user: string;
  grounded: string;
};

export type LlmEvent = {
  type: 'done';
  text: string;
  tokensIn: number;
  tokensOut: number;
};

export type LlmPort = {
  complete(input: LlmRequest): AsyncIterable<LlmEvent>;
};

export type AssistantTurn = {
  intent: Intent;
  text: string;
  tools: string[];
  hrefs: string[];
  prompt: string;
  refused: boolean;
  blocked: boolean;
  tokensIn: number;
  tokensOut: number;
};

export const AI_SKILLS = [
  {
    id: 'how_to',
    title: 'إجابة عن النظام',
    description: 'يشرح الخطوات ويربط الشاشة المناسبة.',
    example: 'كيف أنشئ فاتورة مبيعات؟',
  },
  {
    id: 'report',
    title: 'أرقام مجمعة',
    description: 'يقرأ مجاميع المبيعات والربح دون أسماء العملاء أو أرقام الهوية.',
    example: 'مبيعات اليوم',
  },
  {
    id: 'anomaly',
    title: 'اقتراحات',
    description: 'ينبّه بالفواتير المتأخرة والأصناف التي ستنفد.',
    example: 'عملاء متأخرون',
  },
] as const;

export const AI_TOOLS = ['get_sales_summary', 'get_overdue_invoices', 'get_low_stock', 'search_help'] as const;

const SYSTEM = [
  'أنت مساعد محاسبي في نظام ERP سعودي.',
  'أجب بالعربية الفصحى المبسطة، ومن السياق الموثوق فقط.',
  'لا تخترع أرقاماً، ولا تذكر بيانات مستأجر آخر، ولا تطلب رقم هوية أو راتباً تفصيلياً.',
  'لا تنشئ قيداً ولا ترحّله. إذا طُلب ذلك، ارفض وأحل إلى الشاشة.',
  'الأرقام المتاحة مجاميع فقط.',
].join(' ');

const NATIONAL_ID = /(?<!\d)[12]\d{9}(?!\d)/g;
const IBAN = /\bSA\d{22}\b/gi;
const FIGURE = /\d+\.\d{2}/g;

export function fold(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function redactSensitive(value: string): string {
  return value.replace(IBAN, '[IBAN]').replace(NATIONAL_ID, '[ID]');
}

export function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

export function riyadhDate(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Riyadh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function shiftIsoDate(iso: string, days: number): string {
  const [year, month, day] = iso.split('-').map(Number);
  const shifted = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, (day ?? 1) + days));
  return shifted.toISOString().slice(0, 10);
}

export function moneyText(value: string): string {
  return new Decimal(value || 0).toFixed(2);
}

export function classifyIntent(message: string): Intent {
  const text = fold(message);
  if (/(كيف|طريقه|اين|شرح|خطوات|how\b|where\b)/.test(text)) return 'how_to';
  if (/(متاخر|تنفد|مخزون|حد ادنى|نواقص|اقتراح|تنبيه|overdue|low stock)/.test(text)) return 'anomaly';
  if (/(مبيعات|ارباح|ربح|ايراد|sales|profit|revenue|كم)/.test(text)) return 'report';
  return 'general';
}

export function wantsAutomaticPosting(message: string): boolean {
  const text = fold(message);
  if (/(كيف|طريقه|شرح|اين)/.test(text)) return false;
  return /(انشئ|اكتب|رحل|سجل).{0,24}قيد/.test(text) || /قيد.{0,24}(تلقائي|بدون مراجع|مباشر)/.test(text);
}

export function parsePeriod(message: string, now: Date): { from: string; to: string; label: string } {
  const today = riyadhDate(now);
  const text = fold(message);
  if (/امس|yesterday/.test(text)) {
    const day = shiftIsoDate(today, -1);
    return { from: day, to: day, label: 'أمس' };
  }
  if (/هذا الشهر|الشهر الحالي|خلال الشهر|this month/.test(text)) {
    return { from: `${today.slice(0, 7)}-01`, to: today, label: 'هذا الشهر' };
  }
  if (/ربح/.test(text) && /فرع/.test(text) && !/اليوم|today/.test(text)) {
    return { from: `${today.slice(0, 7)}-01`, to: today, label: 'هذا الشهر' };
  }
  return { from: today, to: today, label: 'اليوم' };
}

export function emptyFacts(tenantId: string): TenantFacts {
  return {
    tenantId,
    currency: 'SAR',
    branches: [],
    sales: [],
    overdue: { count: 0, remaining: '0.00', oldestDays: 0 },
    lowStock: [],
  };
}

export class TenantMismatchError extends Error {
  constructor() {
    super('AI facts do not belong to the requested tenant');
    this.name = 'TenantMismatchError';
  }
}

export function assertFactsTenant(facts: TenantFacts, tenantId: string): void {
  if (facts.tenantId !== tenantId) throw new TenantMismatchError();
}

export type Suggestion = { kind: 'low_stock' | 'overdue_invoices'; title: string; body: string };

export function buildSuggestions(facts: TenantFacts): Suggestion[] {
  const suggestions: Suggestion[] = [];
  if (facts.lowStock.length > 0) {
    const names = facts.lowStock
      .slice(0, 5)
      .map((row) => redactSensitive(row.name))
      .join('، ');
    suggestions.push({
      kind: 'low_stock',
      title: 'أصناف قاربت على النفاد',
      body: `عندك ${facts.lowStock.length} أصناف ستنفد${names ? `: ${names}` : ''}.`,
    });
  }
  if (facts.overdue.count > 0) {
    suggestions.push({
      kind: 'overdue_invoices',
      title: 'فواتير متأخرة',
      body: `عندك ${facts.overdue.count} فواتير متأخرة >30 يوم، والمتبقي ${moneyText(facts.overdue.remaining)} ${facts.currency}.`,
    });
  }
  return suggestions;
}

type HelpHit = HelpArticle & { score: number };

export function searchHelp(query: string, articles: readonly HelpArticle[], intent: Intent = 'general'): HelpHit[] {
  const folded = fold(query);
  const tokens = folded.split(' ').filter((token) => token.length > 1);
  const ranked = articles
    .map((article) => {
      const title = fold(article.title);
      const keywords = article.keywords.map((keyword) => fold(keyword));
      let score = 0;
      for (const token of tokens) {
        if (keywords.some((keyword) => keyword.includes(token) || token.includes(keyword))) score += 3;
        if (title.includes(token)) score += 2;
      }
      if (intent === 'how_to' && article.steps.length > 0) score += 4;
      if (intent === 'how_to' && article.source === 'navigation') score += 3;
      if (intent === 'how_to' && article.source === 'navigation' && !article.id.startsWith('nav:')) score += 8;
      if (folded.includes('فاتوره مبيعات') && /(انش|اضف|جديد)/.test(folded) && article.href === '/sales/invoices/new') {
        score += 40;
      }
      if (folded.includes('قيد') && article.href === '/accounting/journal-entries/new' && intent === 'how_to') score += 20;
      return { ...article, score };
    })
    .filter((article) => article.score > 0)
    .sort((left, right) => right.score - left.score);
  return ranked.slice(0, 3);
}

function sumSales(facts: TenantFacts, from: string, to: string, branchId?: string) {
  let salesTotal = new Decimal(0);
  let profitTotal = new Decimal(0);
  let count = 0;
  for (const row of facts.sales) {
    if (row.day < from || row.day > to) continue;
    if (branchId && row.branchId !== branchId) continue;
    salesTotal = salesTotal.plus(row.salesTotal);
    profitTotal = profitTotal.plus(row.profitTotal);
    count += row.count;
  }
  return { salesTotal: salesTotal.toFixed(2), profitTotal: profitTotal.toFixed(2), count };
}

function matchBranch(message: string, facts: TenantFacts): { id: string; name: string } | 'missing' | null {
  const match = message.match(/فرع\s+([^\s،.?!]+)/);
  const needle = match?.[1] ? fold(match[1]) : '';
  if (!needle) return null;
  const found = facts.branches.find((branch) => {
    const name = fold(branch.name);
    return name.includes(needle) || needle.includes(name);
  });
  return found ?? 'missing';
}

function composeReport(message: string, facts: TenantFacts, now: Date): { text: string; tools: string[] } {
  const period = parsePeriod(message, now);
  const branch = matchBranch(message, facts);
  if (branch === 'missing') {
    const names = facts.branches.map((entry) => entry.name).join('، ') || 'لا فروع مسجلة';
    return {
      tools: ['get_sales_summary'],
      text: `لم أجد فرعاً بهذا الاسم في منشأتك. لا أستخدم أرقام فرع آخر. الفروع: ${names}.`,
    };
  }
  const summary = sumSales(facts, period.from, period.to, branch?.id);
  const scope = branch ? `فرع ${branch.name}` : 'كل الفروع';
  const askingProfit = /ربح|ارباح/.test(fold(message));
  const headline = askingProfit
    ? `ربح ${scope} خلال ${period.label} (${period.from} إلى ${period.to}): ${summary.profitTotal} ${facts.currency}.`
    : `مبيعات ${period.label} (${period.from}) — ${scope}: ${summary.salesTotal} ${facts.currency} من ${summary.count} فواتير.`;
  return {
    tools: ['get_sales_summary'],
    text: `${headline} الربح ${summary.profitTotal} ${facts.currency}. هذه مجاميع فواتير مرحّلة، بلا أسماء عملاء أو أرقام هوية.`,
  };
}

function composeHowTo(message: string, articles: readonly HelpArticle[]): { text: string; tools: string[]; hrefs: string[] } {
  const hit = searchHelp(message, articles, 'how_to')[0];
  if (!hit) {
    return {
      tools: ['search_help'],
      hrefs: ['/reports'],
      text: 'لم أجد شاشة مطابقة. ابحث من القائمة أو افتح مركز التقارير.\nالشاشة: /reports',
    };
  }
  const steps = hit.steps.map((step, index) => `${index + 1}. ${step}`).join('\n');
  return {
    tools: ['search_help'],
    hrefs: [hit.href],
    text: `${hit.title}\n${steps}\nالشاشة: ${hit.href}`,
  };
}

function composeAnomaly(facts: TenantFacts): { text: string; tools: string[] } {
  const suggestions = buildSuggestions(facts);
  if (suggestions.length === 0) {
    return {
      tools: ['get_overdue_invoices', 'get_low_stock'],
      text: 'لا توجد تنبيهات حالياً: لا أصناف تحت الحد الأدنى ولا فواتير متأخرة أكثر من 30 يوماً.',
    };
  }
  return {
    tools: ['get_overdue_invoices', 'get_low_stock'],
    text: suggestions.map((suggestion) => suggestion.body).join('\n'),
  };
}

export function composeGrounded(
  message: string,
  intent: Intent,
  facts: TenantFacts,
  articles: readonly HelpArticle[],
  now: Date,
): { text: string; tools: string[]; hrefs: string[] } {
  if (intent === 'how_to') return composeHowTo(message, articles);
  if (intent === 'report') {
    const report = composeReport(message, facts, now);
    return { ...report, hrefs: ['/reports/net-sales'] };
  }
  if (intent === 'anomaly') return { ...composeAnomaly(facts), hrefs: ['/sales/invoices', '/inventory/items'] };
  const hint = AI_SKILLS.map((skill) => `• ${skill.example}`).join('\n');
  return {
    tools: ['search_help'],
    hrefs: ['/assistant'],
    text: `يمكنني شرح الشاشات، أو قراءة مجاميع منشأتك، أو عرض التنبيهات. جرّب:\n${hint}`,
  };
}

export function buildModelPrompt(message: string, grounded: string, intent: Intent): { system: string; user: string } {
  return {
    system: SYSTEM,
    user: [
      `نية السؤال: ${intent}`,
      `السؤال بعد الإخفاء: ${redactSensitive(message)}`,
      '',
      'السياق الموثوق (مجاميع هذا المستأجر فقط):',
      redactSensitive(grounded),
      '',
      'أجب بالعربية من السياق فقط. لا تضف أرقاماً غير موجودة فيه.',
    ].join('\n'),
  };
}

export function unknownFigures(text: string, allowed: string): string[] {
  const known = new Set(allowed.match(FIGURE) ?? []);
  return (text.match(FIGURE) ?? []).filter((figure) => !known.has(figure));
}

export function guardAnswer(text: string, grounded: string): string {
  const cleaned = redactSensitive(text).trim();
  if (!cleaned) return grounded;
  if (unknownFigures(cleaned, grounded).length > 0) return grounded;
  return cleaned;
}

export function limitText(): string {
  return 'وصلت حد استهلاك المساعد لهذا الشهر. يمكن لمدير المنشأة رفع الحد من إعدادات المساعد، أو انتظار بداية الشهر التالي.';
}

export function refusalText(): string {
  return 'لا أُنشئ قيوداً تلقائياً ولا أرحّلها بدون مراجعتك. افتح قيد يومية، راجع المدين والدائن، ثم رحّله من الشاشة.\nالشاشة: /accounting/journal-entries/new';
}

export function overLimit(usage: UsageSnapshot | undefined): boolean {
  if (!usage) return false;
  if (usage.tokenLimit !== null && usage.tokensUsed >= usage.tokenLimit) return true;
  if (usage.costLimit !== null && new Decimal(usage.costUsed || 0).gte(usage.costLimit)) return true;
  return false;
}

export async function runAssistantTurn(input: {
  tenantId: string;
  message: string;
  facts: TenantFacts;
  articles: readonly HelpArticle[];
  now?: Date;
  llm?: LlmPort;
  usage?: UsageSnapshot;
}): Promise<AssistantTurn> {
  assertFactsTenant(input.facts, input.tenantId);
  const now = input.now ?? new Date();
  const message = redactSensitive(input.message).slice(0, 2000);
  const intent = classifyIntent(message);

  if (overLimit(input.usage)) {
    const text = limitText();
    return {
      intent,
      text,
      tools: [],
      hrefs: ['/settings/ai'],
      prompt: '',
      refused: true,
      blocked: true,
      tokensIn: 0,
      tokensOut: 0,
    };
  }

  if (wantsAutomaticPosting(input.message)) {
    const text = refusalText();
    return {
      intent: 'how_to',
      text,
      tools: [],
      hrefs: ['/accounting/journal-entries/new'],
      prompt: '',
      refused: true,
      blocked: false,
      tokensIn: 0,
      tokensOut: estimateTokens(text),
    };
  }

  const grounded = composeGrounded(message, intent, input.facts, input.articles, now);
  const prompt = buildModelPrompt(message, grounded.text, intent);
  const llm = input.llm;
  let text = grounded.text;
  let tokensIn = estimateTokens(`${prompt.system}\n${prompt.user}`);
  let tokensOut = estimateTokens(text);
  if (llm) {
    let produced = '';
    for await (const event of llm.complete({ system: prompt.system, user: prompt.user, grounded: grounded.text })) {
      produced = event.text || produced;
      tokensIn = event.tokensIn || tokensIn;
      tokensOut = event.tokensOut || estimateTokens(produced);
    }
    text = guardAnswer(produced, grounded.text);
  }

  return {
    intent,
    text,
    tools: grounded.tools,
    hrefs: grounded.hrefs,
    prompt: `${prompt.system}\n${prompt.user}`,
    refused: false,
    blocked: false,
    tokensIn,
    tokensOut,
  };
}

export function streamText(text: string, size = 24): string[] {
  const pieces: string[] = [];
  for (let index = 0; index < text.length; index += size) pieces.push(text.slice(index, index + size));
  return pieces.length > 0 ? pieces : [''];
}
