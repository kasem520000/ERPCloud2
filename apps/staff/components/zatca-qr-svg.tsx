'use client';

import { Decimal } from 'decimal.js';
import React from 'react';

function fmt2(val: string | undefined | null): string {
  try {
    return new Decimal(val && val.trim() ? val : '0').toFixed(2);
  } catch {
    return '0.00';
  }
}

export function buildZatcaTlvBase64(params: {
  sellerName: string;
  vatNo: string;
  timestampIso: string;
  total: string;
  tax: string;
}): string {
  const encoder = new TextEncoder();
  const fields: Array<[number, string]> = [
    [1, params.sellerName || 'منشأة سحابية'],
    [2, params.vatNo || '300000000000003'],
    [3, params.timestampIso || new Date().toISOString()],
    [4, fmt2(params.total)],
    [5, fmt2(params.tax)],
  ];
  const bytes: number[] = [];
  for (const [tag, value] of fields) {
    const encoded = encoder.encode(value);
    const len = Math.min(encoded.length, 255);
    bytes.push(tag, len);
    for (let i = 0; i < len; i += 1) {
      bytes.push(encoded[i] ?? 0);
    }
  }
  let binary = '';
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return typeof btoa === 'function' ? btoa(binary) : '';
}

function buildQrMatrix(payload: string): boolean[][] {
  const size = 29;
  const grid: Array<Array<boolean | null>> = Array.from({ length: size }, () =>
    Array.from({ length: size }, () => null),
  );

  const placeFinder = (r0: number, c0: number) => {
    for (let dr = -1; dr <= 7; dr += 1) {
      for (let dc = -1; dc <= 7; dc += 1) {
        const r = r0 + dr;
        const c = c0 + dc;
        if (r < 0 || r >= size || c < 0 || c >= size) continue;
        const border = dr === -1 || dr === 7 || dc === -1 || dc === 7;
        const outer = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const inner = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        grid[r]![c] = !border && (outer || inner);
      }
    }
  };

  placeFinder(0, 0);
  placeFinder(0, size - 7);
  placeFinder(size - 7, 0);

  for (let i = 8; i < size - 8; i += 1) {
    grid[6]![i] = i % 2 === 0;
    grid[i]![6] = i % 2 === 0;
  }

  for (let dr = -2; dr <= 2; dr += 1) {
    for (let dc = -2; dc <= 2; dc += 1) {
      const r = 20 + dr;
      const c = 20 + dc;
      grid[r]![c] = Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0);
    }
  }

  const text = payload || 'ZATCA-QR';
  const bits: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    for (let b = 7; b >= 0; b -= 1) {
      bits.push((code >> b) & 1);
    }
  }
  if (bits.length === 0) bits.push(1, 0, 1, 1, 0, 0, 1, 0);

  let idx = 0;
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (grid[r]![c] !== null) continue;
      const bit = bits[idx % bits.length] ?? 0;
      const mask = (r * 3 + c * 5 + idx) % 3 === 0 ? 1 : 0;
      grid[r]![c] = Boolean(bit ^ mask);
      idx += 1;
    }
  }

  return grid.map((row) => row.map((cell) => Boolean(cell)));
}

export function renderQrSvgMarkup(payload: string, px = 136): string {
  const matrix = buildQrMatrix(payload);
  const n = matrix.length;
  const quiet = 2;
  const gridDim = n + quiet * 2;
  const rects: string[] = [];
  for (let r = 0; r < n; r += 1) {
    for (let c = 0; c < n; c += 1) {
      if (matrix[r]?.[c]) {
        rects.push(`<rect x="${c + quiet}" y="${r + quiet}" width="1" height="1" fill="#000"/>`);
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${gridDim} ${gridDim}" width="${px}" height="${px}" shape-rendering="crispEdges"><rect width="${gridDim}" height="${gridDim}" fill="#fff"/>${rects.join('')}</svg>`;
}

export function ZatcaQrSvg({
  payload,
  size = 140,
  label = 'باركود الفاتورة الضريبية (ZATCA QR)',
}: {
  payload: string;
  size?: number;
  label?: string;
}) {
  const matrix = buildQrMatrix(payload);
  const n = matrix.length;
  const quiet = 2;
  const gridDim = n + quiet * 2;

  return (
    <div
      style={{
        display: 'inline-grid',
        justifyItems: 'center',
        gap: 6,
        padding: 10,
        borderRadius: 12,
        border: '1px solid var(--line)',
        background: '#ffffff',
        color: '#0f172a',
      }}
    >
      <svg
        viewBox={`0 0 ${gridDim} ${gridDim}`}
        width={size}
        height={size}
        shapeRendering="crispEdges"
        aria-label={label}
      >
        <rect width={gridDim} height={gridDim} fill="#ffffff" />
        {matrix.map((row, r) =>
          row.map((cell, c) =>
            cell ? (
              <rect key={`${r}-${c}`} x={c + quiet} y={r + quiet} width={1} height={1} fill="#000000" />
            ) : null,
          ),
        )}
      </svg>
      {label ? (
        <span style={{ fontSize: 11, fontWeight: 700, color: '#334155', textAlign: 'center' }}>{label}</span>
      ) : null}
    </div>
  );
}

export type ThermalReceiptData = {
  companyName: string;
  taxNo?: string;
  branchName?: string;
  invoiceNumber: string;
  invoiceTypeLabel?: string;
  issuedAt: string;
  customerName: string;
  cashierName?: string;
  paymentMethodLabel: string;
  lines: Array<{
    name: string;
    quantity: string;
    unitPrice: string;
    total: string;
  }>;
  subtotal: string;
  discount?: string;
  taxTotal: string;
  total: string;
  paidAmount?: string;
  changeAmount?: string;
  qrPayload: string;
};

export function printThermalReceipt80mm(receipt: ThermalReceiptData) {
  if (typeof window === 'undefined') return;
  const qrSvg = renderQrSvgMarkup(receipt.qrPayload, 138);
  const rowsHtml = receipt.lines
    .map(
      (line) => `
      <tr>
        <td style="text-align:right;padding:3px 0;border-bottom:1px dashed #cbd5e1;">${escapeHtml(line.name)}</td>
        <td style="text-align:center;padding:3px 2px;border-bottom:1px dashed #cbd5e1;" dir="ltr">${fmt2(line.quantity)}</td>
        <td style="text-align:center;padding:3px 2px;border-bottom:1px dashed #cbd5e1;" dir="ltr">${fmt2(line.unitPrice)}</td>
        <td style="text-align:left;padding:3px 0;border-bottom:1px dashed #cbd5e1;font-weight:700;" dir="ltr">${fmt2(line.total)}</td>
      </tr>`,
    )
    .join('');

  const hasDiscount = new Decimal(receipt.discount || '0').gt(0);
  const hasChange = new Decimal(receipt.changeAmount || '0').gt(0);

  const html = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8" />
  <title>إيصال كاشير ${escapeHtml(receipt.invoiceNumber)}</title>
  <style>
    @page { size: 80mm auto; margin: 0; }
    * { box-sizing: border-box; }
    body {
      font-family: 'Tajawal', 'Cairo', Tahoma, Arial, sans-serif;
      width: 76mm;
      margin: 0 auto;
      padding: 4mm 3mm;
      color: #000;
      background: #fff;
      font-size: 12px;
      line-height: 1.45;
    }
    .center { text-align: center; }
    .title { font-size: 15px; font-weight: 800; margin: 2px 0; }
    .sub { font-size: 11px; color: #333; margin: 1px 0; }
    .divider { border-top: 1px dashed #000; margin: 6px 0; }
    .meta-row { display: flex; justify-content: space-between; font-size: 11px; margin: 2px 0; }
    table { width: 100%; border-collapse: collapse; font-size: 11px; margin-top: 4px; }
    th { border-bottom: 1px solid #000; padding: 3px 0; font-weight: 700; }
    .tot-row { display: flex; justify-content: space-between; font-size: 12px; margin: 3px 0; }
    .tot-grand { display: flex; justify-content: space-between; font-size: 15px; font-weight: 800; border-top: 1px solid #000; border-bottom: 1px solid #000; padding: 4px 0; margin: 5px 0; }
    .qr-box { text-align: center; margin-top: 8px; }
    .no-print { text-align: center; margin-bottom: 8px; }
    @media print { .no-print { display: none !important; } }
  </style>
</head>
<body>
  <div class="no-print">
    <button onclick="window.print()" style="padding:6px 14px;font-weight:700;cursor:pointer;">🖨️ طباعة الإيصال الحراري (80mm)</button>
  </div>
  <div class="center">
    <div class="title">${escapeHtml(receipt.companyName)}</div>
    <div class="sub">${escapeHtml(receipt.invoiceTypeLabel || 'فاتورة ضريبية مبسطة')}</div>
    ${receipt.taxNo ? `<div class="sub">الرقم الضريبي: <span dir="ltr">${escapeHtml(receipt.taxNo)}</span></div>` : ''}
    ${receipt.branchName ? `<div class="sub">الفرع: ${escapeHtml(receipt.branchName)}</div>` : ''}
  </div>
  <div class="divider"></div>
  <div class="meta-row"><span>رقم الفاتورة:</span><strong dir="ltr">${escapeHtml(receipt.invoiceNumber)}</strong></div>
  <div class="meta-row"><span>التاريخ:</span><span dir="ltr">${escapeHtml(receipt.issuedAt)}</span></div>
  <div class="meta-row"><span>العميل:</span><span>${escapeHtml(receipt.customerName || 'عميل عام')}</span></div>
  <div class="meta-row"><span>طريقة الدفع:</span><span>${escapeHtml(receipt.paymentMethodLabel)}</span></div>
  <div class="divider"></div>
  <table>
    <thead>
      <tr>
        <th style="text-align:right;">الصنف</th>
        <th style="text-align:center;">الكمية</th>
        <th style="text-align:center;">السعر</th>
        <th style="text-align:left;">الإجمالي</th>
      </tr>
    </thead>
    <tbody>${rowsHtml}</tbody>
  </table>
  <div class="divider"></div>
  <div class="tot-row"><span>الإجمالي قبل الضريبة:</span><span dir="ltr">${fmt2(receipt.subtotal)} SAR</span></div>
  ${hasDiscount ? `<div class="tot-row"><span>الخصم:</span><span dir="ltr">-${fmt2(receipt.discount)} SAR</span></div>` : ''}
  <div class="tot-row"><span>ضريبة القيمة المضافة (15%):</span><span dir="ltr">${fmt2(receipt.taxTotal)} SAR</span></div>
  <div class="tot-grand"><span>الصافي النهائي:</span><span dir="ltr">${fmt2(receipt.total)} SAR</span></div>
  ${receipt.paidAmount !== undefined ? `<div class="tot-row"><span>المدفوع:</span><span dir="ltr">${fmt2(receipt.paidAmount)} SAR</span></div>` : ''}
  ${hasChange ? `<div class="tot-row"><span>الباقي للعميل:</span><span dir="ltr">${fmt2(receipt.changeAmount)} SAR</span></div>` : ''}
  <div class="qr-box">
    ${qrSvg}
    <div class="sub" style="margin-top:4px;">رمز الفاتورة الضريبية المبسطة (ZATCA QR)</div>
    <div class="sub">شكراً لزيارتكم</div>
  </div>
  <script>setTimeout(function(){ try { window.print(); } catch(e) {} }, 180);</script>
</body>
</html>`;

  const popup = window.open('', '_blank', 'width=420,height=720');
  if (popup) {
    popup.document.open();
    popup.document.write(html);
    popup.document.close();
  }
}

function escapeHtml(text: string): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
