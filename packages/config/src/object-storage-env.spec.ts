import { describe, expect, it } from 'vitest';

import { assertObjectStorageEnv, env, objectStorageGaps, readObjectStorageEnv } from './env.js';

/**
 * Object-storage env validation — PHASE_04 §5.3 ("S3 env validation").
 *
 * The API must boot without S3 (the files endpoints are simply unusable), but the moment
 * something tries to mint a pre-signed URL the failure has to name every missing
 * variable at once instead of dying on the first one.
 */
const complete = {
  ...env,
  S3_ENDPOINT: 'http://localhost:9000/',
  S3_BUCKET: 'erp',
  S3_ACCESS_KEY_ID: 'minioadmin',
  S3_SECRET_ACCESS_KEY: 'minioadmin',
  S3_REGION: 'us-east-1',
  S3_FORCE_PATH_STYLE: true,
  S3_PRESIGN_EXPIRY_SECONDS: 900,
};

describe('object storage env', () => {
  it('reports every missing variable, not just the first', () => {
    const gaps = objectStorageGaps({ ...complete, S3_BUCKET: undefined, S3_SECRET_ACCESS_KEY: undefined });
    expect(gaps).toEqual(['S3_BUCKET', 'S3_SECRET_ACCESS_KEY']);
  });

  it('reads a complete configuration and normalises the endpoint', () => {
    const storage = readObjectStorageEnv(complete);
    expect(storage).toBeDefined();
    // A trailing slash would produce `//bucket` in the signed path.
    expect(storage?.endpoint).toBe('http://localhost:9000');
    expect(storage?.bucket).toBe('erp');
    expect(storage?.forcePathStyle).toBe(true);
  });

  it('returns undefined rather than a half-configured client', () => {
    expect(readObjectStorageEnv({ ...complete, S3_ENDPOINT: undefined })).toBeUndefined();
  });

  it('throws one aggregated error that points at the compose file', () => {
    expect(() => assertObjectStorageEnv({ ...complete, S3_ENDPOINT: undefined, S3_BUCKET: undefined })).toThrow(
      /missing S3_ENDPOINT, S3_BUCKET.*docker-compose/s,
    );
  });
});
