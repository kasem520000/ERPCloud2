import { describe, expect, it } from 'vitest';

import { MigrationService } from './migration.service.js';

describe('MigrationService helpers', () => {
  it('is constructable for Nest module wiring', () => {
    expect(new MigrationService()).toBeInstanceOf(MigrationService);
  });
});
