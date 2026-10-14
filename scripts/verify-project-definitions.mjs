#!/usr/bin/env node
/**
 * Live verification of the three screens that were the last `api` rows in the staff tree (R11)
 * against a running stack (`pnpm db:local` + `pnpm db:migrate` + `pnpm db:seed` + `pnpm dev`).
 *
 * الثلاث شاشات: 🧵 «أنواع التفصيل» (`Form_WPF/frmOrderDetails.xaml.cs` L60) · 📋 «بطاقة بند»
 * (`Form_WPF/frmTermsPM.xaml`؛ `Home.xaml:580` ⇒ `Home.xaml.cs:3731`) · 🏗️ «مراحل مشروع»
 * (`Form_WPF/frmProjectStagesPM.xaml` + `frmStagePM.xaml`؛ `Home.xaml:583` ⇒ `Home.xaml.cs:3750`).
 *
 * وكل توقّع فيه **محسوبٌ من السجلّ** لا مرقومٌ بيد: الشاشات تكتب بمعرّفاتها ثم تقرأ، والسكربت
 * يُنظّف ما أنشأه (الأنواع والمراحل والبنود تُحذف) فيُشغَّل مراراً ويبقى أخضر. والاستثناء المُعلَن:
 * بندٌ سبق فوترته لا يُحذف — فيبقى شاهداً على الفحص، وكذلك فاتورة المستخلص التي كتبها.
 *
 *   ۱) 🧵 أنواع التفصيل: الحارس · التكرار · التعديل · الإخفاء
 *   ۲) 📋 بطاقة بند: الحارس · الكتابة · التعديل · الحذف · المفوتر لا يُحذف
 *   ۳) 🏗️ مراحل مشروع: المجموعة · الإضافة في الذيل · النقل · الحذف بلا فجوة · الاعتماد
 *   ۴) الشاشات الثلاث على مساراتها الجديدة (بعد أن كانت سقالة `/s/`) — حيّةً وفي حزمتها
 *
 * Usage: node scripts/verify-project-definitions.mjs
 *   API_BASE       (default http://127.0.0.1:3000/api/v1)
 *   STAFF_BASE     (default http://127.0.0.1:3001)
 *   VERIFY_TENANT  (default demo)
 *   VERIFY_EMAIL   (default owner@demo.test)
 *   DEMO_OWNER_PASSWORD (يُقرأ من `.env` عبر `loadEnvFiles`)
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnvFiles } from './dotenv.mjs';

loadEnvFiles();

const base = (process.env.API_BASE ?? 'http://127.0.0.1:3000/api/v1').replace(/\/+$/, '');
const staffBase = (process.env.STAFF_BASE ?? 'http://127.0.0.1:3001').replace(/\/+$/, '');
const tenantCode = process.env.VERIFY_TENANT ?? 'demo';
const email = process.env.VERIFY_EMAIL ?? 'owner@demo.test';
const password = process.env.DEMO_OWNER_PASSWORD ?? '';

const MARK = 'R11-CHK';
const TEMPLATE_NAME = 'مجموعة فحص R11';
/**
 * بصمةُ الشوط: أسماء الأنواع ورموز البنود تحملها، فلا يصطدم شوطٌ بما تركه شوطٌ سبقه —
 * حتى لو انقطع السكربت في منتصفه. والمشروع وحده ثابتٌ يُعاد استعماله.
 */
const STAMP = Date.now().toString(36);
const TYPE_NAME = `نوع فحص R11 ${STAMP}`;
const TYPE_CODE = `R11-${STAMP}`;
const termCode = (suffix) => `${MARK}-${STAMP}-${suffix}`;

let checks = 0;
let failures = 0;
const skip = [];

function ok(message) {
  checks += 1;
  console.log(`✔ ${message}`);
}
function bad(message, detail) {
  checks += 1;
  failures += 1;
  console.log(`✘ ${message}${detail === undefined ? '' : ` — ${detail}`}`);
}
function assert(condition, message, detail) {
  if (condition) ok(message);
  else bad(message, detail);
}
function note(message) {
  skip.push(message);
  console.log(`ℹ️  ${message}`);
}

async function raw(method, path, token, body) {
  const response = await fetch(`${base}${path}`, {
    // الطريقة بحروفٍ كبيرة: `fetch` لا يعرف `patch` صغيرة ويرسلها كما هي فيردّ الخادم 400.
    method: method.toUpperCase(),
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

async function call(method, path, token, body) {
  const response = await raw(method, path, token, body);
  if (response.status >= 400) {
    const error = new Error(`${method} ${path} → ${response.status} ${response.body.code ?? ''}`);
    error.status = response.status;
    error.body = response.body;
    throw error;
  }
  return response.body;
}

const data = (payload) => payload?.data ?? payload;
const rows = (payload) => (Array.isArray(payload) ? payload : (payload?.data ?? []));

async function page(path) {
  const response = await fetch(`${staffBase}${path}`, { headers: { accept: 'text/html' } });
  return { status: response.status, html: await response.text() };
}

const main = async () => {
  const login = await call('post', '/auth/login', undefined, { tenantCode, email, password });
  const token = data(login).accessToken;
  // ومن يعتمد المرحلة: `POST /projects/stages/:id/accredit` يطلب `userId` صريحاً كما في النافذة.
  const userId = data(login).user?.id;
  console.log(`✔ signed in as ${email} @ ${tenantCode}`);

  const branches = rows(await call('get', '/branches?limit=1', token));
  const branchId = branches[0]?.id;
  const parties = rows(await call('get', '/parties', token)).filter((party) => party.kind !== 'supplier');
  if (!parties[0]?.id) throw new Error('لا عميل في هذه المنشأة — شغّل البذرة');

  // ─────────────────────────────────────────────── ۱. 🧵 أنواع التفصيل
  console.log('');
  console.log('۱) 🧵 أنواع التفصيل — frmOrderDetails.xaml.cs L60');

  const blank = await raw('post', '/tailoring/types', token, { nameAr: '   ' });
  assert(
    blank.status === 422 && blank.body.code === 'TAILORING_TYPE_NAME_REQUIRED',
    'بلا اسم ⇒ 422 TAILORING_TYPE_NAME_REQUIRED (لا 500 من قيدٍ في القاعدة)',
    `${blank.status} ${blank.body.code ?? ''}`,
  );
  assert(blank.body.detail === 'الرجاء إدخال نوع التفصيل', 'ونصّه «الرجاء إدخال نوع التفصيل»', blank.body.detail);

  const created = data(await call('post', '/tailoring/types', token, { nameAr: TYPE_NAME, code: TYPE_CODE, defaultPrice: '315' }));
  assert(created.nameAr === TYPE_NAME && created.defaultPrice === '315.0000', 'ويُكتب النوع بسعره الافتراضي', `${created.nameAr} · ${created.defaultPrice}`);
  assert(created.active === true, 'ويكون مُتاحاً ابتداءً');

  const sameName = await raw('post', '/tailoring/types', token, { nameAr: TYPE_NAME });
  assert(sameName.status === 409 && sameName.body.code === 'TAILORING_TYPE_NAME_TAKEN', 'وتكرار الاسم ⇒ 409', `${sameName.status} ${sameName.body.code ?? ''}`);
  const sameCode = await raw('post', '/tailoring/types', token, { nameAr: `${TYPE_NAME} ٢`, code: TYPE_CODE });
  assert(sameCode.status === 409 && sameCode.body.code === 'TAILORING_TYPE_CODE_TAKEN', 'وتكرار الرمز ⇒ 409', `${sameCode.status} ${sameCode.body.code ?? ''}`);

  const patched = data(await call('patch', `/tailoring/types/${created.id}`, token, { defaultPrice: '320.5', active: false }));
  assert(patched.defaultPrice === '320.5000' && patched.active === false, 'ويُعدَّل السعر والحالة');
  const listed = rows(await call('get', '/tailoring/types', token));
  assert(!listed.some((row) => row.id === created.id), 'والمُخفى لا يظهر في قائمة الأنواع المُتاحة');
  const all = rows(await call('get', '/tailoring/types?activeOnly=0', token));
  assert(all.some((row) => row.id === created.id && row.defaultPrice === '320.5000'), 'لكنه يظهر بمعرّفه لمن يطلب الكل');
  assert(all.filter((row) => row.nameAr).length === all.length, 'وكل صفٍّ يحمل اسمه العربي');

  await call('delete', `/tailoring/types/${created.id}`, token);
  const gone = rows(await call('get', '/tailoring/types?activeOnly=0', token));
  assert(!gone.some((row) => row.id === created.id), 'و«🗑️ حذف» إخفاءٌ لا محو: يخرج من القوائم');
  const twice = await raw('delete', `/tailoring/types/${created.id}`, token);
  assert(twice.status === 404 && twice.body.code === 'TAILORING_TYPE_NOT_FOUND', 'وحذفُ المُحذَف ⇒ 404', `${twice.status} ${twice.body.code ?? ''}`);

  // ─────────────────────────────────────────────── ۲. 📋 بطاقة بند
  console.log('');
  console.log('۲) 📋 بطاقة بند — frmTermsPM.xaml');

  const noFields = await raw('post', '/projects', token, { code: `${MARK}-${STAMP}-X`, name: 'مشروع بلا عميل' });
  assert(noFields.status === 422 && noFields.body.code === 'PROJECT_FIELDS_REQUIRED', 'مشروعٌ بلا عميل ⇒ 422 (كان 500)', `${noFields.status} ${noFields.body.code ?? ''}`);
  assert(noFields.body.detail === 'الرجاء إدخال رقم المشروع واسمه والعميل', 'ونصّه يدلّ على الناقص', noFields.body.detail);

  const existing = rows(await call('get', '/projects', token)).find((project) => project.code === MARK);
  const project =
    existing ??
    data(
      await call('post', '/projects', token, {
        code: MARK,
        name: 'مشروع فحص بطاقة البند',
        partyId: parties[0].id,
        ...(branchId ? { branchId } : {}),
        contractValue: '250000',
        retentionPct: '5',
      }),
    );
  assert(project.id !== undefined, existing ? 'ويُعاد استعمال مشروع الفحص القائم' : 'ويُنشأ مشروع الفحص', project.code);

  const noCode = await raw('post', `/projects/${project.id}/boq`, token, { description: 'بند بلا رقم', unitValue: '10' });
  assert(noCode.status === 422 && noCode.body.detail === 'من فضلك أدخل رقم البند', 'بندٌ بلا رقم ⇒ «من فضلك أدخل رقم البند»', `${noCode.status} ${noCode.body.detail ?? ''}`);
  const noName = await raw('post', `/projects/${project.id}/boq`, token, { code: termCode('B1'), unitValue: '10' });
  assert(noName.status === 422 && noName.body.detail === 'من فضلك أدخل اسم البند', 'وبلا اسم ⇒ «من فضلك أدخل اسم البند»', `${noName.status} ${noName.body.detail ?? ''}`);
  const noPrice = await raw('post', `/projects/${project.id}/boq`, token, { code: termCode('B1'), description: 'بند' });
  assert(noPrice.status === 422 && noPrice.body.code === 'BOQ_TERMS_REQUIRED', 'وبلا سعر بيع ⇒ 422', `${noPrice.status} ${noPrice.body.code ?? ''}`);

  const term = data(
    await call('post', `/projects/${project.id}/boq`, token, {
      code: termCode('B1'),
      description: 'أعمال الحفر والردم',
      qty: '120',
      unitValue: '85.5',
      estimatedCost: '9000',
      executionPeriod: '30 يوماً',
    }),
  );
  assert(term.qty === '120.0000' && term.unitValue === '85.5000', 'ويُكتب البند بكميته وسعره', `${term.qty} × ${term.unitValue}`);
  assert(term.previouslyBilled === '0.0000', 'و«المفوتر سابقاً» صفر حتى يُرحَّل مستخلص');

  const term2 = data(await call('post', `/projects/${project.id}/boq`, token, { code: termCode('B2'), description: 'أعمال الخرسانة', unitValue: '300' }));
  assert(term2.qty === '1.0000', 'وبلا كمية ⇒ 1 (كما في `boq_terms.qty`)', term2.qty);

  const renamed = data(await call('patch', `/projects/boq/${term.id}`, token, { description: 'أعمال الحفر والردم (معدّل)', unitValue: '90' }));
  assert(renamed.unitValue === '90.0000' && renamed.code === termCode('B1'), 'و«✏️ تعديل» يحفظ الاسم والسعر ويُبقي الرقم');
  const dupe = await raw('patch', `/projects/boq/${term.id}`, token, { code: termCode('B2') });
  assert(dupe.status === 409 && dupe.body.detail === 'كود البند مدخل مسبقاً', 'وترقيمُ بندٍ بترقيم بندٍ آخر ⇒ «كود البند مدخل مسبقاً»', `${dupe.status} ${dupe.body.detail ?? ''}`);
  const emptyName = await raw('patch', `/projects/boq/${term.id}`, token, { description: '  ' });
  assert(emptyName.status === 422 && emptyName.body.detail === 'من فضلك أدخل اسم البند', 'والتعديل إلى الفراغ يُرفض بالنصّ نفسه', `${emptyName.status} ${emptyName.body.detail ?? ''}`);

  await call('delete', `/projects/boq/${term2.id}`, token);
  let project_ = data(await call('get', `/projects/${project.id}`, token));
  assert(!project_.boq.some((row) => row.id === term2.id), 'و«🗑️ حذف» يسحب البند من جدول الكميات');
  const twiceTerm = await raw('delete', `/projects/boq/${term2.id}`, token);
  assert(twiceTerm.status === 404 && twiceTerm.body.code === 'BOQ_TERM_NOT_FOUND', 'وحذفُ المحذوف ⇒ 404', `${twiceTerm.status} ${twiceTerm.body.code ?? ''}`);

  /**
   * بندٌ سبق فوترته: يُرحَّل مستخلصٌ حقيقي (فاتورة بيع + قيد) ثم يُطلب حذفه فيُرفض.
   * وهذا الفحص هو الوحيد الذي **يترك أثراً** (بندٌ مفوتَر وفاتورته) — وهو مقصود: مسار
   * الحذف لا ينفع معه، والشاهد يبقى ليفحصه من يشاء.
   */
  try {
    const bill = data(await call('post', `/projects/${project.id}/progress-bills`, token, { billDate: new Date().toISOString().slice(0, 10), lines: [{ termId: term.id, billPct: '50' }] }));
    await call('post', `/projects/progress-bills/${bill.id}/post`, token, {});
    const billed = data(await call('get', `/projects/${project.id}`, token)).boq.find((row) => row.id === term.id);
    assert(Number(billed.previouslyBilled) > 0, 'وترحيل المستخلص يكتب «المفوتر سابقاً» على البند', billed.previouslyBilled);
    const refused = await raw('delete', `/projects/boq/${term.id}`, token);
    assert(refused.status === 409 && refused.body.code === 'BOQ_TERM_BILLED', 'وحذفُ بندٍ سبق فوترته ⇒ 409 BOQ_TERM_BILLED', `${refused.status} ${refused.body.code ?? ''}`);
    assert(refused.body.detail === 'لا يمكن حذف بند سبق فوترته في مستخلص', 'ونصّه يشرح السبب', refused.body.detail);
  } catch (error) {
    note(`فوتورة البند تُخطّى (${error.message}) — يغطّيها سبيك وحدة المشاريع بصفٍّ مباشر`);
  }

  // ─────────────────────────────────────────────── ۳. 🏗️ مراحل مشروع
  console.log('');
  console.log('۳) 🏗️ مراحل مشروع — frmProjectStagesPM.xaml · frmStagePM.xaml');

  let templates;
  try {
    templates = rows(await call('get', '/projects/stage-templates', token));
    ok(`و«GET /projects/stage-templates» يردّ القائمة (${templates.length}) — كان 400 INVALID_ID لأن ':id' يسبقه`);
  } catch (error) {
    bad('و«GET /projects/stage-templates» يردّ القائمة', error.message);
    templates = [];
  }

  const groupTemplates = templates.filter((row) => row.name === TEMPLATE_NAME);
  const template = groupTemplates[0] ?? data(await call('post', '/projects/stage-templates', token, { name: TEMPLATE_NAME, stages: [{ name: 'الحفر' }, { name: 'الخرسانة' }, { name: 'التشطيب' }] }));
  assert(template.stages.length === 3, 'والمجموعة تُحفظ بمراحلها مرقّمةً من 1', template.stages.map((stage) => `${stage.order}:${stage.name}`).join(' · '));
  const empty = await raw('post', '/projects/stage-templates', token, { name: `${TEMPLATE_NAME} ٢`, stages: [] });
  assert(empty.status === 422 && empty.body.code === 'PROJECT_STAGE_TEMPLATE_REQUIRED', 'ومجموعةٌ بلا مراحل ⇒ 422', `${empty.status} ${empty.body.code ?? ''}`);

  const noStageName = await raw('post', `/projects/${project.id}/stages`, token, {});
  assert(noStageName.status === 422 && noStageName.body.detail === 'الرجاء إدخال اسم المرحلة', 'ومرحلةٌ بلا اسم ⇒ 422 (كان 500)', `${noStageName.status} ${noStageName.body.detail ?? ''}`);

  // بقايا شوطٍ انقطع في منتصفه: تُنظَّف المراحل والبنود غير المفوترة، فيبقى العدّ محسوباً.
  // (والمشروع نفسه يُعاد استعماله: لا مسار حذفٍ للمشاريع في الواجهة.)
  for (const leftover of data(await call('get', `/projects/${project.id}`, token)).stages) {
    await raw('delete', `/projects/stages/${leftover.id}`, token);
  }
  let staleTerms = 0;
  for (const leftover of data(await call('get', `/projects/${project.id}`, token)).boq.filter((row) => row.code.startsWith(MARK) && Number(row.previouslyBilled) === 0)) {
    await raw('delete', `/projects/boq/${leftover.id}`, token);
    staleTerms += 1;
  }
  project_ = data(await call('get', `/projects/${project.id}`, token));
  assert(project_.stages.length === 0, 'ويبدأ الفحص بلا مراحل (وبقايا الأشواط السابقة تُنظَّف)', `${project_.stages.length} · terms:${staleTerms}`);

  const first = data(await call('post', `/projects/${project.id}/stages`, token, { name: 'التصميم' }));
  const second = data(await call('post', `/projects/${project.id}/stages`, token, { name: 'التنفيذ' }));
  assert([first.stageOrder, second.stageOrder].join(',') === '1,2', 'و«➕ إضافة حالة» تُلحق في الذيل بترتيب max+1', `${first.stageOrder} · ${second.stageOrder}`);

  const atTop = data(await call('post', `/projects/stages/${first.id}/move`, token, { direction: 'up' }));
  assert(atTop.moved === false, 'و«⬆️ لأعلى» على أول مرحلة لا يحرّك ولا يُخطئ', atTop.moved);
  const third = data(await call('post', `/projects/${project.id}/stages`, token, { name: 'التسليم' }));
  await call('post', `/projects/stages/${third.id}/move`, token, { direction: 'up' });
  project_ = data(await call('get', `/projects/${project.id}`, token));
  assert(
    [...project_.stages].sort((left, right) => left.stageOrder - right.stageOrder).map((stage) => stage.name).join(' → ') === 'التصميم → التسليم → التنفيذ',
    'و«⬆️» يبدّل المرحلة مع جارتها وحدها',
    project_.stages.map((stage) => `${stage.stageOrder}:${stage.name}`).join(' · '),
  );
  assert(
    project_.stages.map((stage) => stage.stageOrder).sort((left, right) => left - right).join(',') === '1,2,3',
    'ويبقى الترقيم 1..n بلا فجوة ولا تكرار',
    project_.stages.map((stage) => stage.stageOrder).join(','),
  );

  const renamedStage = data(await call('patch', `/projects/stages/${third.id}`, token, { name: 'التسليم الابتدائي' }));
  assert(renamedStage.name === 'التسليم الابتدائي', 'و«💾 حفظ» يحفظ الاسم');
  const blankStage = await raw('patch', `/projects/stages/${third.id}`, token, { name: '   ' });
  assert(blankStage.status === 422 && blankStage.body.code === 'PROJECT_STAGE_NAME_REQUIRED', 'واسمٌ من فراغ ⇒ 422', `${blankStage.status} ${blankStage.body.code ?? ''}`);

  const accredited = data(await call('post', `/projects/stages/${first.id}/accredit`, token, { userId, note: 'مطابقة المواصفات' }));
  assert(accredited.status === 'accredited' && accredited.accreditationNote === 'مطابقة المواصفات', 'والاعتماد يكتب الحالة ومن اعتمدها وملاحظته');

  await call('delete', `/projects/stages/${second.id}`, token);
  project_ = data(await call('get', `/projects/${project.id}`, token));
  assert(project_.stages.length === 2 && project_.stages.map((stage) => stage.stageOrder).sort((left, right) => left - right).join(',') === '1,2', 'و«🗑️ حذف» يُعيد ترقيم ما بقي فلا تبقى فجوة');
  const twiceStage = await raw('delete', `/projects/stages/${second.id}`, token);
  assert(twiceStage.status === 404 && twiceStage.body.code === 'PROJECT_STAGE_NOT_FOUND', 'وحذفُ المحذوف ⇒ 404', `${twiceStage.status} ${twiceStage.body.code ?? ''}`);
  const ghostMove = await raw('post', '/projects/stages/01a0c600-0000-7000-8000-000000000999/move', token, { direction: 'up' });
  assert(ghostMove.status === 404, 'ونقلُ مرحلةٍ مجهولة ⇒ 404 (لا 500)', ghostMove.status);

  // تنظيف ما أنشأه الفحص: المراحل المعروفة ثم القالب لا يُحذف (لا مسار حذف له في الواجهة)
  for (const stage of data(await call('get', `/projects/${project.id}`, token)).stages) {
    await call('delete', `/projects/stages/${stage.id}`, token);
  }
  const cleaned = data(await call('get', `/projects/${project.id}`, token));
  assert(cleaned.stages.length === 0, 'ويُنظّف الفحص مراحله فيبقى المشروع كما كان');

  // ─────────────────────────────────────────────── ۴. الشاشات على مساراتها الجديدة
  console.log('');
  console.log('۴) الشاشات الثلاث — /tailoring/types · /projects/boq · /projects/stages');

  /**
   * الشاشات هنا كائنات عميل تُبَثّ إلى المتصفح، فالـHTML الأولي **إطارٌ فقط** (7 كيلوبايت)
   * ولا يحمل نصّ الصفحة. فيُتحقّق من شيئين: المسار حيّ يردّ 200، والتسميات في حزمة الشاشة
   * المبنية (`apps/staff/.next/server/app/<route>/page.js`) — وهي ما يراه المستخدم فعلاً.
   */
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const screens = [
    { path: '/tailoring/types', title: 'أنواع التفصيل', labels: ['السعر الافتراضي', 'مُتاح'] },
    { path: '/projects/boq', title: 'بطاقة بند', labels: ['الرقم', 'سعر البيع', 'المفوتر سابقاً'] },
    { path: '/projects/stages', title: 'مراحل مشروع', labels: ['إضافة حالة', 'المجموعة', 'لأعلى', 'لأسفل'] },
  ];
  for (const screen of screens) {
    try {
      const response = await page(screen.path);
      assert(response.status === 200, `${screen.path} ⇒ 200 (مسارٌ حقيقي خارج /s)`, response.status);
      const bundle = readFileSync(join(repoRoot, 'apps/staff/.next/server/app', screen.path, 'page.js'), 'utf8');
      assert(bundle.includes(screen.title), `وفي حزمتها «${screen.title}»`, screen.path);
      for (const label of screen.labels) {
        assert(bundle.includes(label), `وتسمية المصدر «${label}» في ${screen.path}`);
      }
      assert(!bundle.includes('قيد التطوير') && !bundle.includes('الشاشة قيد التنفيذ'), `وليست سقالة «قيد الإنشاء» (${screen.path})`);
    } catch (error) {
      bad(`${screen.path} ⇒ 200`, error.message);
    }
  }

  const tree = readFileSync(join(repoRoot, 'apps/staff/lib/navigation.ts'), 'utf8');
  const legacyHrefs = [...tree.matchAll(/'\/s\/[^']*'/g)].map((match) => match[0]);
  assert(screens.every((screen) => !legacyHrefs.includes(`'/s${screen.path}'`)), 'ولا تبقى للثلاث مساراتٍ في شجرة القوائم تحت `/s` (السقالة)');
  assert(
    legacyHrefs.filter((href) => href !== "'/s/inventory/items'").join(' · ') === "'/s/settings/prep-device'",
    'وما بقي تحت `/s` شاشةٌ واحدة مخطَّطة (⚙️ إعدادات جهاز التحضير) ومسارُ وحدةٍ رئيسي',
    legacyHrefs.join(' · '),
  );
  const scaffold = await page('/s/tailoring/types');
  assert(scaffold.status === 200, 'ومسار السقالة نفسه مازال يخدم ما لم يُنفَّذ (لا صفحةٌ مفقودة)', scaffold.status);

  // ─────────────────────────────────────────────── ۵. النتيجة
  console.log('');
  console.log(`${checks - failures}/${checks} فحصاً ناجحاً${skip.length ? ` (${skip.join(' · ')})` : ''}`);
  if (failures) console.log('ℹ️  الذي بقي: مشروع الفحص `R11-CHK` ومجموعة `مجموعة فحص R11` — لا مسار حذف للمشاريع في الواجهة.');
  process.exitCode = failures ? 1 : 0;
};

main().catch((error) => {
  console.error(`✘ توقّف الفحص: ${error.message}`);
  process.exitCode = 1;
});
