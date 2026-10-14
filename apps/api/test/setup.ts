import 'reflect-metadata';

/**
 * Vitest setup — NestJS needs `reflect-metadata` loaded before any decorated class is
 * evaluated, and it must happen before the test modules are imported.
 */
Object.assign(process.env, { NODE_ENV: process.env.NODE_ENV ?? 'test' });
