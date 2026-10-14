import { Decimal } from 'decimal.js';

export function moneyText(valueText: string, currency = 'SAR', locale = 'ar-SA'): string {
  const fixed = new Decimal(valueText || '0').toFixed(2);
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(Number(fixed));
}

export function qtyText(valueText: string): string { return new Decimal(valueText || '0').toFixed(4); }
export function persistColumns(key: string, columns: string[]): void { if (typeof localStorage !== 'undefined') localStorage.setItem(`erp:columns:${key}`, JSON.stringify(columns)); }
export function readColumns(key: string, fallback: string[]): string[] { if (typeof localStorage === 'undefined') return fallback; try { return JSON.parse(localStorage.getItem(`erp:columns:${key}`) ?? 'null') as string[] ?? fallback; } catch { return fallback; } }
