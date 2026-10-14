import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { DatabaseHandle } from '@erp/database';

import { DATABASE_HANDLE } from './database.tokens.js';

/**
 * Thin accessor over the shared Drizzle handle. Keeping it as an injectable means the
 * integration tests can swap the whole database (and the connecting role) without
 * touching module wiring.
 */
@Injectable()
export class DatabaseService {
  constructor(@Inject(DATABASE_HANDLE) private readonly handle: DatabaseHandle) {}

  get db() {
    return this.handle.db;
  }

  /** `/health/ready` probe — PHASE_02 §5.1. */
  async checkConnection(): Promise<boolean> {
    try {
      await this.handle.db.execute(sql`SELECT 1`);
      return true;
    } catch {
      return false;
    }
  }
}
