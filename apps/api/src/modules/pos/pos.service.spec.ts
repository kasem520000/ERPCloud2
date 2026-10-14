import { describe, expect, it } from 'vitest';

import { PosService } from './pos.service.js';

describe('PosService', () => {
  it('is constructable for module wiring', () => {
    expect(new PosService(undefined as never, undefined as never, undefined as never)).toBeInstanceOf(PosService);
  });
});
