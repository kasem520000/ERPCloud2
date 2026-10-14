import { sql } from 'drizzle-orm';
import type { DrizzleTx } from '@erp/database';

/**
 * P-C6 — اسم الفاعل في سجلّ التدقيق عندما يكون الفاعل **مشغّل منصة**.
 *
 * `AuditService.resolveActorLabel` يعرف العضويات: كيف يصوغ اسم من ليس عضواً في منشأةٍ يعمل
 * عليها؟ لذلك يُقرأ الاسم صراحةً من `users` (وهو ما فعله P-C2 في `platformTenantsService`).
 * والنسخة هنا في ملفٍّ واحد كي لا تُنسخ ثلاث مرات في خدمات البريد الثلاث.
 */
export async function platformActorLabel(tx: DrizzleTx, userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const rows = await tx.execute(sql`SELECT full_name FROM users WHERE id = ${userId} LIMIT 1`);
  const label = rows.rows[0]?.full_name;
  return label ? String(label) : null;
}
