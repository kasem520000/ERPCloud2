import { createHash, createHmac } from 'node:crypto';

/**
 * AWS Signature Version 4 **query** presigning for S3-compatible object storage.
 *
 * Why hand-rolled instead of `@aws-sdk/s3-request-presigner`
 * (AI_DEVELOPMENT_PROTOCOL §2 "No new dependencies without justification"):
 * the whole surface Phase 04 needs is "turn a bucket + key into a URL a browser may
 * PUT/GET for N seconds". That is ~80 lines of documented, testable HMAC, versus pulling
 * the AWS SDK (and its credential-provider chain, which would happily read ambient
 * instance credentials — an unwanted authority in a multi-tenant service) into the API
 * image. The implementation is pinned to the AWS documentation test vector in
 * `s3-signer.spec.ts`, so a regression is a failing unit test, not a broken upload.
 *
 * Works against MinIO (path-style, the compose default) and AWS S3 (virtual-host style).
 */

export const SIGV4_ALGORITHM = 'AWS4-HMAC-SHA256';
/** Presigned URLs never commit to a body hash — the client streams arbitrary bytes. */
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

export type PresignInput = {
  method: 'GET' | 'PUT' | 'HEAD' | 'DELETE';
  /** Service endpoint, e.g. `http://localhost:9000` or `https://s3.eu-central-1.amazonaws.com`. */
  endpoint: string;
  bucket: string;
  objectKey: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  expiresInSeconds: number;
  /** MinIO and most gateways only serve `/{bucket}/{key}`; AWS prefers the vhost form. */
  forcePathStyle?: boolean;
  /** Extra headers folded into the signature; the client MUST send them verbatim. */
  headers?: Record<string, string>;
  /** Injected in tests to make the signature deterministic. */
  now?: Date;
};

export type PresignResult = {
  url: string;
  expiresAt: Date;
  /** Headers the client has to replay on the request, `host` excluded. */
  requiredHeaders: Record<string, string>;
};

export function presignS3Url(input: PresignInput): PresignResult {
  const now = input.now ?? new Date();
  const amzDate = toAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const endpoint = new URL(input.endpoint);
  const pathStyle = input.forcePathStyle ?? true;

  const host = pathStyle ? endpoint.host : `${input.bucket}.${endpoint.host}`;
  const basePath = endpoint.pathname.replace(/\/+$/, '');
  const encodedKey = encodeObjectKey(input.objectKey);
  const canonicalUri = pathStyle
    ? `${basePath}/${uriEncode(input.bucket)}/${encodedKey}`
    : `${basePath}/${encodedKey}`;

  const headers: Record<string, string> = { host, ...lowercaseKeys(input.headers ?? {}) };
  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = `${signedHeaderNames
    .map((name) => `${name}:${headers[name]?.trim().replace(/\s+/g, ' ')}`)
    .join('\n')}\n`;
  const signedHeaders = signedHeaderNames.join(';');

  const credentialScope = `${dateStamp}/${input.region}/s3/aws4_request`;
  const query: Record<string, string> = {
    'X-Amz-Algorithm': SIGV4_ALGORITHM,
    'X-Amz-Credential': `${input.accessKeyId}/${credentialScope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(input.expiresInSeconds),
    'X-Amz-SignedHeaders': signedHeaders,
  };
  const canonicalQuery = canonicalQueryString(query);

  const canonicalRequest = [
    input.method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    UNSIGNED_PAYLOAD,
  ].join('\n');

  const stringToSign = [SIGV4_ALGORITHM, amzDate, credentialScope, sha256Hex(canonicalRequest)].join('\n');
  const signature = hmac(signingKey(input.secretAccessKey, dateStamp, input.region), stringToSign).toString(
    'hex',
  );

  return {
    url: `${endpoint.protocol}//${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`,
    expiresAt: new Date(now.getTime() + input.expiresInSeconds * 1000),
    requiredHeaders: lowercaseKeys(input.headers ?? {}),
  };
}

/** `20130524T000000Z` */
export function toAmzDate(date: Date): string {
  return `${date.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15)}Z`;
}

/** RFC 3986 encoding — `encodeURIComponent` leaves `!'()*` alone, S3 does not. */
export function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Object keys keep their `/` separators; every other character is encoded. */
export function encodeObjectKey(key: string): string {
  return key
    .split('/')
    .map((segment) => uriEncode(segment))
    .join('/');
}

function canonicalQueryString(query: Record<string, string>): string {
  return Object.entries(query)
    .map(([key, value]) => [uriEncode(key), uriEncode(value)] as const)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

function lowercaseKeys(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

function signingKey(secretAccessKey: string, dateStamp: string, region: string): Buffer {
  const dateKey = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, 's3');
  return hmac(serviceKey, 'aws4_request');
}
