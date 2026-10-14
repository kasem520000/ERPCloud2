import { inflateRawSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { buildXlsx, columnLetter, escapeXml, safeSheetName, zipSync } from './xlsx.js';

/**
 * Reads a ZIP the way Excel does: from the end-of-central-directory record backwards, not by
 * walking local headers. If this helper can find the parts, so can a spreadsheet application.
 */
function unzip(archive: Buffer): Map<string, Buffer> {
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(end).toBeGreaterThan(-1);
  const count = archive.readUInt16LE(end + 10);
  let cursor = archive.readUInt32LE(end + 16);
  const files = new Map<string, Buffer>();
  for (let index = 0; index < count; index += 1) {
    expect(archive.readUInt32LE(cursor)).toBe(0x02014b50);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    files.set(name, inflateRawSync(archive.subarray(dataStart, dataStart + compressedSize)));
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

describe('xlsx writer', () => {
  it('numbers columns the way Excel does', () => {
    expect(columnLetter(1)).toBe('A');
    expect(columnLetter(26)).toBe('Z');
    expect(columnLetter(27)).toBe('AA');
    expect(columnLetter(52)).toBe('AZ');
    expect(columnLetter(53)).toBe('BA');
  });

  it('keeps sheet names inside Excel limits', () => {
    expect(safeSheetName('كشف حساب/عميل')).toBe('كشف حساب عميل');
    expect(safeSheetName('x'.repeat(40))).toHaveLength(31);
    expect(safeSheetName('  ')).toBe('Sheet1');
  });

  it('escapes markup and drops control characters', () => {
    expect(escapeXml('a & b < c > "d" \u0007')).toBe('a &amp; b &lt; c &gt; &quot;d&quot; ');
  });

  it('round-trips a zip archive', () => {
    const archive = zipSync([{ name: 'a.txt', data: Buffer.from('مرحبا', 'utf8') }]);
    expect(archive.subarray(0, 2).toString()).toBe('PK');
    expect(unzip(archive).get('a.txt')?.toString('utf8')).toBe('مرحبا');
  });

  it('writes a workbook Excel can open, with the parts it insists on', () => {
    const files = unzip(
      buildXlsx({
        name: 'ميزان المراجعة',
        titleAr: 'ميزان المراجعة',
        captions: ['الفترة: من 2026-01-01 إلى 2026-01-31'],
        columns: [
          { header: 'الحساب', kind: 'text' },
          { header: 'مدين', kind: 'number' },
        ],
        rows: [['1101 الصندوق', '1250.75']],
        totalsRow: ['الإجمالي', '1250.75'],
      }),
    );
    for (const part of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml']) {
      expect(files.has(part), part).toBe(true);
    }
    const sheet = files.get('xl/worksheets/sheet1.xml')!.toString('utf8');
    expect(sheet).toContain('rightToLeft="1"');
    expect(sheet).toContain('الحساب');
    // The money column must be a real number, not an inline string, or Excel cannot sum it.
    expect(sheet).toContain('<v>1250.75</v>');
    expect(sheet).toContain('1101 الصندوق');
    expect(files.get('xl/workbook.xml')!.toString('utf8')).toContain('name="ميزان المراجعة"');
  });

  it('keeps document numbers and codes as text', () => {
    const sheet = unzip(
      buildXlsx({ name: 'الفواتير', columns: [{ header: 'الرقم', kind: 'text' }], rows: [['0012'], ['SI-000006']] }),
    )
      .get('xl/worksheets/sheet1.xml')!
      .toString('utf8');
    expect(sheet).toContain('>0012<');
    expect(sheet).toContain('SI-000006');
    expect(sheet).not.toContain('<v>12</v>');
  });
});
