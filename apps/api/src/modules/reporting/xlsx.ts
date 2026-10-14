/**
 * A dependency-free XLSX writer.
 *
 * Reports have to leave the system as a file an accountant can open in Excel, not as a CSV
 * that mangles Arabic and turns document numbers into scientific notation. A full spreadsheet
 * library would be a heavy dependency for the handful of features we need (one sheet, a header
 * band, numbers, a totals row, right-to-left reading order), so this module writes the OOXML
 * parts by hand and packs them with a tiny ZIP writer built on `node:zlib`.
 *
 * The output is a plain SpreadsheetML workbook: no shared string table (strings are inline,
 * which costs a few bytes and saves a whole indexing pass) and a fixed six-entry style table.
 */
import { deflateRawSync } from 'node:zlib';

export type SheetCellKind = 'text' | 'number' | 'integer';

export type SheetColumn = {
  header: string;
  /** Column width in characters; Excel's own unit. */
  width?: number;
  kind?: SheetCellKind;
};

export type SheetSpec = {
  /** Sheet tab name; Excel rejects `[]:*?/\` and anything past 31 characters. */
  name: string;
  /** Bold caption rendered above the table — the report title. */
  titleAr?: string;
  /** Grey caption lines under the title — the applied filters, the generated-at stamp. */
  captions?: string[];
  columns: SheetColumn[];
  rows: Array<Array<string | number | null>>;
  /** Rendered as a bold band under the last data row. */
  totalsRow?: Array<string | number | null>;
  rightToLeft?: boolean;
};

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value;
  }
  return table;
})();

function crc32(input: Buffer): number {
  let crc = -1;
  for (const byte of input) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

type ZipEntry = { name: string; data: Buffer };

/** Minimal ZIP container: deflate, no data descriptors, no zip64 (reports never reach 4 GB). */
export function zipSync(entries: ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const packed = deflateRawSync(entry.data, { level: 9 });
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // names and inline strings are UTF-8
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12); // fixed 1980-01-01 stamp keeps output byte-identical
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    parts.push(local, nameBytes, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    directory.push(central, nameBytes);

    offset += local.length + nameBytes.length + packed.length;
  }
  const directoryBytes = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directoryBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directoryBytes, end]);
}

export function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
    // eslint-disable-next-line no-control-regex -- control characters make Excel refuse the file
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

/** 1 -> A, 27 -> AA. Excel columns are base-26 with no zero digit. */
export function columnLetter(index: number): string {
  let remaining = index;
  let letters = '';
  while (remaining > 0) {
    const digit = (remaining - 1) % 26;
    letters = String.fromCharCode(65 + digit) + letters;
    remaining = Math.floor((remaining - digit) / 26);
  }
  return letters;
}

const STYLE_DEFAULT = 0;
const STYLE_TITLE = 1;
const STYLE_CAPTION = 2;
const STYLE_HEADER = 3;
const STYLE_MONEY = 4;
const STYLE_TOTAL = 5;
const STYLE_TOTAL_MONEY = 6;

function cellXml(reference: string, value: string | number | null, style: number): string {
  if (value === null || value === '') return `<c r="${reference}" s="${style}"/>`;
  if (typeof value === 'number') return `<c r="${reference}" s="${style}"><v>${value}</v></c>`;
  return `<c r="${reference}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

function rowXml(rowNumber: number, cells: string[]): string {
  return `<row r="${rowNumber}">${cells.join('')}</row>`;
}

/**
 * Values arrive from the report runner as strings. Anything that is a clean decimal becomes a
 * real number so Excel can sum it; everything else — a document number like `SI-000006`, an
 * account code with leading zeros — stays text on purpose.
 */
function coerce(value: string | number | null, kind: SheetCellKind): string | number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return value;
  if (kind === 'text') return value;
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return value;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : value;
}

function sheetXml(spec: SheetSpec): string {
  const columnCount = Math.max(1, spec.columns.length);
  const lines: string[] = [];
  let rowNumber = 0;

  if (spec.titleAr) {
    rowNumber += 1;
    lines.push(rowXml(rowNumber, [cellXml(`A${rowNumber}`, spec.titleAr, STYLE_TITLE)]));
  }
  for (const caption of spec.captions ?? []) {
    rowNumber += 1;
    lines.push(rowXml(rowNumber, [cellXml(`A${rowNumber}`, caption, STYLE_CAPTION)]));
  }
  if (rowNumber > 0) rowNumber += 1; // blank spacer row before the table

  rowNumber += 1;
  const headerRow = rowNumber;
  lines.push(rowXml(headerRow, spec.columns.map((column, index) => cellXml(`${columnLetter(index + 1)}${headerRow}`, column.header, STYLE_HEADER))));

  for (const row of spec.rows) {
    rowNumber += 1;
    const cells = spec.columns.map((column, index) => {
      const kind = column.kind ?? 'text';
      const value = coerce(row[index] ?? null, kind);
      const style = typeof value === 'number' && kind === 'number' ? STYLE_MONEY : STYLE_DEFAULT;
      return cellXml(`${columnLetter(index + 1)}${rowNumber}`, value, style);
    });
    lines.push(rowXml(rowNumber, cells));
  }

  if (spec.totalsRow) {
    rowNumber += 1;
    const cells = spec.columns.map((column, index) => {
      const kind = column.kind ?? 'text';
      const value = coerce(spec.totalsRow?.[index] ?? null, kind);
      const style = typeof value === 'number' ? STYLE_TOTAL_MONEY : STYLE_TOTAL;
      return cellXml(`${columnLetter(index + 1)}${rowNumber}`, value, style);
    });
    lines.push(rowXml(rowNumber, cells));
  }

  const cols = spec.columns
    .map((column, index) => `<col min="${index + 1}" max="${index + 1}" width="${column.width ?? 16}" customWidth="1"/>`)
    .join('');
  const pane = `<pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/>`;
  const view = `<sheetView${spec.rightToLeft === false ? '' : ' rightToLeft="1"'} workbookViewId="0">${pane}</sheetView>`;
  const dimension = `<dimension ref="A1:${columnLetter(columnCount)}${Math.max(rowNumber, 1)}"/>`;
  const autoFilter = spec.rows.length ? `<autoFilter ref="A${headerRow}:${columnLetter(columnCount)}${rowNumber}"/>` : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${dimension}<sheetViews>${view}</sheetViews><sheetFormatPr defaultRowHeight="15"/><cols>${cols}</cols><sheetData>${lines.join('')}</sheetData>${autoFilter}<pageMargins left="0.3" right="0.3" top="0.5" bottom="0.5" header="0.3" footer="0.3"/></worksheet>`;
}

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts>
<fonts count="4">
<font><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="14"/><name val="Calibri"/></font>
<font><sz val="9"/><color rgb="FF6B7280"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><name val="Calibri"/></font>
</fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE8EDF5"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top style="thin"><color rgb="FF9CA3AF"/></top><bottom style="thin"><color rgb="FF9CA3AF"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="7">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="3" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="3" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="164" fontId="3" fillId="2" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

/** Excel refuses `[]:*?/\` in a tab name and truncates past 31 characters. */
export function safeSheetName(name: string): string {
  const cleaned = name.replace(/[[\]:*?/\\]/g, ' ').trim();
  return (cleaned || 'Sheet1').slice(0, 31);
}

export function buildXlsx(spec: SheetSpec): Buffer {
  const tab = safeSheetName(spec.name);
  return zipSync([
    {
      name: '[Content_Types].xml',
      data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`, 'utf8'),
    },
    {
      name: '_rels/.rels',
      data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`, 'utf8'),
    },
    {
      name: 'xl/workbook.xml',
      data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr/><bookViews><workbookView/></bookViews><sheets><sheet name="${escapeXml(tab)}" sheetId="1" r:id="rId1"/></sheets></workbook>`, 'utf8'),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`, 'utf8'),
    },
    { name: 'xl/styles.xml', data: Buffer.from(STYLES_XML, 'utf8') },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheetXml(spec), 'utf8') },
  ]);
}
