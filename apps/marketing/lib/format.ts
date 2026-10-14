import { Decimal } from 'decimal.js';
export function moneyText(valueText: string, currency = 'SAR', locale = 'ar-SA'): string { return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(Number(new Decimal(valueText || '0').toFixed(2))); }
export function dateText(value: string, locale = 'ar-SA'): string { return new Intl.DateTimeFormat(locale).format(new Date(value)); }
export function maskParty(value: string): string { return value.length <= 4 ? '****' : `${value.slice(0, 2)}***${value.slice(-2)}`; }
