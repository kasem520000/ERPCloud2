import { Module } from '@nestjs/common';

import { PlatformModule } from '../platform/platform.module.js';
import { OBJECT_STORAGE, type ObjectStoragePort } from '../platform-services/files/object-storage.js';

import {
  ARTIFACT_STORE_FS,
  ARTIFACT_STORE_S3,
  FileArtifactStore,
  S3ArtifactStore,
} from './artifact-store.js';
import { PlatformBackupsController } from './platform-backups.controller.js';
import { PlatformBackupsService } from './platform-backups.service.js';

/**
 * P-C10 — وحدة «البيانات والاسترجاع»: النسخ والاحتفاظ وطلبات البيانات.
 *
 * **لماذا منفذان للتخزين معلَنان هنا بدل منفذٍ واحد يُختار داخل الخدمة؟** لأن الاختيار
 * نفسه جزءٌ من العقد: الشاشة تعرض `store` لكل ملف، ومَن يقرأ «filesystem» يعرف أنه ليس
 * S3. والمنفذان مَعينان في هذه الوحدة (لا في `PlatformServicesModule`) لأن `ObjectStoragePort`
 * يُحقن فيهما، فتكون التبعية صريحةً في موضعها.
 */
@Module({
  imports: [PlatformModule],
  controllers: [PlatformBackupsController],
  providers: [
    PlatformBackupsService,
    // المنفذان يُبنيان بمصنعٍ صريح لا بحقن المنشئ: `FileArtifactStore` يأخذ مساراً
    // (`BACKUP_ARTIFACT_DIR`) وليس مزوّداً، و`S3ArtifactStore` يأخذ منفذ التخزين — فالحقن
    // التلقائي كان سيبحث عن مزوّدٍ باسم `String`.
    { provide: ARTIFACT_STORE_FS, useFactory: () => new FileArtifactStore() },
    {
      provide: ARTIFACT_STORE_S3,
      useFactory: (storage: ObjectStoragePort) => new S3ArtifactStore(storage),
      inject: [OBJECT_STORAGE],
    },
  ],
  exports: [PlatformBackupsService],
})
export class PlatformBackupsModule {}
