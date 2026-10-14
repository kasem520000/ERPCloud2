import { describe, expect, it } from 'vitest';

import { emptyLine, toApiLines } from '../components/invoice-editor';

/**
 * 📊 مركز التكلفة على سطور الفاتورة (R9).
 *
 * الديسكتوب يكتب مركز السطر في `Inv_Sub.ItemCostCenter` (يُبنى في
 * `Class/InvoiceOper.cs` L1635) وقائمتُه في نافذة البيع «📊 مركز التكلفة:» L530 ونافذة
 * الشراء L467. وهذا السبيك يثبّت عقد الشبكة كما ترسله الشاشة:
 *
 *   · سطرٌ بمركزٍ يُرسل معرّفه صريحاً؛
 *   · سطرٌ بلا مركز **لا يُرسل الحقل أبداً** — فالغياب هو معنى «خذ مركز رأس الفاتورة»
 *     (L2461)، ولو أُرسلت سلسلة فارغة لصار الواسم يظنّ أنّ للسطر مركزاً فارغاً؛
 *   · السطر الجديد يبدأ بلا مركز، فلا شيء يورَّث صامتاً على السطور.
 */
describe('cost centre on invoice lines (📊 مركز التكلفة)', () => {
  it('starts a new line with no centre — the header sets the default', () => {
    expect(emptyLine().costCenterId).toBe('');
  });

  it('sends the centre of a line that names one, and omits it when the line is silent', () => {
    const lines = toApiLines([
      { ...emptyLine(), description: 'بند أ', costCenterId: 'center-a' },
      { ...emptyLine(), description: 'بند ب' },
    ]);
    expect(lines[0]?.costCenterId).toBe('center-a');
    expect(lines[1] !== undefined && 'costCenterId' in lines[1]).toBe(true);
    expect(lines[1]?.costCenterId).toBeUndefined();
  });

  it('keeps the field off the wire for every line of an invoice with no centres at all', () => {
    const lines = toApiLines([
      { ...emptyLine(), description: 'بند ١' },
      { ...emptyLine(), description: 'بند ٢' },
    ]);
    for (const line of lines) expect(line.costCenterId).toBeUndefined();
  });
});
