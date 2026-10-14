import { describe, expect, it } from 'vitest';

import { serialList } from '../components/invoice-editor';
import { SERIAL_MESSAGES, decideSerial, type SerialLookup } from '../lib/serial-numbers';

/**
 * «🔢 التسلسلي:» — خانة رأس نافذة البيع (`frmInvSale.xaml` L592 ←
 * `SearchBySerialNo` L722). هذا السبيك يثبّت الأحكام الأربعة والرسائل الثلاث
 * **بحروفها** كما في `frmInvSale.xaml.cs` (L733 · L769 · L780)، فيكون النقل مقيساً
 * لا موعوداً.
 */
describe('serial search (🔢 التسلسلي)', () => {
  const available = (serialNo: string): SerialLookup => ({
    found: true,
    serialNo,
    status: 'available',
    item: { id: 'item-1', sku: 'SN-1', nameAr: 'شاشة' },
  });

  it('reads the box: one number per line, comma or semicolon, deduplicated', () => {
    expect(serialList('SN-1\nSN-2')).toEqual(['SN-1', 'SN-2']);
    expect(serialList('SN-1, SN-2، SN-3;SN-4')).toEqual(['SN-1', 'SN-2', 'SN-3', 'SN-4']);
    expect(serialList('SN-1 SN-1')).toEqual(['SN-1 SN-1']); // فراغٌ لا يفصل: الرقم قد يحوي فراغاً
    expect(serialList('  ')).toEqual([]);
  });

  it('adds a line for a number that is on the shelf', () => {
    const verdict = decideSerial({
      lookup: available('SN-1'),
      lines: [{ itemId: '', serialText: '' }],
      parse: serialList,
    });
    expect(verdict.decision).toEqual({ kind: 'append', itemId: 'item-1', serialNo: 'SN-1' });
  });

  it('refuses a number already typed on a line — «تم إدراج هذا الرقم التسلسلي من قبل»', () => {
    const verdict = decideSerial({
      lookup: available('SN-1'),
      lines: [{ itemId: 'item-1', serialText: 'SN-1\nSN-2' }],
      parse: serialList,
    });
    expect(verdict.decision).toEqual({ kind: 'reject', text: SERIAL_MESSAGES.alreadyListed });
    // والحرفية: النصّ كما في `frmInvSale.xaml.cs:733`.
    expect(SERIAL_MESSAGES.alreadyListed).toBe('تم إدراج هذا الرقم التسلسلي من قبل');
  });

  it('refuses a number that has left the shelf — «تم بيع أو إخراج هذا الرقم التسلسلي»', () => {
    const verdict = decideSerial({
      lookup: { ...available('SN-9'), status: 'sold' },
      lines: [],
      parse: serialList,
    });
    expect(verdict.decision).toEqual({ kind: 'reject', text: SERIAL_MESSAGES.sold });
    expect(SERIAL_MESSAGES.sold).toBe('تم بيع أو إخراج هذا الرقم التسلسلي');
  });

  it('refuses a number nobody registered — «لا يوجد صنف بهذا الرقم التسلسلي»', () => {
    const missing = decideSerial({
      lookup: { found: false, serialNo: 'SN-X' },
      lines: [],
      parse: serialList,
    });
    expect(missing.decision).toEqual({ kind: 'reject', text: SERIAL_MESSAGES.notFound });
    expect(SERIAL_MESSAGES.notFound).toBe('لا يوجد صنف بهذا الرقم التسلسلي');

    // `found` بلا صنف ليس إجابةً صالحة: لا سطرَ بلا صنف.
    const empty = decideSerial({
      lookup: { found: true, serialNo: 'SN-X', status: 'available', item: null },
      lines: [],
      parse: serialList,
    });
    expect(empty.decision).toEqual({ kind: 'reject', text: SERIAL_MESSAGES.notFound });
  });

  it('an empty box says so instead of searching for nothing', () => {
    const verdict = decideSerial({ lookup: { found: false, serialNo: '   ' }, lines: [], parse: serialList });
    expect(verdict.decision).toEqual({ kind: 'reject', text: SERIAL_MESSAGES.empty });
  });
});
