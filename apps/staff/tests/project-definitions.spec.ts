import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { allScreens, findScreenByHref } from '../lib/navigation.js';
import {
  STAGE_REFUSALS,
  boqLineValue,
  boqSum,
  canMove,
  missingBoqField,
  moveStage,
  nextStageOrder,
  sortStages,
  stageNumbers,
  stageStatusLabel,
} from '../lib/project-definitions.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * R11 — 🏗️ «مراحل مشروع» و📋 «بطاقة بند» و🧵 «أنواع التفصيل».
 *
 * الأحكام هنا هي التي تفصل «زرٌّ يفعل ما في النافذة» عن «زرٌّ يفعل شيئاً آخر»:
 * الإضافة في الذيل (`newOrder = count + 1` · `frmProjectStagesPM.xaml.cs:236`)،
 * والطرفان لا يتحرّكان، والحذف يُعيد الترقيم 1..n، والقيمة لا تمرّ بمنزلةٍ عائمة.
 * ونصوص الرفض منقولةٌ بنصّها في `lib/project-definitions.ts` عن النافذتين.
 */
describe('مراحل مشروع — frmProjectStagesPM · frmStagePM', () => {
  const stage = (id: string, name: string, stageOrder: number) => ({ id, name, stageOrder });

  it('يرتّب بالترتيب لا بالاسم، ويحسب الرقم التالي في الذيل', () => {
    const stages = [stage('c', 'التسليم', 3), stage('a', 'التصميم', 1), stage('b', 'التنفيذ', 2)];
    expect(sortStages(stages).map((row) => row.name)).toEqual(['التصميم', 'التنفيذ', 'التسليم']);
    expect(nextStageOrder(stages)).toBe(4);
    expect(nextStageOrder([])).toBe(1);
    // ترتيبٌ مكسور (فجوة) يُكمل من أقصى رقمٍ لا من العدد — والواجهة تعرض 1..n دائماً.
    expect(nextStageOrder([stage('a', 'التصميم', 7)])).toBe(8);
    expect(stageNumbers(sortStages(stages))).toEqual([
      { id: 'a', number: 1 },
      { id: 'b', number: 2 },
      { id: 'c', number: 3 },
    ]);
  });

  it('يبدّل مع الجار ويُعيد الترقيم بلا فجوة', () => {
    const stages = [stage('a', 'التصميم', 1), stage('b', 'التنفيذ', 2), stage('c', 'التسليم', 3)];
    expect(moveStage(stages, 'c', 'up').map((row) => `${row.stageOrder}:${row.name}`)).toEqual([
      '1:التصميم',
      '2:التسليم',
      '3:التنفيذ',
    ]);
    expect(moveStage(stages, 'a', 'down').map((row) => `${row.stageOrder}:${row.name}`)).toEqual([
      '1:التنفيذ',
      '2:التصميم',
      '3:التسليم',
    ]);
    // والطرفان: لا حركة ولا خطأ — الزرّ يُعطَّل قبل الطلب.
    expect(moveStage(stages, 'a', 'up').map((row) => row.name)).toEqual(['التصميم', 'التنفيذ', 'التسليم']);
    expect(moveStage(stages, 'c', 'down').map((row) => row.name)).toEqual(['التصميم', 'التنفيذ', 'التسليم']);
    expect(canMove(stages, 'a', 'up')).toBe(false);
    expect(canMove(stages, 'a', 'down')).toBe(true);
    expect(canMove(stages, 'c', 'up')).toBe(true);
    expect(canMove(stages, 'c', 'down')).toBe(false);
    expect(canMove(stages, 'nope', 'up')).toBe(false);
  });

  it('يسمّي حالة المرحلة كما في النافذة، والمجهولة «بالانتظار»', () => {
    expect(stageStatusLabel('accredited')).toBe('معتمدة');
    expect(stageStatusLabel('in_progress')).toBe('قيد التنفيذ');
    expect(stageStatusLabel('done')).toBe('منتهية');
    expect(stageStatusLabel(undefined)).toBe('بالانتظار');
    expect(stageStatusLabel('شيء آخر')).toBe('بالانتظار');
  });

  it('يحفظ نصوص الرفض بنصّها من `frmProjectStagesPM.xaml.cs`', () => {
    expect(Object.values(STAGE_REFUSALS)).toEqual([
      'يجب تحديد المجموعة',
      'يجب تحديد المرحلة المراد إضافتها',
      'يجب تحديد المرحلة المراد إلغاها',
      'المرحلة المحددة موجودة ضمن مراحل المجموعة',
      'هل تريد حفظ مراحل المجموعة؟',
      'الرجاء إدخال اسم المرحلة',
      'من فضلك أدخل رقم البند',
      'من فضلك أدخل اسم البند',
    ]);
  });
});

describe('بطاقة بند — frmTermsPM', () => {
  it('قيمة البند نصٌّ لا رقمٌ عائم', () => {
    expect(boqLineValue('120', '85.5000')).toBe('10260.0000');
    expect(boqLineValue('1', '0.1')).toBe('0.1000');
    expect(boqLineValue('', '')).toBe('0.0000');
    expect(boqSum([{ qty: '3', unitValue: '0.1' }, { qty: '3', unitValue: '0.2' }])).toBe('0.9000');
  });

  it('يرفض الناقص بالرسالة المكتبية نفسها', () => {
    expect(missingBoqField({ code: '  ', description: 'أعمال' })).toBe('من فضلك أدخل رقم البند');
    expect(missingBoqField({ code: '1', description: ' ' })).toBe('من فضلك أدخل اسم البند');
    expect(missingBoqField({ code: '1', description: 'أعمال' })).toBeUndefined();
  });
});

describe('الشاشات الثلاث صارت مساراتٍ حقيقية', () => {
  const ready = [
    { key: 'tailoring-type', labelAr: 'أنواع التفصيل', path: 'apps/staff/app/tailoring/types/page.tsx' },
    { key: 'boq-item', labelAr: 'بطاقة بند', path: 'apps/staff/app/projects/boq/page.tsx' },
    { key: 'project-stages', labelAr: 'مراحل مشروع', path: 'apps/staff/app/projects/stages/page.tsx' },
  ];

  it('لا شاشة `api` في الشجرة — الثلاث قُلبت `ready` وبقيت تسمياتها العربية', () => {
    const api = allScreens.filter((screen) => screen.status === 'api');
    expect(api.map((screen) => screen.key)).toEqual([]);
    for (const screen of ready) {
      const item = allScreens.find((row) => row.key === screen.key);
      expect(item?.status, screen.key).toBe('ready');
      expect(item?.labelAr, screen.key).toBe(screen.labelAr);
      // المسار خرج من `/s/` (سقالة «قيد الإنشاء») إلى مسارٍ مخصّص.
      expect(item?.href.startsWith('/s/'), screen.key).toBe(false);
      expect(findScreenByHref(item?.href ?? '')?.key).toBe(screen.key);
    }
  });

  it('ولكلٍّ منها ملف صفحةٍ على القرص', () => {
    for (const screen of ready) {
      expect(existsSync(join(repoRoot, screen.path)), screen.path).toBe(true);
    }
  });

  it('وتسميات المصدر المكتبي محفوظةٌ في ملف الشاشة (الرقم والاسم والحالة)', () => {
    const boq = readFileSync(join(repoRoot, 'apps/staff/app/projects/boq/page.tsx'), 'utf8');
    expect(boq).toContain('🔢 الرقم');
    expect(boq).toContain('📝 الاسم');
    expect(boq).toContain('💾 حفظ');
    expect(boq).toContain('frmTermsPM.xaml');

    const stages = readFileSync(join(repoRoot, 'apps/staff/app/projects/stages/page.tsx'), 'utf8');
    expect(stages).toContain('🗂️ المجموعة');
    expect(stages).toContain('➕ إضافة حالة');
    expect(stages).toContain('⬆️ لأعلى');
    expect(stages).toContain('⬇️ لأسفل');
    expect(stages).toContain('🖨️ طباعة');
    expect(stages).toContain('frmProjectStagesPM.xaml');

    const types = readFileSync(join(repoRoot, 'apps/staff/app/tailoring/types/page.tsx'), 'utf8');
    // النوع في الديسكتوب يُقرأ في بطاقة الطلب؛ والشاشة تُسمّي السعر «افتراضياً» لأنه اقتراح.
    expect(types).toContain('السعر الافتراضي');
    expect(types).toContain('frmOrderDetails.xaml.cs');
  });

  it('وروابط الموقع التسويقي تشير إلى المسارات الجديدة لا إلى السقالة', () => {
    const industries = readFileSync(join(repoRoot, 'apps/marketing/lib/industries.ts'), 'utf8');
    for (const href of ['/tailoring/types', '/projects/boq', '/projects/stages']) {
      expect(industries, href).toContain(`href: '${href}'`);
      expect(findScreenByHref(href)?.href, href).toBe(href);
    }
    expect(industries).not.toContain("href: '/s/");
  });
});
