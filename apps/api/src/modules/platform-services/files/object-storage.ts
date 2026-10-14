import { Injectable, Logger } from '@nestjs/common';
import { DomainError, errorCodes } from '@erp/contracts';
import { env, objectStorageGaps, readObjectStorageEnv, type ObjectStorageEnv } from '@erp/config';

import { presignS3Url } from './s3-signer.js';

/**
 * Object-storage port (TARGET_ARCHITECTURE §8: "Files: S3 pre-signed upload → `files`
 * row → entity attach").
 *
 * The application never streams bytes: it hands out short-lived, private, pre-signed
 * URLs and stores metadata. That keeps large uploads off the API process and means the
 * only thing that must be secret is the storage credential, which lives in env
 * (SECURITY_ARCHITECTURE §9).
 */

export type PresignedUrl = {
  url: string;
  expiresAt: Date;
  requiredHeaders: Record<string, string>;
};

export interface ObjectStoragePort {
  readonly bucket: string;
  /** True when the endpoint/bucket/credentials are all configured. */
  isConfigured(): boolean;
  presignUpload(objectKey: string, contentType: string, expiresInSeconds?: number): PresignedUrl;
  presignDownload(objectKey: string, fileName: string, expiresInSeconds?: number): PresignedUrl;
  /** Best-effort removal used by the orphan collector; never throws. */
  deleteObject(objectKey: string): Promise<boolean>;
}

export const OBJECT_STORAGE = 'ERP_OBJECT_STORAGE';

@Injectable()
export class S3ObjectStorage implements ObjectStoragePort {
  private readonly logger = new Logger(S3ObjectStorage.name);
  private readonly config: ObjectStorageEnv | undefined;

  /**
   * `config === null` يعني «بلا تهيئة» صراحةً — وهو ما يُمكِّن اختبار حالة «التخزين غير
   * مُهيّأ» على المحوّل **الحقيقي** في بيئةٍ تحمل `S3_*`: التمرير الصريح يتقدّم على قراءة
   * البيئة، فلا يُضطرّ الاختبار إلى بديلٍ مزيّف يُخفي السلوك الذي يُراد قياسه.
   */
  constructor(config?: ObjectStorageEnv | null) {
    this.config = config === null ? undefined : (config ?? readObjectStorageEnv());
  }

  get bucket(): string {
    return this.config?.bucket ?? '';
  }

  isConfigured(): boolean {
    return this.config !== undefined;
  }

  /**
   * R7 — «التخزين غير مُهيّأ» حالةُ تهيئةٍ لا عطل، فتُعلَن بـ**503
   * `STORAGE_NOT_CONFIGURED`** وبتفصيلٍ يسمّي متغيّرات البيئة الناقصة (أسماءً لا قيماً).
   *
   * وقبل R7 كان `assertObjectStorageEnv` يرمي `Error` عادياً فيلتقطه المرشّح العام كـ**500
   * «خطأ غير متوقّع»** — وهي أسوأ إجابةٍ ممكنة لشاشةٍ تسأل «هل أستطيع رفع ملف؟»: تخبر
   * المشغّل أنّ الخادم معطوب وهو سليم، وتُخفي أنّ الحلّ سطرٌ في `.env`.
   */
  private requireConfig(): ObjectStorageEnv {
    if (this.config) return this.config;
    const missing = objectStorageGaps(env);
    const reason =
      missing.length > 0
        ? `missing ${missing.join(', ')}. See infrastructure/docker-compose.yml for the local MinIO defaults.`
        : 'the adapter was built without a configuration.';
    throw new DomainError(
      errorCodes.STORAGE_NOT_CONFIGURED,
      `Object storage is not configured: ${reason}`,
      503,
      { missing },
    );
  }

  presignUpload(objectKey: string, contentType: string, expiresInSeconds?: number): PresignedUrl {
    const config = this.requireConfig();
    return presignS3Url({
      method: 'PUT',
      endpoint: config.endpoint,
      bucket: config.bucket,
      objectKey,
      region: config.region,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      expiresInSeconds: expiresInSeconds ?? config.presignExpirySeconds,
      forcePathStyle: config.forcePathStyle,
      // Binding the content type into the signature stops a client from presigning a
      // harmless `text/csv` and then uploading an executable under that key.
      headers: { 'Content-Type': contentType },
    });
  }

  presignDownload(objectKey: string, fileName: string, expiresInSeconds?: number): PresignedUrl {
    const config = this.requireConfig();
    return presignS3Url({
      method: 'GET',
      endpoint: config.endpoint,
      bucket: config.bucket,
      objectKey,
      region: config.region,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      expiresInSeconds: expiresInSeconds ?? config.presignExpirySeconds,
      forcePathStyle: config.forcePathStyle,
    });
  }

  async deleteObject(objectKey: string): Promise<boolean> {
    if (!this.isConfigured()) return false;
    const config = this.requireConfig();
    const { url } = presignS3Url({
      method: 'DELETE',
      endpoint: config.endpoint,
      bucket: config.bucket,
      objectKey,
      region: config.region,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      expiresInSeconds: 60,
      forcePathStyle: config.forcePathStyle,
    });

    try {
      const response = await fetch(url, { method: 'DELETE' });
      return response.ok || response.status === 404;
    } catch (error) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error), objectKey },
        'object delete failed; the row stays marked deleted and will be retried',
      );
      return false;
    }
  }
}
