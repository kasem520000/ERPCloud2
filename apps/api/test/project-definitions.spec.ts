import { withOwnerClient } from '@erp/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ALL_ORGANIZATION_PERMISSIONS, ALL_PLATFORM_PERMISSIONS, createActor, type Actor } from './fixtures.js';
import { api } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * R11 — الشاشتان الأخيرتان اللتان كانت خلفيّتهما جاهزة ولا سطحَ لهما:
 * 📋 «بطاقة بند» (`Form_WPF/frmTermsPM.xaml`) و🏗️ «مراحل مشروع»
 * (`Form_WPF/frmProjectStagesPM.xaml` + `frmStagePM.xaml`).
 *
 * وثلاثة أشياء كشفها الفحص الحيّ **قبل** البناء:
 *
 *   1. `POST /projects` بلا `partyId` (عمود NOT NULL) ⇒ **500** لا 422.
 *   2. `POST /projects/:id/stages` بلا اسم و`POST /projects/:id/boq` بلا رمز ⇒ **500** لا 422.
 *   3. `GET /projects/stage-templates` ⇒ **400 INVALID_ID**: المسار لا وجود له فيطابقه
 *      `@Get(':id')` ويقرأ «stage-templates» معرّفاً.
 *
 * والرسائل العربيّة في السبيك منقولةٌ من النافذتين بنصّها:
 * `frmProjectStagesPM.xaml.cs` L192 «يجب تحديد المجموعة» · L233 «المرحلة المحددة موجودة
 * ضمن مراحل المجموعة» · و`frmTermsPM.xaml.cs` L244/L249 «من فضلك أدخل رقم البند/اسم البند».
 */
describe('بطاقة بند ومراحل مشروع — frmTermsPM · frmProjectStagesPM · frmStagePM', () => {
  let ctx: TestApp;
  let actor: Actor;
  let stranger: Actor;
  let partyId = '';
  let projectId = '';

  const data = (body: Record<string, unknown>): Record<string, unknown> => (body.data ?? body) as Record<string, unknown>;
  const rowsOf = (body: unknown): Array<Record<string, unknown>> =>
    (Array.isArray(body) ? body : ((body as { data?: unknown }).data as unknown[])) as Array<Record<string, unknown>>;
  const post = (path: string, body: Record<string, unknown>) => api(ctx.server, 'post', `/api/v1${path}`, { token: actor.token, body });
  const patch = (path: string, body: Record<string, unknown>) => api(ctx.server, 'patch', `/api/v1${path}`, { token: actor.token, body });
  const del = (path: string) => api(ctx.server, 'delete', `/api/v1${path}`, { token: actor.token });
  const get = (path: string) => api(ctx.server, 'get', `/api/v1${path}`, { token: actor.token });

  beforeAll(async () => {
    ctx = await createTestApp('project-definitions');
    const permissions = [...ALL_PLATFORM_PERMISSIONS, ...ALL_ORGANIZATION_PERMISSIONS, 'projects.view', 'projects.manage', 'projects.stage.accredit', 'parties.manage'];
    actor = await createActor(ctx, { tenantCode: 'prj-defs', email: 'owner@prj-defs.test', permissions });
    stranger = await createActor(ctx, { tenantCode: 'prj-defs-2', email: 'owner@prj-defs-2.test', permissions });

    const party = await post('/parties', { kind: 'customer', name: 'شركة المقاولات' });
    expect(party.status).toBe(201);
    partyId = data(party.body).id as string;

    const project = await post('/projects', { code: 'P-100', name: 'برج الأعمال', partyId, contractValue: '100000' });
    expect(project.status).toBe(201);
    projectId = data(project.body).id as string;
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('1. الحرّاس: الحقل الناقص ⇒ 422 برسالة عربيّة، لا 500 من قيدٍ في القاعدة', async () => {
    const noParty = await post('/projects', { code: 'P-101', name: 'بلا عميل' });
    expect(noParty.status).toBe(422);
    expect(noParty.body.code).toBe('PROJECT_FIELDS_REQUIRED');
    expect(noParty.body.detail).toBe('الرجاء إدخال رقم المشروع واسمه والعميل');

    const noCode = await post('/projects', { name: 'بلا رقم', partyId });
    expect(noCode.status).toBe(422);
    expect(noCode.body.code).toBe('PROJECT_FIELDS_REQUIRED');

    const stage = await post(`/projects/${projectId}/stages`, {});
    expect(stage.status).toBe(422);
    expect(stage.body.code).toBe('PROJECT_STAGE_NAME_REQUIRED');
    expect(stage.body.detail).toBe('الرجاء إدخال اسم المرحلة');

    // والحقل الناقص يُسمّى بعينه: «من فضلك أدخل رقم البند» · «... اسم البند» (`frmTermsPM.xaml.cs` L244/L249).
    const boq = await post(`/projects/${projectId}/boq`, { description: 'بند بلا رقم' });
    expect(boq.status).toBe(422);
    expect(boq.body.code).toBe('BOQ_TERMS_REQUIRED');
    expect(boq.body.detail).toBe('من فضلك أدخل رقم البند');

    const boqNoName = await post(`/projects/${projectId}/boq`, { code: 'B-0' });
    expect(boqNoName.status).toBe(422);
    expect(boqNoName.body.detail).toBe('من فضلك أدخل اسم البند');

    const boqNoPrice = await post(`/projects/${projectId}/boq`, { code: 'B-9', description: 'بلا سعر' });
    expect(boqNoPrice.status).toBe(422);

    const template = await post('/projects/stage-templates', { name: 'مجموعة بلا مراحل', stages: [] });
    expect(template.status).toBe(422);
    expect(template.body.code).toBe('PROJECT_STAGE_TEMPLATE_REQUIRED');
  });

  it('2. «🗂️ المجموعة»: القوالب تُقرأ — والمسار لا يقع في `:id` بعد اليوم', async () => {
    const created = await post('/projects/stage-templates', {
      name: 'مجموعة التنفيذ',
      stages: [{ name: 'الحفر' }, { name: 'الخرسانة' }, { name: 'التشطيب' }],
    });
    expect(created.status).toBe(201);
    const template = data(created.body) as { name: string; stages: Array<{ name: string; order: number }> };
    expect(template.name).toBe('مجموعة التنفيذ');
    // «➕ إضافة حالة» تُلحق في الذيل وتُرقّم من 1 — `frmProjectStagesPM.xaml.cs:236`.
    expect(template.stages.map((stage) => `${stage.order}:${stage.name}`)).toEqual(['1:الحفر', '2:الخرسانة', '3:التشطيب']);

    // وهذا هو العيب الذي كان قائماً: المسار يبلغ `@Get(':id')` فيردّ 400 INVALID_ID.
    const listed = await get('/projects/stage-templates');
    expect(listed.status).toBe(200);
    const rows = rowsOf(listed.body);
    expect(rows).toHaveLength(1);
    expect((rows[0] as { name: string }).name).toBe('مجموعة التنفيذ');
  });

  it('3. المراحل: الإضافة تُرقّم في الذيل، والطرفان لا يتحرّكان', async () => {
    const first = await post(`/projects/${projectId}/stages`, { name: 'التصميم' });
    expect(first.status).toBe(201);
    const second = await post(`/projects/${projectId}/stages`, { name: 'التنفيذ' });
    const third = await post(`/projects/${projectId}/stages`, { name: 'التسليم' });
    const stages = [data(first.body), data(second.body), data(third.body)] as Array<{ id: string; stageOrder: number }>;
    expect(stages.map((stage) => stage.stageOrder)).toEqual([1, 2, 3]);

    // «⬆️ لأعلى» على أول مرحلة: لا جارَ فوقها ⇒ لا حركة، ولا خطأ.
    const upAtTop = await post(`/projects/stages/${stages[0]?.id}/move`, { direction: 'up' });
    expect(upAtTop.status).toBe(201);
    expect(data(upAtTop.body).moved).toBe(false);

    const moved = await post(`/projects/stages/${stages[2]?.id}/move`, { direction: 'up' });
    expect(data(moved.body).moved).toBe(true);

    const project = await get(`/projects/${projectId}`);
    const ordered = ((project.body.data as { stages: Array<{ name: string; stageOrder: number }> }).stages ?? []).map((stage) => `${stage.stageOrder}:${stage.name}`);
    expect(ordered).toEqual(['1:التصميم', '2:التسليم', '3:التنفيذ']);

    // و«⬇️ لأسفل» في الذيل لا يحرّك شيئاً.
    const downAtBottom = await post(`/projects/stages/${stages[1]?.id}/move`, { direction: 'down' });
    expect(data(downAtBottom.body).moved).toBe(false);
  });

  it('4. «💾 حفظ»: الاسم يُعدَّل والترتيب يُعاد كتابته بلا اصطدامٍ بالفهرس الفريد', async () => {
    const project = await get(`/projects/${projectId}`);
    const stages = (project.body.data as { stages: Array<{ id: string; name: string }> }).stages;
    const target = stages.find((stage) => stage.name === 'التنفيذ') as { id: string };

    const renamed = await patch(`/projects/stages/${target.id}`, { name: 'التنفيذ الميداني', stageOrder: 1 });
    expect(renamed.status).toBe(200);
    const updated = data(renamed.body) as { name: string; stageOrder: number };
    expect(updated.name).toBe('التنفيذ الميداني');
    expect(updated.stageOrder).toBe(1);

    const after = await get(`/projects/${projectId}`);
    const names = ((after.body.data as { stages: Array<{ name: string; stageOrder: number }> }).stages ?? [])
      .sort((left, right) => left.stageOrder - right.stageOrder)
      .map((stage) => stage.name);
    expect(names).toEqual(['التنفيذ الميداني', 'التصميم', 'التسليم']);

    const blank = await patch(`/projects/stages/${target.id}`, { name: '   ' });
    expect(blank.status).toBe(422);
    expect(blank.body.code).toBe('PROJECT_STAGE_NAME_REQUIRED');
  });

  it('5. الاعتماد: المرحلة تصير `accredited` بمن اعتمدها وبملاحظته', async () => {
    const project = await get(`/projects/${projectId}`);
    const stage = (project.body.data as { stages: Array<{ id: string; name: string }> }).stages[0] as { id: string };
    const accredited = await post(`/projects/stages/${stage.id}/accredit`, { userId: actor.userId, note: 'مطابقة المواصفات' });
    expect(accredited.status).toBe(201);
    const row = data(accredited.body) as { status: string; accreditedBy: string; accreditationNote: string };
    expect(row.status).toBe('accredited');
    expect(row.accreditedBy).toBe(actor.userId);
    expect(row.accreditationNote).toBe('مطابقة المواصفات');
  });

  it('6. «🗑️ حذف»: تُحذف وتُعاد ترقيم البقية فلا تبقى فجوة', async () => {
    const project = await get(`/projects/${projectId}`);
    const middle = (project.body.data as { stages: Array<{ id: string; name: string }> }).stages.find((stage) => stage.name === 'التصميم') as { id: string };
    const removed = await del(`/projects/stages/${middle.id}`);
    expect(removed.status).toBe(200);
    expect(data(removed.body).deleted).toBe(true);

    const after = await get(`/projects/${projectId}`);
    const stages = (after.body.data as { stages: Array<{ name: string; stageOrder: number }> }).stages;
    expect(stages.map((stage) => stage.stageOrder)).toEqual([1, 2]);

    const again = await del(`/projects/stages/${middle.id}`);
    expect(again.status).toBe(404);
    expect(again.body.code).toBe('PROJECT_STAGE_NOT_FOUND');
  });

  it('7. «بطاقة البند»: البند يُكتب على المشروع ويُقرأ معه', async () => {
    const main = await post(`/projects/${projectId}/boq`, { code: 'B-1', description: 'أعمال الحفر', qty: '120', unitValue: '85.5', estimatedCost: '10260', executionPeriod: '30' });
    expect(main.status).toBe(201);
    const term = data(main.body) as { code: string; qty: string; unitValue: string; previouslyBilled: string };
    expect(term.code).toBe('B-1');
    expect(term.qty).toBe('120.0000');
    expect(term.unitValue).toBe('85.5000');
    expect(term.previouslyBilled).toBe('0.0000');

    const sub = await post(`/projects/${projectId}/boq`, { code: 'B-2', description: 'أعمال الخرسانة', unitValue: '300' });
    expect(sub.status).toBe(201);
    // الكمية افتراضها 1 (`boq_terms.qty`) حين لا تُذكر.
    expect((data(sub.body) as { qty: string }).qty).toBe('1.0000');

    const project = await get(`/projects/${projectId}`);
    expect((project.body.data as { boq: unknown[] }).boq).toHaveLength(2);
  });

  it('7b. «✏️ تعديل» و«🗑️ حذف» البند: الرقم والاسم محفوظان، والمفوتر لا يُحذف', async () => {
    const project = await get(`/projects/${projectId}`);
    const terms = (project.body.data as { boq: Array<{ id: string; code: string }> }).boq;
    const target = terms.find((term) => term.code === 'B-2') as { id: string };

    const renamed = await patch(`/projects/boq/${target.id}`, { description: 'أعمال الخرسانة المسلّحة', unitValue: '320' });
    expect(renamed.status).toBe(200);
    const term = data(renamed.body) as { description: string; unitValue: string; code: string };
    expect(term.description).toBe('أعمال الخرسانة المسلّحة');
    expect(term.unitValue).toBe('320.0000');
    expect(term.code).toBe('B-2');

    const duplicate = await patch(`/projects/boq/${target.id}`, { code: 'B-1' });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('BOQ_TERM_CODE_TAKEN');
    expect(duplicate.body.detail).toBe('كود البند مدخل مسبقاً');

    const blank = await patch(`/projects/boq/${target.id}`, { description: '   ' });
    expect(blank.status).toBe(422);
    expect(blank.body.code).toBe('BOQ_TERMS_REQUIRED');
    expect(blank.body.detail).toBe('من فضلك أدخل اسم البند');

    const removed = await del(`/projects/boq/${target.id}`);
    expect(removed.status).toBe(200);
    expect(data(removed.body).deleted).toBe(true);
    const after = await get(`/projects/${projectId}`);
    expect((after.body.data as { boq: unknown[] }).boq).toHaveLength(1);

    const gone = await del(`/projects/boq/${target.id}`);
    expect(gone.status).toBe(404);
    expect(gone.body.code).toBe('BOQ_TERM_NOT_FOUND');

    // البند الذي سبق فوترته لا يُحذف: سطر المستخلص المرحَّل يشير إليه.
    // و«المفوتر سابقاً» يكتبه ترحيل المستخلص لا البطاقة، فيُهيّأ هنا بصفٍّ مباشر.
    const billed = (await get(`/projects/${projectId}`)).body.data as { boq: Array<{ id: string; code: string }> };
    const billedTerm = billed.boq[0] as { id: string };
    await withOwnerClient(ctx.db.ownerUrl, (client) =>
      client.query('UPDATE boq_terms SET previously_billed = 10 WHERE id = $1', [billedTerm.id]),
    );
    const refused = await del(`/projects/boq/${billedTerm.id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('BOQ_TERM_BILLED');
    expect(refused.body.detail).toBe('لا يمكن حذف بند سبق فوترته في مستخلص');
  });

  it('8. عزل المستأجر: مشروع الغير ومرحلته لا يُرَيان', async () => {
    const foreignProject = await api(ctx.server, 'post', '/api/v1/projects', { token: stranger.token, body: { code: 'X-1', name: 'مشروع آخر', partyId: '' } });
    // منشأة الغريب بلا عميل ⇒ 422 لا 500 (الحارس يسبق الوجود).
    expect(foreignProject.status).toBe(422);

    const foreignRead = await api(ctx.server, 'get', `/api/v1/projects/${projectId}`, { token: stranger.token });
    expect(foreignRead.status).toBe(404);

    const project = await get(`/projects/${projectId}`);
    const stageId = (project.body.data as { stages: Array<{ id: string }> }).stages[0]?.id as string;
    const foreignMove = await api(ctx.server, 'post', `/api/v1/projects/stages/${stageId}/move`, { token: stranger.token, body: { direction: 'up' } });
    expect(foreignMove.status).toBe(404);
    expect(foreignMove.body.code).toBe('PROJECT_STAGE_NOT_FOUND');

    const foreignDelete = await api(ctx.server, 'delete', `/api/v1/projects/stages/${stageId}`, { token: stranger.token });
    expect(foreignDelete.status).toBe(404);

    // وقوالب الغريب وحدها: قائمةٌ فارغة لا قالبَنا.
    const theirTemplates = await api(ctx.server, 'get', '/api/v1/projects/stage-templates', { token: stranger.token });
    expect(theirTemplates.status).toBe(200);
    expect(rowsOf(theirTemplates.body)).toHaveLength(0);
  });
});
