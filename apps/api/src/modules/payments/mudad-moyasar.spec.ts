import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';

import {
  GOSI_HEADERS,
  WPS_HEADERS,
  buildGosiRows,
  buildSaudiIban,
  buildWpsRows,
  complianceAlerts,
  renderWpsCsv,
  type WpsEmployee,
} from '../hrm/payroll-compliance.js';

import {
  basicAuth,
  buildProviderCall,
  fromMinorUnits,
  interpretWebhook,
  readProviderLink,
  settlementDecision,
  simulatedLink,
  toMinorUnits,
  verifySharedSecret,
} from './online-payments.js';

function employee(index: number, overrides: Partial<WpsEmployee> = {}): WpsEmployee {
  const nationalId = `1${String(index).padStart(9, '0')}`;
  return {
    employeeId: `emp-${index}`,
    employeeNo: String(index),
    name: index === 3 ? 'علي, الحسن' : `موظف ${index}`,
    nationalId,
    nationality: 'سعودي',
    insuranceNo: `GOSI-${index}`,
    hireDate: '2025-01-01',
    gosiScheme: 'new',
    status: 'active',
    components: { basic: '8000', housing: '2000', transport: '500' },
    bank: { iban: buildSaudiIban('80', String(index).padStart(18, '0')) },
    additions: '0',
    deductions: '100.00',
    gross: '10500',
    net: '10400',
    ...overrides,
  };
}

describe('mudad and moyasar', () => {
  it('exports a bank CSV for 10 employees with the approved wage columns', () => {
    const rows = buildWpsRows(Array.from({ length: 10 }, (_, index) => employee(index + 1)));
    expect(rows).toHaveLength(10);
    expect(rows.every((row) => row.errors.length === 0)).toBe(true);
    const csv = renderWpsCsv(rows).replace(/^\uFEFF/, '');
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe(WPS_HEADERS.join(','));
    expect(lines).toHaveLength(11);
    expect(lines[3]).toContain('"علي, الحسن"');
    const netSum = rows.reduce((sum, row) => sum.plus(row.net), new Decimal(0));
    expect(netSum.toFixed(2)).toBe('104000.00');
    expect(rows[0]?.basic).toBe('8000.00');
    expect(rows[0]?.housing).toBe('2000.00');
    expect(rows[0]?.other).toBe('500.00');
    expect(rows[0]?.deductions).toBe('100.00');
  });

  it('rejects a WPS row with a broken IBAN or identity and keeps a valid Saudi IBAN', () => {
    const [invalid, valid] = buildWpsRows([
      employee(1, { nationalId: '12', bank: { iban: 'SA000' } }),
      employee(2),
    ]);
    expect(invalid?.errors.join(' ')).toContain('10 أرقام');
    expect(invalid?.errors.join(' ')).toContain('الآيبان');
    expect(valid?.errors).toEqual([]);
    expect(valid?.iban.startsWith('SA')).toBe(true);
    expect(valid?.iban).toHaveLength(24);
  });

  it('calculates July 2026 GOSI shares for a new Saudi scheme and an expatriate', () => {
    const [saudi, expat] = buildGosiRows(
      [
        employee(1, { components: { basic: '10000', housing: '2000' }, gross: '12000', deductions: '0', net: '12000' }),
        employee(2, {
          nationality: 'هندي',
          gosiScheme: null,
          insuranceNo: '',
          components: { basic: '4000' },
          gross: '4000',
          deductions: '0',
          net: '4000',
        }),
      ],
      '2026-09-28',
    );
    expect(GOSI_HEADERS).toContain('EmployeeShare');
    expect(saudi?.scheme).toBe('new');
    expect(saudi?.contributoryWage).toBe('12000.00');
    expect(saudi?.employeeShare).toBe('1290.00');
    expect(saudi?.employerShare).toBe('1530.00');
    expect(expat?.scheme).toBe('expat');
    expect(expat?.employeeShare).toBe('0.00');
    expect(expat?.occupationalHazard).toBe('80.00');
    expect(expat?.errors).toEqual([]);
  });

  it('alerts when an iqama expires within 30 days and ignores a later date', () => {
    const alerts = complianceAlerts(
      [
        employee(1, { iqamaExpiresOn: '2026-10-20', name: 'قريب' }),
        employee(2, { iqamaExpiresOn: '2026-10-29', name: 'بعيد' }),
        employee(3, { insuranceExpiresOn: '2026-09-01', name: 'متأخر' }),
        employee(4, { iqamaExpiresOn: '2026-10-01', status: 'terminated', name: 'منتهٍ' }),
      ],
      '2026-09-28',
      30,
    );
    expect(alerts.map((alert) => alert.employeeName)).toEqual(['متأخر', 'قريب']);
    expect(alerts[0]).toMatchObject({ kind: 'insurance', severity: 'overdue' });
    expect(alerts[1]).toMatchObject({ kind: 'iqama', severity: 'due', daysRemaining: 22 });
  });

  it('builds a Moyasar invoice in halalas with basic auth and reads the hosted URL', () => {
    const call = buildProviderCall(
      {
        provider: 'moyasar',
        amount: '10.50',
        currency: 'SAR',
        description: 'فاتورة SI-1',
        paymentLinkId: 'link-1',
        invoiceId: 'inv-1',
        tenantId: 'tenant-1',
        callbackUrl: 'https://api.example/payments/webhooks/moyasar',
      },
      'sk_test_secret',
    );
    expect(call.url).toBe('https://api.moyasar.com/v1/invoices');
    expect(call.headers.authorization).toBe(basicAuth('sk_test_secret'));
    expect(JSON.parse(call.body)).toMatchObject({ amount: 1050, currency: 'SAR', metadata: { payment_link_id: 'link-1' } });
    expect(toMinorUnits('10.50')).toBe(1050);
    expect(fromMinorUnits(1050)).toBe('10.50');
    expect(readProviderLink('moyasar', { id: 'inv_moy', url: 'https://moyasar.com/i/inv_moy', status: 'initiated' }).url).toContain('inv_moy');
  });

  it('accepts only the configured webhook secret', () => {
    expect(verifySharedSecret('same-secret', 'same-secret')).toBe(true);
    expect(verifySharedSecret('same-secret', 'other-secret')).toBe(false);
    expect(verifySharedSecret(undefined, 'same-secret')).toBe(false);
    expect(verifySharedSecret('short', 'much-longer-secret')).toBe(false);
  });

  it('settles a matching paid webhook and rejects an amount mismatch', () => {
    const paid = interpretWebhook('moyasar', {
      type: 'payment_paid',
      secret_token: 'same-secret',
      data: { id: 'pay_1', status: 'paid', amount: 1050, currency: 'SAR', invoice_id: 'inv_moy', metadata: { tenant_id: 't1', payment_link_id: 'link-1' } },
    });
    expect(paid).toMatchObject({ outcome: 'paid', amount: '10.50', paymentLinkId: 'link-1', tenantId: 't1' });
    expect(settlementDecision({ amount: '10.5000', currency: 'SAR', status: 'pending' }, paid)).toEqual({
      action: 'settle',
      amount: '10.50',
      currency: 'SAR',
      paymentId: 'pay_1',
    });
    const short = { ...paid, amount: '1.00' };
    expect(settlementDecision({ amount: '10.50', currency: 'SAR', status: 'pending' }, short)).toEqual({
      action: 'reject',
      reason: 'amount-mismatch',
    });
    expect(settlementDecision({ amount: '10.50', currency: 'SAR', status: 'paid' }, paid)).toEqual({
      action: 'ignore',
      reason: 'already-paid',
    });
  });

  it('builds Tap and HyperPay calls and a simulation link without calling the network', () => {
    const tap = buildProviderCall(
      {
        provider: 'tap',
        amount: '25',
        currency: 'SAR',
        description: 'Invoice',
        paymentLinkId: 'link-tap',
        invoiceId: 'inv-tap',
        tenantId: 'tenant-tap',
        customerEmail: 'buyer@example.com',
      },
      'sk_tap',
    );
    expect(tap.url).toBe('https://api.tap.company/v2/invoices');
    expect(tap.headers.authorization).toBe('Bearer sk_tap');
    expect(JSON.parse(tap.body).amount).toBe(25);
    const hyper = buildProviderCall(
      {
        provider: 'hyperpay',
        amount: '25',
        currency: 'SAR',
        description: 'Invoice',
        paymentLinkId: 'link-hyper',
        invoiceId: 'inv-hyper',
        tenantId: 'tenant-hyper',
        entityId: 'entity-1',
      },
      'token-hyper',
    );
    expect(hyper.url).toBe('https://eu-prod.oppwa.com/v1/checkouts');
    expect(hyper.body).toContain('entityId=entity-1');
    expect(hyper.body).toContain('paymentType=DB');
    const simulated = simulatedLink('moyasar', '11111111-2222-3333-4444-555555555555');
    expect(simulated.url).toContain('https://pay.simulation.local/moyasar/');
    expect(simulated.externalId.startsWith('sim_moyasar_')).toBe(true);
  });
});
