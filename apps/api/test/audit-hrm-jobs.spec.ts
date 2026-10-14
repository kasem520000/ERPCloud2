import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withOwnerClient } from '@erp/testing';

import { ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * AUD-15 — وظائف HRM: المحذوفة كانت تظهر وتُعدَّل، والحذف كان صلباً.
 *
 * `jobs` يحمل `deleted_at`/`deleted_by` وفهرساً فريداً جزئياً على `deleted_at IS NULL`
 * — أي أن العقد soft delete — لكن `listJobs` لم يرشّح، و`updateJob` لم يشترط
 * `deleted_at IS NULL`، و`deleteJob` نفّذ `DELETE` صلباً فأضاع الأثر.
 *
 * تُثبت المواصفة: القائمة والتعديل لا يتعاملان مع المحذوف (404)، والحذف ناعم (الصف
 * باقٍ بـ`deleted_at`)، وتكرار الحذف 404، والوظيفة المستخدمة 409، والرمز يصير متاحاً
 * بعد الحذف، ولا يعبر مستأجرٌ إلى وظيفة مستأجرٍ آخر.
 */

describe('AUD-15 — وظائف HRM والحذف الناعم', () => {
  let ctx: TestApp;
  let actor: Actor;
  let other: Actor;

  const post = (path: string, body: Record<string, unknown> = {}, token = actor.token) =>
    api(ctx.server, 'post', `/api/v1${path}`, { token, body });
  const patch = (path: string, body: Record<string, unknown> = {}, token = actor.token) =>
    api(ctx.server, 'patch', `/api/v1${path}`, { token, body });
  const remove = (path: string, token = actor.token) => api(ctx.server, 'delete', `/api/v1${path}`, { token });
  const get = (path: string, token = actor.token) => api(ctx.server, 'get', `/api/v1${path}`, { token });

  const createJob = async (code: string, name: string, token = actor.token) => {
    const response = await post('/hrm/jobs', { code, name }, token);
    expect(response.status).toBe(201);
    return (response.body.data ?? response.body) as { id: string; code: string };
  };

  const listJobs = async () => {
    const response = await get('/hrm/jobs');
    return (response.body.data ?? response.body) as Array<{ id: string; code: string }>;
  };

  const rowOf = (id: string) =>
    withOwnerClient(ctx.db.ownerUrl, async (client) => {
      const result = await client.query(`SELECT id, deleted_at, deleted_by FROM jobs WHERE id = $1`, [id]);
      return result.rows[0] as { id: string; deleted_at: Date | null; deleted_by: string | null } | undefined;
    });

  beforeAll(async () => {
    ctx = await createTestApp('audit-hrm-jobs');
    actor = await createActor(ctx, {
      tenantCode: 'audit-hrm-jobs',
      email: 'owner@audit-hrm-jobs.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, 'hrm.view', 'hrm.manage'],
    });
    other = await createActor(ctx, {
      tenantCode: 'audit-hrm-jobs-b',
      email: 'owner@audit-hrm-jobs-b.test',
      permissions: [...ALL_PLATFORM_PERMISSIONS, 'hrm.view', 'hrm.manage'],
    });
  }, 240_000);

  afterAll(async () => {
    await ctx.close();
  });

  it('الحذف ناعم: الصف يبقى بـdeleted_at، والقائمة لا تعرضه', async () => {
    const job = await createJob('JOB-DEL', 'وظيفة للحذف');
    expect((await listJobs()).length, 'a freshly created job is listed').toBe(1);

    const deleted = await remove(`/hrm/jobs/${job.id}`);
    expect(deleted.status).toBe(200);
    expect((deleted.body.data ?? deleted.body) as { deleted: boolean }).toMatchObject({ deleted: true });

    const stored = await rowOf(job.id);
    expect(stored, 'a soft delete never removes the row').toBeTruthy();
    expect(stored!.deleted_at).not.toBeNull();
    expect((await listJobs()).map((entry) => entry.id)).not.toContain(job.id);
  });

  it('صفٌّ محذوفٌ ناعماً في القاعدة (بيانات قديمة/مسار آخر) لا يظهر ولا يُعدَّل', async () => {
    const job = await createJob('JOB-LEGACY', 'وظيفة محذوفة سابقاً');
    // حقن الحالة كما لو حذفها مسارٌ آخر (استيراد قديم أو مسؤول). القائمة والتعديل
    // يجب أن يحترما `deleted_at` سواءٌ كتبه `deleteJob` أو غيره.
    await withOwnerClient(ctx.db.ownerUrl, async (client) => {
      await client.query(`UPDATE jobs SET deleted_at = now() WHERE id = $1`, [job.id]);
    });

    expect((await listJobs()).map((entry) => entry.id)).not.toContain(job.id);
    expect((await patch(`/hrm/jobs/${job.id}`, { name: 'تعديل على محذوف' })).status).toBe(404);
  });

  it('تعديل محذوفٍ ⇒ 404 وتكرار الحذف ⇒ 404', async () => {
    const job = await createJob('JOB-409', 'وظيفة ثانية');
    expect((await remove(`/hrm/jobs/${job.id}`)).status).toBe(200);

    const updated = await patch(`/hrm/jobs/${job.id}`, { name: 'اسم بعد الحذف' });
    expect(updated.status).toBe(404);

    const again = await remove(`/hrm/jobs/${job.id}`);
    expect(again.status).toBe(404);

    // الاسم في القاعدة لم يتغيّر — التعديل رُفض قبل الكتابة.
    const name = await withOwnerClient(ctx.db.ownerUrl, async (client) => {
      const result = await client.query(`SELECT name FROM jobs WHERE id = $1`, [job.id]);
      return (result.rows[0] as { name: string }).name;
    });
    expect(name).toBe('وظيفة ثانية');
  });

  it('الوظيفة المستخدمة من موظف لا تُحذف ⇒ 409، وبعد نقل الموظف تُحذف', async () => {
    const job = await createJob('JOB-USE', 'وظيفة مشغولة');
    const employee = await post('/hrm/employees', { employeeNo: 'EMP-1', name: 'موظف', jobId: job.id });
    expect(employee.status).toBe(201);

    const blocked = await remove(`/hrm/jobs/${job.id}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('JOB_IN_USE');

    const employeeId = ((employee.body.data ?? employee.body) as { id: string }).id;
    expect((await patch(`/hrm/employees/${employeeId}`, { jobId: null })).status).toBe(200);
    expect((await remove(`/hrm/jobs/${job.id}`)).status).toBe(200);
  });

  it('رمز الوظيفة يصير متاحاً بعد الحذف — الفهرس الجزئي يعمل', async () => {
    const first = await createJob('JOB-REUSE', 'وظيفة معاد استخدامها');
    expect((await remove(`/hrm/jobs/${first.id}`)).status).toBe(200);

    const second = await createJob('JOB-REUSE', 'وظيفة بنفس الرمز');
    expect(second.id).not.toBe(first.id);

    // والمحذوفة الأولى لا تظهر في القائمة ولا في التعديل.
    expect((await patch(`/hrm/jobs/${first.id}`, { name: 'x' })).status).toBe(404);
  });

  it('عزل المستأجرين: وظيفة مستأجر آخر 404 في التعديل والحذف', async () => {
    const mine = await createJob('JOB-ISO', 'وظيفة العزل');
    const foreign = await createJob('JOB-ISO-B', 'وظيفة المستأجر الآخر', other.token);
    expect(foreign.id).not.toBe(mine.id);

    expect((await patch(`/hrm/jobs/${foreign.id}`, { name: 'اختراق' })).status).toBe(404);
    expect((await remove(`/hrm/jobs/${foreign.id}`)).status).toBe(404);
    expect((await remove(`/hrm/jobs/${foreign.id}`, other.token)).status).toBe(200);
    expect((await remove(`/hrm/jobs/${mine.id}`)).status).toBe(200);
  });
});
