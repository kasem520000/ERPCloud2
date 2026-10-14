import { describe, expect, it } from 'vitest';

import { moneyText, maskParty } from './format.js';
import { portalRoutes } from './navigation.js';

describe('customer portal contract', () => {
  it('exposes only the self-service screens the portal API backs', () => {
    expect(portalRoutes.map((route) => route.key)).toEqual(['portal', 'invoices', 'statement', 'payments', 'profile']);
  });

  it('keeps every portal screen under the authenticated /portal prefix', () => {
    expect(portalRoutes.every((route) => route.href === '/portal' || route.href.startsWith('/portal/'))).toBe(true);
  });

  it('formats money and masks verification PII', () => {
    expect(moneyText('10.125', 'SAR', 'en-US')).toContain('10.13');
    expect(maskParty('Customer Name')).toBe('Cu***me');
  });
});
