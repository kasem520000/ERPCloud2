import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { DatabaseHandle } from '@erp/database';

import { DATABASE_HANDLE, createDatabaseHandle } from './database.tokens.js';
import { DatabaseService } from './database.service.js';

// Re-exported so existing imports of `DATABASE_HANDLE` from the module keep working.
export { DATABASE_HANDLE, createDatabaseHandle } from './database.tokens.js';

/** Releases the pool on shutdown so the process can exit cleanly. */
export class DatabaseLifecycle implements OnApplicationShutdown {
  constructor(@Inject(DATABASE_HANDLE) private readonly handle: DatabaseHandle) {}

  async onApplicationShutdown(): Promise<void> {
    await this.handle.close();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: DATABASE_HANDLE,
      useFactory: () => createDatabaseHandle(),
    },
    DatabaseLifecycle,
    DatabaseService,
  ],
  exports: [DATABASE_HANDLE, DatabaseService],
})
export class DatabaseModule {}
