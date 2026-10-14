import { Decimal } from 'decimal.js';

/**
 * Wage Protection (Mudad) and GOSI file contracts.
 *
 * The CSV is the bank/Mudad upload shape used before a direct Mudad API exists:
 * one header and one detail row per employee, with the wage split HRSD compares
 * (identity, IBAN, basic, housing, other earnings, deductions, net). Amounts are
 * 2-decimal SAR. A UTF-8 BOM is prefixed so Excel keeps Arabic names.
 *
 * GOSI rates follow the July 2026 schedule: old-scheme Saudis stay at 9.75/11.75,
 * new-scheme Saudis (registered on/after 2024-07-03) are 10.75/12.75 from July 2026,
 * and non-Saudis carry the 2% occupational-hazard share only.
 */

export const WPS_HEADERS = [
  'RecordType',
  'EmployeeId',
  'EmployeeName',
  'BankCode',
  'IBAN',
  'BasicSalary',
  'HousingAllowance',
  'OtherEarnings',
  'Deductions',
  'NetSalary',
] as const;

export const GOSI_HEADERS = [
  'NationalId',
  'EmployeeName',
  'Nationality',
  'InsuranceNo',
  'BasicSalary',
  'HousingAllowance',
  'ContributoryWage',
  'EmployeeShare',
  'EmployerShare',
  'OccupationalHazard',
  'TotalContribution',
  'Scheme',
] as const;

export const GOSI_WAGE_CAP = new Decimal('45000');
export const GOSI_WAGE_FLOOR = new Decimal('1500');
export const NEW_GOSI_REGISTRATION = '2024-07-03';

const BASIC_KEYS = new Set(['basic', 'basic_salary', 'basicsalary', 'راتب', 'الراتب', 'الراتب_الأساسي']);
const HOUSING_KEYS = new Set(['housing', 'housing_allowance', 'housingallowance', 'سكن', 'بدل_سكن', 'بدل السكن']);
const SAUDI = new Set([
  'sa',
  'sau',
  'ksa',
  'saudi',
  'saudi arabia',
  'السعودية',
  'سعودي',
  'سعودية',
  'المملكة العربية السعودية',
]);

export type WpsEmployee = {
  employeeId: string;
  employeeNo?: string | null;
  name: string;
  nationalId?: string | null;
  nationality?: string | null;
  insuranceNo?: string | null;
  hireDate?: string | null;
  gosiScheme?: string | null;
  status?: string | null;
  iqamaExpiresOn?: string | null;
  insuranceExpiresOn?: string | null;
  components?: Record<string, string> | null;
  bank?: Record<string, string | undefined> | null;
  additions?: string | null;
  deductions?: string | null;
  gross?: string | null;
  net?: string | null;
};

export type WpsRow = {
  employeeId: string;
  employeeNo: string;
  name: string;
  nationalId: string;
  bankCode: string;
  iban: string;
  basic: string;
  housing: string;
  other: string;
  deductions: string;
  net: string;
  errors: string[];
  warnings: string[];
};

export type GosiRow = {
  employeeId: string;
  name: string;
  nationalId: string;
  nationality: string;
  insuranceNo: string;
  basic: string;
  housing: string;
  contributoryWage: string;
  employeeShare: string;
  employerShare: string;
  occupationalHazard: string;
  totalContribution: string;
  scheme: 'old' | 'new' | 'expat';
  errors: string[];
};

export type ExpiryAlert = {
  employeeId: string;
  employeeNo: string;
  employeeName: string;
  kind: 'iqama' | 'insurance';
  expiresOn: string;
  daysRemaining: number;
  severity: 'overdue' | 'due';
};

const money2 = (value: Decimal | string | number) =>
  new Decimal(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);

export function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export function toCsv(headers: readonly string[], rows: string[][], bom = true): string {
  const lines = [headers.join(','), ...rows.map((row) => row.map(csvCell).join(','))];
  return `${bom ? '\uFEFF' : ''}${lines.join('\r\n')}\r\n`;
}

export function normalizeIban(value: string | null | undefined): string {
  return (value ?? '').replace(/[\s-]/g, '').toUpperCase();
}

export function isValidSaudiIban(value: string | null | undefined): boolean {
  const iban = normalizeIban(value);
  if (!/^SA\d{22}$/.test(iban)) return false;
  const rearranged = `${iban.slice(4)}${iban.slice(0, 4)}`;
  const numeric = rearranged.replace(/[A-Z]/g, (letter) => String(letter.charCodeAt(0) - 55));
  let remainder = 0;
  for (const digit of numeric) remainder = (remainder * 10 + Number(digit)) % 97;
  return remainder === 1;
}

/** Builds a valid SA IBAN from a 2-digit SAMA bank code and an 18-digit account. */
export function buildSaudiIban(bankCode: string, account18: string): string {
  const bban = `${bankCode}${account18}`;
  if (!/^\d{2}$/.test(bankCode) || !/^\d{18}$/.test(account18)) {
    throw new Error('Saudi IBAN builder expects a 2-digit bank code and an 18-digit account');
  }
  const rearranged = `${bban}SA00`;
  const numeric = rearranged.replace(/[A-Z]/g, (letter) => String(letter.charCodeAt(0) - 55));
  let remainder = 0;
  for (const digit of numeric) remainder = (remainder * 10 + Number(digit)) % 97;
  const check = String(98 - remainder).padStart(2, '0');
  return `SA${check}${bban}`;
}

export function bankCodeFromIban(iban: string): string {
  const normalized = normalizeIban(iban);
  return /^SA\d{22}$/.test(normalized) ? normalized.slice(4, 6) : '';
}

export function isSaudiNationality(value: string | null | undefined): boolean {
  return SAUDI.has((value ?? '').trim().toLowerCase());
}

export function resolveGosiScheme(input: {
  nationality?: string | null;
  gosiScheme?: string | null;
  hireDate?: string | null;
}): 'old' | 'new' | 'expat' {
  if (!isSaudiNationality(input.nationality)) return 'expat';
  if (input.gosiScheme === 'old' || input.gosiScheme === 'new') return input.gosiScheme;
  if (input.hireDate && input.hireDate < NEW_GOSI_REGISTRATION) return 'old';
  return 'new';
}

/** Annuity rate for new-scheme Saudis. +0.5 point each July from 2025 until 11%. */
export function newSchemeAnnuityRate(asOf: string): Decimal {
  if (asOf < '2025-07-01') return new Decimal('0.09');
  if (asOf < '2026-07-01') return new Decimal('0.095');
  if (asOf < '2027-07-01') return new Decimal('0.10');
  if (asOf < '2028-07-01') return new Decimal('0.105');
  return new Decimal('0.11');
}

export function gosiShares(input: {
  scheme: 'old' | 'new' | 'expat';
  contributoryWage: Decimal;
  asOf: string;
}): { employeeShare: Decimal; employerShare: Decimal; occupationalHazard: Decimal } {
  const wage = input.contributoryWage;
  const occupational = wage.mul('0.02');
  if (input.scheme === 'expat') {
    return { employeeShare: new Decimal(0), employerShare: occupational, occupationalHazard: occupational };
  }
  const annuity = input.scheme === 'old' ? new Decimal('0.09') : newSchemeAnnuityRate(input.asOf);
  const saned = new Decimal('0.0075');
  const employeeShare = wage.mul(annuity.plus(saned));
  const employerShare = wage.mul(annuity.plus(saned)).plus(occupational);
  return { employeeShare, employerShare, occupationalHazard: occupational };
}

function componentAmount(components: Record<string, string>, keys: Set<string>): Decimal {
  return Object.entries(components).reduce((sum, [key, value]) => {
    return keys.has(key.trim().toLowerCase()) ? sum.plus(value || '0') : sum;
  }, new Decimal(0));
}

export function splitWage(employee: WpsEmployee): { basic: Decimal; housing: Decimal; other: Decimal; deductions: Decimal; net: Decimal; warning?: string } {
  const components = employee.components ?? {};
  const base = Object.values(components).reduce((sum, value) => sum.plus(value || '0'), new Decimal(0));
  const gross = new Decimal(employee.gross ?? base.toFixed(4));
  const additions = new Decimal(employee.additions ?? '0');
  const deductions = new Decimal(employee.deductions ?? '0');
  const net = new Decimal(employee.net ?? Decimal.max(0, gross.plus(additions).minus(deductions)).toFixed(4));
  const ratio = base.gt(0) ? gross.div(base) : new Decimal(1);
  let basic = componentAmount(components, BASIC_KEYS).mul(ratio);
  let housing = componentAmount(components, HOUSING_KEYS).mul(ratio);
  let warning: string | undefined;
  if (basic.isZero() && housing.isZero() && gross.gt(0)) {
    basic = gross;
    warning = 'لم يُفصل الراتب الأساسي وبدل السكن — وُضع الإجمالي في الأساسي';
  }
  let other = gross.minus(basic).minus(housing).plus(additions);
  const balancedNet = basic.plus(housing).plus(other).minus(deductions);
  if (!balancedNet.toDecimalPlaces(2).eq(net.toDecimalPlaces(2))) {
    other = net.plus(deductions).minus(basic).minus(housing);
    warning = warning ?? 'عُدّل بند البدلات الأخرى ليطابق صافي المسيّر';
  }
  return { basic, housing, other, deductions, net, warning };
}

export function buildWpsRows(employees: WpsEmployee[]): WpsRow[] {
  return employees.map((employee) => {
    const wage = splitWage(employee);
    const iban = normalizeIban(employee.bank?.iban);
    const bankCode = (employee.bank?.bankCode || employee.bank?.bankNo || bankCodeFromIban(iban) || '').toUpperCase();
    const nationalId = (employee.nationalId ?? '').replace(/\s/g, '');
    const errors: string[] = [];
    const warnings = wage.warning ? [wage.warning] : [];
    if (!/^\d{10}$/.test(nationalId)) errors.push('رقم الهوية/الإقامة يجب أن يكون 10 أرقام');
    else if (!/^[12]/.test(nationalId)) warnings.push('رقم الهوية لا يبدأ بـ 1 أو 2');
    if (!isValidSaudiIban(iban)) errors.push('الآيبان السعودي غير صالح');
    if (!/^[A-Z0-9]{2,11}$/.test(bankCode)) errors.push('رمز البنك مفقود أو غير صالح');
    if (wage.net.lte(0)) errors.push('صافي الراتب يجب أن يكون أكبر من صفر');
    return {
      employeeId: employee.employeeId,
      employeeNo: employee.employeeNo ?? '',
      name: employee.name.trim(),
      nationalId,
      bankCode,
      iban,
      basic: money2(wage.basic),
      housing: money2(wage.housing),
      other: money2(wage.other),
      deductions: money2(wage.deductions),
      net: money2(wage.net),
      errors,
      warnings,
    };
  });
}

export function renderWpsCsv(rows: WpsRow[]): string {
  return toCsv(
    WPS_HEADERS,
    rows.map((row) => ['D', row.nationalId, row.name, row.bankCode, row.iban, row.basic, row.housing, row.other, row.deductions, row.net]),
  );
}

export function buildGosiRows(employees: WpsEmployee[], asOf: string): GosiRow[] {
  return employees.map((employee) => {
    const wage = splitWage(employee);
    const scheme = resolveGosiScheme(employee);
    const raw = wage.basic.plus(wage.housing);
    const capped = Decimal.min(GOSI_WAGE_CAP, raw);
    const contributory = scheme === 'expat' ? capped : Decimal.max(GOSI_WAGE_FLOOR, capped);
    const shares = gosiShares({ scheme, contributoryWage: contributory, asOf });
    const nationalId = (employee.nationalId ?? '').replace(/\s/g, '');
    const errors: string[] = [];
    if (!/^\d{10}$/.test(nationalId)) errors.push('رقم الهوية/الإقامة يجب أن يكون 10 أرقام');
    if (scheme !== 'expat' && !(employee.insuranceNo ?? '').trim()) errors.push('رقم التأمينات مفقود');
    return {
      employeeId: employee.employeeId,
      name: employee.name.trim(),
      nationalId,
      nationality: employee.nationality?.trim() || (scheme === 'expat' ? 'غير سعودي' : 'سعودي'),
      insuranceNo: (employee.insuranceNo ?? '').trim(),
      basic: money2(wage.basic),
      housing: money2(wage.housing),
      contributoryWage: money2(contributory),
      employeeShare: money2(shares.employeeShare),
      employerShare: money2(shares.employerShare),
      occupationalHazard: money2(shares.occupationalHazard),
      totalContribution: money2(shares.employeeShare.plus(shares.employerShare)),
      scheme,
      errors,
    };
  });
}

export function renderGosiCsv(rows: GosiRow[]): string {
  return toCsv(
    GOSI_HEADERS,
    rows.map((row) => [
      row.nationalId,
      row.name,
      row.nationality,
      row.insuranceNo,
      row.basic,
      row.housing,
      row.contributoryWage,
      row.employeeShare,
      row.employerShare,
      row.occupationalHazard,
      row.totalContribution,
      row.scheme,
    ]),
  );
}

export function addDays(isoDate: string, days: number): string {
  const at = new Date(`${isoDate}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  return Math.round((end - start) / 86_400_000);
}

export function todayInTimezone(timeZone = 'Asia/Riyadh', now = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone }).format(now);
  } catch {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(now);
  }
}

export function todayInRiyadh(now = new Date()): string {
  return todayInTimezone('Asia/Riyadh', now);
}

/** Active employees whose iqama or insurance expires within `withinDays`, plus already overdue dates. */
export function complianceAlerts(employees: WpsEmployee[], today: string, withinDays = 30): ExpiryAlert[] {
  const horizon = addDays(today, withinDays);
  const alerts: ExpiryAlert[] = [];
  for (const employee of employees) {
    if (employee.status && employee.status !== 'active') continue;
    const dates: Array<['iqama' | 'insurance', string | null | undefined]> = [
      ['iqama', employee.iqamaExpiresOn],
      ['insurance', employee.insuranceExpiresOn],
    ];
    for (const [kind, expiresOn] of dates) {
      if (!expiresOn || expiresOn > horizon) continue;
      const daysRemaining = daysBetween(today, expiresOn);
      alerts.push({
        employeeId: employee.employeeId,
        employeeNo: employee.employeeNo ?? '',
        employeeName: employee.name,
        kind,
        expiresOn,
        daysRemaining,
        severity: daysRemaining < 0 ? 'overdue' : 'due',
      });
    }
  }
  return alerts.sort((left, right) => left.expiresOn.localeCompare(right.expiresOn) || left.employeeName.localeCompare(right.employeeName));
}
