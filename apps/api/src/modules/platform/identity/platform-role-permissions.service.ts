import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import {
  findPlatformRole,
  platformPermissionDiff,
  platformPermissionsForRoles,
  platformRolePermissionOverridesKey,
  platformRolePermissionOverridesSchema,
  type PlatformRolePermissionOverrides,
} from '@erp/contracts';
import {
  newId,
  platformSettings,
  withPlatformAdminTx,
  type DatabaseHandle,
  type DrizzleTx,
} from '@erp/database';

import { DATABASE_HANDLE } from '../../../database/database.tokens.js';

/**
 * P-C3 — تجاوزات مصفوفة أدوار المنصة: المخزن الذي يجعل `PUT /platform/roles/:code/permissions`
 * فعلًا حقيقيًا لا زخرفة.
 *
 * العلّة التي وُلد من أجلها: الحارس (`PlatformAdminGuard`) و`/me` كانا يشتقّان صلاحيات
 * المشغّل من دالّةٍ نقية في العقود (`platformPermissionsForRoles`) — أي من الفهرس المكتوب في
 * الكود. فلو كُتبت المصوفة في جدولٍ ما ولم يقرأها الحارس، لكانت الشاشة تقول شيئًا والـAPI يقول
 * غيره. لذلك صار **مصدر القراءة واحدًا**: هذا الخدمة، يقرؤها الحارس و`/me` والمصفوفة.
 *
 * القرارات:
 *
 * 1. **التخزين في `platform_settings`** (نطاق المنصّة، `tenant_id IS NULL`) بمفتاح واحد
 *    `console.role_permissions`. الخطة تنصّ على «الترحيل: الجداول قائمة»، وهذا مخزن مفاتيح
 *    المنصّة المكتوب والمُدقَّق أصلاً، يحمل `updated_by`/`version` وRLS.
 * 2. **الجداول المخصّصة تُقرأ داخل `withPlatformAdminTx`** وإلا منعتها سياسة `tenant_isolation`
 *    (الصفّ بمستأجر NULL لا يطابق أي جلسة مستأجر).
 * 3. **صفٌّ يساوي الفهرس = لا صفّ** — نفس قاعدة P-C2 في الرايات: لا نخزّن «تجاوزًا» يقول ما
 *    يقوله الكود أصلاً، ولا نترك شبحًا يجعل الشاشة تقول «مضبوط» بغير سبب.
 * 4. **صفٌّ تالف لا يُسقِط الطلب**: إن كان المخزون ليس JSON صالحًا أو خالف المخطّط، يُعامَل
 *    كغياب التجاوز (فيتصرّف النظام بالفهرس) بدل أن يتعطّل الحارس على كل مسار.
 */
@Injectable()
export class PlatformRolePermissionsService {
  constructor(@Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle) {}

  /** قراءة واحدة لصفّ المنصّة — تُستعمل من الحارس و`/me`. */
  async overrides(): Promise<PlatformRolePermissionOverrides> {
    return withPlatformAdminTx(this.database.db, (tx) => this.readInTx(tx));
  }

  /** نفس القراءة داخل معاملة قائمة (المصفوفة تكتب وتقرأ في معاملة واحدة). */
  async readInTx(tx: DrizzleTx): Promise<PlatformRolePermissionOverrides> {
    const rows = await tx
      .select({ raw: sql<string>`${platformSettings.value}::text` })
      .from(platformSettings)
      .where(
        and(
          sql`${platformSettings.tenantId} IS NULL`,
          eq(platformSettings.key, platformRolePermissionOverridesKey),
        ),
      )
      .limit(1);

    const stored = rows[0];
    if (!stored) return {};

    try {
      const parsed = platformRolePermissionOverridesSchema.safeParse(JSON.parse(stored.raw));
      return parsed.success ? parsed.data : {};
    } catch {
      // A hand-edited row must not lock every operator out of the console.
      return {};
    }
  }

  /** الصلاحيات الفعّالة لمجموعة أدوار — الفهرس + التجاوزات المخزّنة. */
  async effectiveFor(roleCodes: readonly string[]): Promise<string[]> {
    return platformPermissionsForRoles(roleCodes, await this.overrides());
  }

  /**
   * كتابة مجموعة الدور كاملة داخل معاملة المُنادي.
   *
   * - تساوي الفهرس ⇒ **يُحذف** التجاوز (تُحذف القائمة، ويُحذف الصفّ إن فرغت).
   * - خلافه ⇒ يُخزَّن مرتّبًا، فيكون الناتج مع ثبات المدخلات ثابتًا (سهل المقارنة في التدقيق).
   */
  async writeInTx(
    tx: DrizzleTx,
    roleCode: string,
    permissions: readonly string[],
    actorUserId: string | undefined,
  ): Promise<{ overridden: boolean; effective: string[]; before: string[]; after: string[] }> {
    const stored = await this.readInTx(tx);
    const catalogue = [...(findPlatformRole(roleCode)?.permissions ?? [])].sort();
    const wanted = [...permissions].sort();
    const equalsCatalogue = wanted.join('\u0000') === catalogue.join('\u0000');

    const next: Record<string, string[]> = { ...stored };
    if (equalsCatalogue) {
      delete next[roleCode];
    } else {
      next[roleCode] = wanted;
    }

    const before = platformPermissionsForRoles([roleCode], stored);
    const keys = Object.keys(next).sort();

    if (keys.length === 0) {
      // Nothing overridden anywhere → keep the table clean rather than storing `{}`.
      await tx
        .delete(platformSettings)
        .where(
          and(
            sql`${platformSettings.tenantId} IS NULL`,
            eq(platformSettings.key, platformRolePermissionOverridesKey),
          ),
        );
    } else {
      const current = await tx
        .select({ id: platformSettings.id, version: platformSettings.version })
        .from(platformSettings)
        .where(
          and(
            sql`${platformSettings.tenantId} IS NULL`,
            eq(platformSettings.key, platformRolePermissionOverridesKey),
          ),
        )
        .limit(1);

      const value = Object.fromEntries(keys.map((key) => [key, next[key]]));
      if (current[0]) {
        await tx
          .update(platformSettings)
          .set({ value, updatedAt: new Date(), updatedBy: actorUserId ?? null, version: current[0].version + 1 })
          .where(eq(platformSettings.id, current[0].id));
      } else {
        await tx.insert(platformSettings).values({
          id: newId(),
          tenantId: null,
          key: platformRolePermissionOverridesKey,
          value,
          createdBy: actorUserId ?? null,
          updatedBy: actorUserId ?? null,
        });
      }
    }

    return {
      overridden: !equalsCatalogue,
      effective: platformPermissionsForRoles([roleCode], next),
      before,
      after: platformPermissionsForRoles([roleCode], next),
    };
  }

  /** الفرق المقروء بين الفهرس والفعّال — يُكتب في سجل التدقيق مع السبب. */
  diffFor(roleCode: string, effective: readonly string[]): { added: string[]; removed: string[] } {
    return platformPermissionDiff(findPlatformRole(roleCode)?.permissions ?? [], effective);
  }
}
