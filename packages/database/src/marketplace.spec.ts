import { describe, expect, it } from 'vitest';

import {
  MARKETPLACE_APPS,
  MarketplaceRuleError,
  assertReviewedApp,
  brandMark,
  disableApp,
  normaliseDomain,
  screenVisibleForApps,
  tenantCodeForHost,
  txtMatches,
  verificationTxt,
} from './marketplace.js';

describe('marketplace and white-label rules', () => {
  it('shows the e-commerce screens only while Salla, Zid or Shopify is enabled', () => {
    expect(screenVisibleForApps('/settings/ecommerce', [])).toBe(false);
    expect(screenVisibleForApps('/sales/ecommerce-orders', [])).toBe(false);
    expect(screenVisibleForApps('/settings/ecommerce', ['salla'])).toBe(true);
    expect(screenVisibleForApps('/sales/ecommerce-orders', ['zid'])).toBe(true);
    expect(screenVisibleForApps('/settings/ecommerce', ['shopify'])).toBe(true);
    expect(screenVisibleForApps('/settings/files', [])).toBe(true);
    expect(screenVisibleForApps('/purchases/ocr', [])).toBe(true);
  });

  it('rejects an unknown or third-party module code', () => {
    expect(assertReviewedApp('salla').code).toBe('salla');
    expect(() => assertReviewedApp('evil-plugin')).toThrow(MarketplaceRuleError);
    expect(() => assertReviewedApp('../payroll')).toThrow(MarketplaceRuleError);
    expect(MARKETPLACE_APPS.some((app) => 'entry' in app || 'sql' in app)).toBe(false);
  });

  it('keeps settings when an app is disabled', () => {
    const disabled = disableApp({
      code: 'salla',
      isEnabled: true,
      settings: { storeUrl: 'https://demo.salla.sa' },
    });
    expect(disabled.isEnabled).toBe(false);
    expect(disabled.settings).toEqual({ storeUrl: 'https://demo.salla.sa' });
    expect(screenVisibleForApps('/settings/ecommerce', disabled.isEnabled ? [disabled.code] : [])).toBe(false);
  });

  it('normalises a hostname and rejects a bare word or an address', () => {
    expect(normaliseDomain(' HTTPS://Shop.Example.com/ar ')).toBe('shop.example.com');
    expect(normaliseDomain('shop.example.com:443')).toBe('shop.example.com');
    expect(() => normaliseDomain('not a domain')).toThrow(MarketplaceRuleError);
    expect(() => normaliseDomain('localhost')).toThrow(MarketplaceRuleError);
    expect(() => normaliseDomain('127.0.0.1')).toThrow(MarketplaceRuleError);
  });

  it('accepts only the expected TXT token', () => {
    const challenge = verificationTxt('shop.example.com', 'abc123');
    expect(challenge.host).toBe('_erpcloud-verify.shop.example.com');
    expect(txtMatches(challenge.value, ['erpcloud-verify=other', ' erpcloud-verify=abc123 '])).toBe(true);
    expect(txtMatches(challenge.value, ['erpcloud-verify=nope'])).toBe(false);
    expect(txtMatches(challenge.value, [])).toBe(false);
  });

  it('puts the tenant logo on the printed invoice and drops an unsafe color', () => {
    const mark = brandMark('/api/v1/files/logo/content?signature=1', '#0f766e');
    expect(mark.logoHtml).toContain('alt="شعار المنشأة"');
    expect(mark.logoHtml).toContain('src="/api/v1/files/logo/content?signature=1"');
    expect(mark.color).toBe('#0f766e');
    expect(brandMark('x', 'red;background:url(javascript:1)').color).toBe('');
    expect(brandMark('', '#112233').logoHtml).toBe('');
  });

  it('lists the reviewed apps with decimal prices and no executable payload', () => {
    expect(MARKETPLACE_APPS.map((app) => app.code)).toEqual([
      'salla',
      'zid',
      'shopify',
      'moyasar',
      'ocr',
      'esign',
      'wms',
    ]);
    for (const app of MARKETPLACE_APPS) {
      expect(app.monthlyPrice).toMatch(/^\d+\.\d{4}$/);
      expect(JSON.stringify(app)).not.toMatch(/select |insert |<script/i);
    }
    expect(MARKETPLACE_APPS.filter((app) => app.isCore).every((app) => app.screens.length === 0)).toBe(true);
  });

  it('resolves a host only when its domain is active', () => {
    const domains = [
      { domain: 'shop.example.com', status: 'pending', tenantCode: 'demo' },
      { domain: 'books.example.com', status: 'active', tenantCode: 'books' },
    ];
    expect(tenantCodeForHost('https://books.example.com/path', domains)).toBe('books');
    expect(tenantCodeForHost('shop.example.com', domains)).toBeUndefined();
    expect(tenantCodeForHost('missing.example.com', domains)).toBeUndefined();
  });
});
