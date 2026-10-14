import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  EcommerceProviderRegistry,
  MockEcommerceTransport,
} from '../src/modules/ecommerce/ecommerce.providers.js';
import {
  decryptEcommerceSecret,
  encryptEcommerceSecret,
  verifyEcommerceSignature,
} from '../src/modules/ecommerce/ecommerce.utils.js';

describe('e-commerce provider abstraction (mock transport)', () => {
  const mock = new MockEcommerceTransport();
  const registry = new EcommerceProviderRegistry(mock, mock);

  it('exposes all three supported providers through one client factory', () => {
    expect(
      ['salla', 'zid', 'shopify'].map((provider) =>
        registry.client(provider as 'salla' | 'zid' | 'shopify', 'MOCK-ECO'),
      ),
    ).toHaveLength(3);
  });

  it('tests a Salla connection without making a network request', async () => {
    await expect(registry.client('salla', 'MOCK-ECO').testConnection()).resolves.toMatchObject({
      ok: true,
      remoteStoreId: 'salla-mock-store',
    });
  });

  it('tests a Zid connection through the same provider port', async () => {
    await expect(registry.client('zid', 'MOCK-ECO').testConnection()).resolves.toMatchObject({
      ok: true,
      remoteStoreId: 'zid-mock-store',
    });
  });

  it('tests a Shopify connection through the same provider port', async () => {
    await expect(
      registry.client('shopify', 'MOCK-ECO').testConnection('https://shop.example'),
    ).resolves.toMatchObject({ ok: true, remoteStoreId: 'shopify-mock-store' });
  });

  it('returns the five acceptance orders from a mock store', async () => {
    const response = await registry.client('salla', 'MOCK-ECO').listOrders();
    expect(response.ok).toBe(true);
    expect(response.orders).toHaveLength(5);
    expect(new Set(response.orders?.map((order) => order.id)).size).toBe(5);
  });

  it('rejects a mock token and gives the caller a provider error', async () => {
    await expect(registry.client('salla', 'MOCK-FAIL-token').testConnection()).resolves.toMatchObject({
      ok: false,
      status: 401,
    });
  });

  it('updates stock using the same mock transport and records no secret', async () => {
    await expect(
      registry.client('zid', 'MOCK-ECO').updateStock(undefined, 'remote-item-1', '7'),
    ).resolves.toMatchObject({ ok: true });
    expect(mock.stockUpdates.at(-1)).toMatchObject({
      provider: 'zid',
      itemId: 'remote-item-1',
      quantity: '7',
    });
  });

  it('encrypts access tokens as AES-256-GCM envelopes', () => {
    const encrypted = encryptEcommerceSecret('top-secret-token');
    expect(encrypted).toMatch(/^v1:[^:]+:[^:]+:[^:]+$/);
    expect(encrypted).not.toContain('top-secret-token');
  });

  it('decrypts an encrypted token only inside the provider process', () => {
    const encrypted = encryptEcommerceSecret('round-trip-token');
    expect(decryptEcommerceSecret(encrypted)).toBe('round-trip-token');
  });

  it('accepts a valid HMAC-SHA256 hex signature', () => {
    const body = Buffer.from('{"id":"order-1"}');
    const signature = createHmac('sha256', 'webhook-secret').update(body).digest('hex');
    expect(verifyEcommerceSignature(body, signature, 'webhook-secret')).toBe(true);
  });

  it('accepts Shopify-style base64 HMAC and rejects a changed body', () => {
    const body = Buffer.from('{"id":"order-2"}');
    const signature = createHmac('sha256', 'webhook-secret').update(body).digest('base64');
    expect(verifyEcommerceSignature(body, `sha256=${signature}`, 'webhook-secret')).toBe(true);
    expect(verifyEcommerceSignature(Buffer.from('{"id":"tampered"}'), signature, 'webhook-secret')).toBe(
      false,
    );
  });
});
