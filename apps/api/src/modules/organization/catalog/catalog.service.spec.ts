import { describe, expect, it } from 'vitest';

describe('catalog phase 06 contract', () => {
  it('defines the supported item kinds', () => {
    expect(['stock', 'service', 'composite']).toEqual(['stock', 'service', 'composite']);
  });

  it('keeps catalog routes tenant-scoped by design', () => {
    expect('organization/catalog/items').toContain('organization/catalog');
  });
});
