import type { ObjectStoragePort, PresignedUrl } from '../src/modules/platform-services/index.js';

/**
 * In-memory `OBJECT_STORAGE` adapter.
 *
 * PHASE_04's acceptance criterion is "presign → upload → finalize → download works
 * against local MinIO". Docker is not available in this environment, so the suite proves
 * the *application* half of that flow — row lifecycle, signature minting, verification
 * and the 302 — against this fake, while the SigV4 signature itself is proven against
 * the AWS reference vector in `s3-signer.spec.ts`. What is not covered here is the
 * network hop to MinIO; that is recorded as a known gap in the phase report.
 */
export class FakeObjectStorage implements ObjectStoragePort {
  readonly bucket = 'erp-test';
  readonly uploads: Array<{ objectKey: string; contentType: string }> = [];
  readonly deleted: string[] = [];
  /** Object keys the caller "uploaded" — the fake's stand-in for stored bytes. */
  readonly objects = new Map<string, { contentType: string }>();

  isConfigured(): boolean {
    return true;
  }

  presignUpload(objectKey: string, contentType: string, expiresInSeconds = 900): PresignedUrl {
    this.uploads.push({ objectKey, contentType });
    return {
      url: `https://storage.test/${this.bucket}/${objectKey}?upload=1`,
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
      requiredHeaders: { 'Content-Type': contentType },
    };
  }

  /** Simulates the client PUT that happens between presign and finalize. */
  putObject(objectKey: string, contentType: string): void {
    this.objects.set(objectKey, { contentType });
  }

  presignDownload(objectKey: string, fileName: string, expiresInSeconds = 900): PresignedUrl {
    return {
      url: `https://storage.test/${this.bucket}/${objectKey}?download=${encodeURIComponent(fileName)}`,
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
      requiredHeaders: {},
    };
  }

  async deleteObject(objectKey: string): Promise<boolean> {
    this.deleted.push(objectKey);
    return this.objects.delete(objectKey);
  }
}
