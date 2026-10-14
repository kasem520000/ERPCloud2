import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { Injectable, Logger } from '@nestjs/common';
import { DomainError, errorCodes } from '@erp/contracts';
import { env } from '@erp/config';

import { OBJECT_STORAGE, type ObjectStoragePort } from '../platform-services/files/object-storage.js';

/**
 * P-C10 — **أين تستقرّ النسخة**، وكيف تُكتب بصيغةٍ تمنع قراءتها من ملفٍّ سقط في المكان الخطأ.
 *
 * منفذٌ صغير بثلاث عمليات (`put` · `get` · `remove`) وله تنفيذان:
 *
 *   1. **`S3ArtifactStore`** — الوجهة الشرعية: `ObjectStoragePort` القائم (`presignUpload`
 *      ثم `PUT` موقّع) فلا يحتاج المنفذ الثاني ولا اعتمادات في هذا الملف.
 *   2. **`FileArtifactStore`** — البديل **المُعلَن**: نظام ملفات الخادم. وُجد لأن بيئة
 *      المراجعة بلا MinIO، وبلا هذا البديل لا تُختبر النسخة اختباراً حقيقياً — ولأن الشاشة
 *      تقول أيّهما استُعمل (`store`)، فالبديل ليس تمويهاً لغياب التخزين.
 *
 * **وتُشفَّر النسخة دائماً** بـ`AES-256-GCM` بمفتاحٍ مشتقٍّ من `DATA_ENC_KEY` (نفس مفتاح
 * المنصّة المستعمل في زكاة/سلة/الدفع). الملف المكتوب = ترويسةُ نصٍّ واحد + بايتات مشفّرة،
 * ولذلك يقدر التحقّق أن يُثبت أنّ ما في المخزن **ليس** النصّ الصريح.
 */

export const ARTIFACT_STORE_S3 = 'ERP_ARTIFACT_STORE_S3';
export const ARTIFACT_STORE_FS = 'ERP_ARTIFACT_STORE_FS';

export type ArtifactStoreName = 'object-storage' | 'filesystem';

export type StoredArtifact = {
  store: ArtifactStoreName;
  objectKey: string;
  bytes: number;
  /** بصمة النصّ الصريح: تُحسب هنا مرّةً وتُقارَن بعد ذلك بقراءة الملف. */
  checksum: string;
  iv: string;
  format: string;
  encryption: string;
};

export interface ArtifactStorePort {
  readonly name: ArtifactStoreName;
  isConfigured(): boolean;
  put(objectKey: string, plaintext: Buffer, options?: { contentType?: string }): Promise<StoredArtifact>;
  /** البايتات كما هي في المخزن (مشفّرة) — التحقّق يفكّها ويحسب بصمتها. */
  get(objectKey: string): Promise<Buffer>;
  remove(objectKey: string): Promise<boolean>;
}

export const ARTIFACT_FORMAT = 'erp-platform-dump/1';
export const ARTIFACT_ENCRYPTION = 'aes-256-gcm';
const HEADER_PREFIX = 'ERP-BACKUP';
const GCM_TAG_LENGTH = 16;

/**
 * ترويسة الملف: `ERP-BACKUP/1 aes-256-gcm <iv-base64> <bytes>\n`.
 *
 * وجود الـ`iv` في الملف (لا في القاعدة فقط) مقصود: ملفٌّ يُنسخ من المخزن إلى قرصٍ آخر
 * يجب أن يبقى قابلاً للفكّ بالمفتاح وحده — وإلا صارت النسخة رهينة صفٍّ في جدول.
 */
export function artifactHeader(iv: string, plaintextBytes: number): string {
  return `${HEADER_PREFIX}/1 ${ARTIFACT_ENCRYPTION} ${iv} ${plaintextBytes}\n`;
}

export function parseArtifactHeader(
  buffer: Buffer,
): { iv: string; plaintextBytes: number; body: Buffer } | null {
  const newlineAt = buffer.indexOf(0x0a);
  if (newlineAt < 0) return null;
  // الترويسة كلمةٌ واحدة للصيغة (`ERP-BACKUP/1`) ثم الخوارزمية ثم الـiv ثم حجم النصّ —
  // وتُقسَّم إلى أربع كلمات لا خمس، وهو خطأٌ أُصلح بعد أن أسقطه الاختبار الحيّ.
  const [format, algorithm, iv, bytes] = buffer.subarray(0, newlineAt).toString('utf8').split(' ');
  if (format !== `${HEADER_PREFIX}/1` || algorithm !== ARTIFACT_ENCRYPTION) return null;
  if (!iv || !bytes || !Number.isFinite(Number(bytes))) return null;
  return { iv, plaintextBytes: Number(bytes), body: buffer.subarray(newlineAt + 1) };
}

function artifactKey(): Buffer {
  const secret = env.DATA_ENC_KEY ?? env.FILE_URL_SIGNING_SECRET;
  if (!secret || secret.length < 16) {
    throw new DomainError(
      'BACKUP_KEY_MISSING',
      'DATA_ENC_KEY (or FILE_URL_SIGNING_SECRET) is required to encrypt a backup artifact',
      500,
    );
  }
  return createHash('sha256').update(secret).digest();
}

export function sealArtifact(plaintext: Buffer): { body: Buffer; iv: string; checksum: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', artifactKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const checksum = createHash('sha256').update(plaintext).digest('hex');
  return {
    body: Buffer.concat([
      Buffer.from(artifactHeader(iv.toString('base64'), plaintext.byteLength), 'utf8'),
      encrypted,
      tag,
    ]),
    iv: iv.toString('base64'),
    checksum,
  };
}

/** وتفشل الفكّ فشلاً صريحاً — لا تُعيد نصّاً مبتوراً. */
export function openArtifact(stored: Buffer): Buffer {
  const header = parseArtifactHeader(stored);
  if (!header) {
    throw new DomainError('BACKUP_ARTIFACT_UNREADABLE', 'The stored artifact has no readable header', 422);
  }
  if (header.body.byteLength <= GCM_TAG_LENGTH) {
    throw new DomainError(
      'BACKUP_ARTIFACT_UNREADABLE',
      'The stored artifact is shorter than its own tag',
      422,
    );
  }
  const encrypted = header.body.subarray(0, header.body.byteLength - GCM_TAG_LENGTH);
  const tag = header.body.subarray(header.body.byteLength - GCM_TAG_LENGTH);
  try {
    const decipher = createDecipheriv('aes-256-gcm', artifactKey(), Buffer.from(header.iv, 'base64'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  } catch {
    throw new DomainError(
      'BACKUP_ARTIFACT_TAMPERED',
      'The artifact failed its authentication tag — the bytes changed or the key differs',
      422,
    );
  }
}

/** مفتاح التخزين: `backups/<yyyy>/<mm>/<kind>-<id>.dump.enc` — مقروءٌ للعين، ومرتَّبٌ للزمن. */
export function artifactObjectKey(kind: string, id: string, now = new Date()): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `backups/${year}/${month}/${kind}-${id}.dump.enc`;
}

@Injectable()
export class FileArtifactStore implements ArtifactStorePort {
  readonly name = 'filesystem' as const;
  private readonly logger = new Logger(FileArtifactStore.name);
  private readonly root: string;

  constructor(root: string = env.BACKUP_ARTIFACT_DIR) {
    this.root = resolve(root);
  }

  get directory(): string {
    return this.root;
  }

  isConfigured(): boolean {
    return true;
  }

  /** المسار النهائي لمفتاحٍ — يُصدَّر لأن التحقّق الحيّ يقرأ الملف من القرص لا من الـAPI. */
  pathFor(objectKey: string): string {
    const target = resolve(join(this.root, objectKey));
    if (!target.startsWith(`${this.root}/`)) {
      throw new DomainError(errorCodes.VALIDATION_FAILED, 'Artifact key escapes the backup directory', 400);
    }
    return target;
  }

  async put(objectKey: string, plaintext: Buffer): Promise<StoredArtifact> {
    const sealed = sealArtifact(plaintext);
    const target = this.pathFor(objectKey);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, sealed.body);
    // الحجم يُقرأ من القرص بعد الكتابة: هو ما سيسأل عنه المشغّل، لا ما حسبناه في الذاكرة.
    const written = await readFile(target);
    return {
      store: this.name,
      objectKey,
      bytes: written.byteLength,
      checksum: sealed.checksum,
      iv: sealed.iv,
      format: ARTIFACT_FORMAT,
      encryption: ARTIFACT_ENCRYPTION,
    };
  }

  async get(objectKey: string): Promise<Buffer> {
    try {
      return await readFile(this.pathFor(objectKey));
    } catch {
      throw new DomainError('BACKUP_ARTIFACT_MISSING', 'The artifact is not in the backup directory', 404, {
        objectKey,
      });
    }
  }

  async remove(objectKey: string): Promise<boolean> {
    try {
      await rm(this.pathFor(objectKey), { force: true });
      return true;
    } catch (error) {
      this.logger.warn({ objectKey, err: String(error) }, 'failed to remove a backup artifact');
      return false;
    }
  }
}

@Injectable()
export class S3ArtifactStore implements ArtifactStorePort {
  readonly name = 'object-storage' as const;
  private readonly logger = new Logger(S3ArtifactStore.name);

  constructor(private readonly storage: ObjectStoragePort) {}

  isConfigured(): boolean {
    return this.storage.isConfigured();
  }

  async put(objectKey: string, plaintext: Buffer): Promise<StoredArtifact> {
    const sealed = sealArtifact(plaintext);
    const presigned = this.storage.presignUpload(objectKey, 'application/octet-stream');
    const response = await fetch(presigned.url, {
      method: 'PUT',
      headers: presigned.requiredHeaders,
      body: new Uint8Array(sealed.body),
    });
    if (!response.ok) {
      throw new DomainError(
        'BACKUP_UPLOAD_FAILED',
        `Object storage refused the artifact upload (HTTP ${response.status})`,
        502,
      );
    }
    return {
      store: this.name,
      objectKey,
      bytes: sealed.body.byteLength,
      checksum: sealed.checksum,
      iv: sealed.iv,
      format: ARTIFACT_FORMAT,
      encryption: ARTIFACT_ENCRYPTION,
    };
  }

  async get(objectKey: string): Promise<Buffer> {
    const presigned = this.storage.presignDownload(objectKey, objectKey.split('/').pop() ?? objectKey);
    const response = await fetch(presigned.url);
    if (!response.ok) {
      throw new DomainError('BACKUP_ARTIFACT_MISSING', 'Object storage returned no artifact', 404, {
        objectKey,
      });
    }
    return Buffer.from(await response.arrayBuffer());
  }

  async remove(objectKey: string): Promise<boolean> {
    try {
      return await this.storage.deleteObject(objectKey);
    } catch (error) {
      this.logger.warn({ objectKey, err: String(error) }, 'failed to remove a backup artifact from storage');
      return false;
    }
  }
}

/** الاختيار **مُعلَن** في الصفّ: تخزينٌ مُهيّأ ⇒ S3، وإلا فنظام الملفات. */
export function selectArtifactStore(s3: ArtifactStorePort, filesystem: ArtifactStorePort): ArtifactStorePort {
  return s3.isConfigured() ? s3 : filesystem;
}

export { OBJECT_STORAGE };
