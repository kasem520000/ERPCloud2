import { describe, expect, it } from 'vitest';

import { encodeObjectKey, presignS3Url, toAmzDate, uriEncode } from './s3-signer.js';

/**
 * The AWS documentation publishes a worked example for "Authenticating Requests: Using
 * Query Parameters (AWS Signature Version 4)" — GET `test.txt` from `examplebucket`,
 * 24 h expiry, 2013-05-24T00:00:00Z. Reproducing its signature byte for byte is what
 * makes this hand-rolled signer trustworthy (see the rationale in `s3-signer.ts`).
 */
const AWS_EXAMPLE = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  expectedSignature: 'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
};

describe('AWS SigV4 query presigning', () => {
  it('reproduces the AWS documentation test vector', () => {
    const { url } = presignS3Url({
      method: 'GET',
      endpoint: 'https://s3.amazonaws.com',
      bucket: 'examplebucket',
      objectKey: 'test.txt',
      region: 'us-east-1',
      accessKeyId: AWS_EXAMPLE.accessKeyId,
      secretAccessKey: AWS_EXAMPLE.secretAccessKey,
      expiresInSeconds: 86_400,
      forcePathStyle: false,
      now: new Date('2013-05-24T00:00:00Z'),
    });

    const parsed = new URL(url);
    expect(parsed.host).toBe('examplebucket.s3.amazonaws.com');
    expect(parsed.pathname).toBe('/test.txt');
    expect(parsed.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(parsed.searchParams.get('X-Amz-Credential')).toBe(
      'AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request',
    );
    expect(parsed.searchParams.get('X-Amz-Date')).toBe('20130524T000000Z');
    expect(parsed.searchParams.get('X-Amz-Expires')).toBe('86400');
    expect(parsed.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    expect(parsed.searchParams.get('X-Amz-Signature')).toBe(AWS_EXAMPLE.expectedSignature);
  });

  it('signs MinIO path-style PUT urls including the content-type header', () => {
    const result = presignS3Url({
      method: 'PUT',
      endpoint: 'http://localhost:9000',
      bucket: 'erp-dev',
      objectKey: 'tenants/abc/2026/09/file id.pdf',
      region: 'us-east-1',
      accessKeyId: 'minioadmin',
      secretAccessKey: 'minioadmin',
      expiresInSeconds: 900,
      forcePathStyle: true,
      headers: { 'Content-Type': 'application/pdf' },
      now: new Date('2026-09-04T12:00:00Z'),
    });

    const parsed = new URL(result.url);
    expect(parsed.host).toBe('localhost:9000');
    expect(parsed.pathname).toBe('/erp-dev/tenants/abc/2026/09/file%20id.pdf');
    expect(parsed.searchParams.get('X-Amz-SignedHeaders')).toBe('content-type;host');
    expect(parsed.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    // The client has to replay the signed header or the signature will not match.
    expect(result.requiredHeaders).toEqual({ 'content-type': 'application/pdf' });
    expect(result.expiresAt.toISOString()).toBe('2026-09-04T12:15:00.000Z');
  });

  it('produces a different signature for a different key, method or expiry', () => {
    const base = {
      endpoint: 'http://localhost:9000',
      bucket: 'erp-dev',
      region: 'us-east-1',
      accessKeyId: 'minioadmin',
      secretAccessKey: 'minioadmin',
      expiresInSeconds: 900,
      forcePathStyle: true,
      now: new Date('2026-09-04T12:00:00Z'),
    } as const;

    const signatureOf = (url: string): string => new URL(url).searchParams.get('X-Amz-Signature') ?? '';

    const put = signatureOf(presignS3Url({ ...base, method: 'PUT', objectKey: 'a.txt' }).url);
    const get = signatureOf(presignS3Url({ ...base, method: 'GET', objectKey: 'a.txt' }).url);
    const other = signatureOf(presignS3Url({ ...base, method: 'PUT', objectKey: 'b.txt' }).url);
    const longer = signatureOf(
      presignS3Url({ ...base, method: 'PUT', objectKey: 'a.txt', expiresInSeconds: 901 }).url,
    );

    expect(new Set([put, get, other, longer]).size).toBe(4);
  });

  it('encodes reserved characters the way S3 expects', () => {
    expect(uriEncode("a b!'()*~")).toBe('a%20b%21%27%28%29%2A~');
    expect(encodeObjectKey('tenants/t 1/a+b.pdf')).toBe('tenants/t%201/a%2Bb.pdf');
    expect(toAmzDate(new Date('2013-05-24T00:00:00.000Z'))).toBe('20130524T000000Z');
  });
});
