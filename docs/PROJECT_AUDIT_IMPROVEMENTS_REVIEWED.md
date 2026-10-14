# خطة الإصلاح والتحسين بعد مراجعة الأدلة

**تاريخ المراجعة:** 2026-10-06<br>
**المرجع الأساسي للنتائج:** [`PROJECT_AUDIT_FINDINGS_REVIEWED.md`](PROJECT_AUDIT_FINDINGS_REVIEWED.md)<br>
**الهدف:** ترتيب ما يستحق إصلاحًا الآن عمّا هو تحسين مقاس أو قرار منتج. لم تُنفّذ تغييرات مصدر أو اختبارات في هذه الجولة.

## 1. قواعد ترتيب العمل

1. لا تفتح تذكرة «bug» من عنوان في تقرير قديم وحده؛ راجع الحالة والمصدر الحاليين، وأبقِ الأثر المشروط معلّمًا كذلك.
2. أمان API وRLS، ثبات الأثر المالي، ودورة حياة الجلسة قبل تحسينات الأداء أو استبدال المكتبات.
3. اجعل الاختبار يثبت الرفض كما يثبت النجاح. الواجهة المخفية ليست حد تفويض؛ ووجود `@Public()` لا يغني عن توقيع المزود وربط tenant الموثوق.
4. للادعاءات التشغيلية أو الأداء: سجّل baseline، قس بعد التغيير، ولا تعد بتحسن رقمي قبل القياس.
5. migrations، تدوير مفاتيح التشفير، نقل الجلسات، وتحويل auth إلى cookies تغييرات بيانات/عقد؛ تتطلب خطة توافق وتراجع لا تعديلًا سريعًا.
6. الاختبارات المتعذرة تُسجّل `blocked`، ولا تُحتسب نجاحًا.

### ترتيب موجز

| المرحلة | الأولوية | العمل | معيار الإغلاق |
|---|---|---|---|
| 1 | P1 | حالة المستخدم، Owner/system roles، قرار scope، refresh rotation | اختبارات API سلبية/موجبة على PostgreSQL وعزل tenant. |
| 2 | P1 | وصول Stripe/Salla، سياق RLS، تكرار Stripe | callback بلا bearer ينجح فقط بتوقيع صالح؛ التكرار لا يغير اشتراكًا نشطًا ولا ينتج أثرًا مزدوجًا. |
| 3 | P1 | إزالة الرموز من URL، compat session/rate limiting، مفاتيح التشفير | لا سر في URL/logs؛ limiter يعيد 429؛ الأسرار تُقرأ بعد تدوير مفتاح مخطط. |
| 4 | P1/P2 | ذرية الرواتب والمسودات | حقن فشل/تزامن يثبت عدم وجود قيد يتيم أو فقد سطور. |
| 5 | P2 | إصلاح فحص workspace وCI، RLS/API tests، مراجعة CSP والـaudit | pipeline يُشغّل إعدادات المشاريع الحقيقية ويعرض `pass/fail/blocked` لكل خطوة. |
| 6 | P2/P3 | retention، قواعد التنبيه، الخدمة العاملة، accessibility | سياسة/متطلب مكتوب، ومقاييس صحيحة واختبارات قبول لكل مسار. |
| 7 | P3 | cache، indexes، replicas، partitioning، SDK/features/i18n | لا يبدأ قبل baseline وقرار المنتج/التشغيل؛ قياس قبل/بعد. |

## 2. حزم إصلاح قابلة للتسليم

### A. الوصول والهوية — P1

يشمل `AUD-01` و`AUD-02` و`AUD-03` و`AUD-07` و`AUD-12`.

**التنفيذ المطلوب:**

- توحيد شروط active للمستخدم والعضوية والمستأجر عند login/refresh، وتحديد زمن إبطال access tokens عند التعليق.
- منع منح Owner وتعديل صلاحيات الدور النظامي من إدارة العضويات/الأدوار العادية؛ توفير نقل ملكية منفصل إن احتاجه المنتج.
- حسم معنى scopes المكتوبة في واجهة المستخدم. إن كانت حدود وصول، تطبيق enforcement في نقاط الخدمة/الاستعلام؛ إن كانت مرشحات عرض، تعديل الاسم/النص لا الإيحاء بالحماية.
- جعل refresh rotation ذريًا/compare-and-swap. لا تقبل بديلين صالحين لرمز واحد.
- ربط واجهات permission aliases بالعقد المشترك وتصحيح permission keys الخاطئة دون منح امتيازات إضافية.

**معايير القبول والاختبار:**

- حالة suspended/invited لا تصدر جلسة؛ اختبار رمز قائم بعد التعليق حسب سياسة معلنة.
- مدير عضويات لا يستطيع تعيين Owner؛ مدير أدوار لا يستطيع تغيير permission rows لدور system؛ استعادة/نقل المالك لا يفقد آخر مالك.
- كل scope يختبر على المورد نفسه: داخل النطاق يعمل وخارجه يرفض حتى عند تمرير معرف مباشر؛ عزل tenant منفصل.
- طلبا refresh متزامنان بالرمز نفسه لا يخرجان ببديلين صالحين، وسياسة replay موثقة.
- role matrix تغطي aliases القديمة والكنسية، وتؤكد أن API يبقى مصدر قرار التفويض.

### B. Webhooks والفوترة وRLS — P1

يشمل `AUD-04` و`AUD-05` و`AUD-06` وتصحيح R-01/R-02/R-03.

**التنفيذ المطلوب:**

- اجعل Stripe وSalla يصلان إلى المعالج دون Bearer مستخدم، لكن لا تجعل endpoint يقبل حدثًا قبل التوقيع. استخدم raw HTTP body.
- حل tenant Salla من اتصال موثوق بـ`storeId`/سجل الربط؛ لا تعتمد على `TenantGuard` في طلب webhook العام ولا تقبل tenant arbitrary من payload.
- احسم `/billing/*` القديم مقابل الخدمات الأحدث. كل SQL على جدول RLS يجب أن يعمل تحت `withTenantTx` أو `withPlatformAdminTx` بالسياسة المناسبة، أو يُزال المسار القديم بعد مراجعة مستهلكيه.
- احفظ Stripe event/session IDs بقيود فريدة، واربط الحدث باشتراك واحد، واجعل transitions وإعادة المحاولة/الأحداث المتأخرة واضحة.

**معايير القبول والاختبار:**

- على PostgreSQL بحساب التطبيق الحقيقي وسياسات `FORCE ROW LEVEL SECURITY`: قراءة tenant A لا ترى B؛ عملية المنصة لا تستخدم اتصال tenant؛ رفض RLS لا يترك checkout خارجيًا يتيمًا.
- webhook بلا bearer وتوقيع صالح يصل؛ توقيع خاطئ/body مختلف يرفض قبل الكتابة؛ اختبر raw body مع اختلاف المسافات وترتيب المفاتيح.
- تكرار الحدث، حدثان متزامنان، ترتيب معكوس، checkout متعدد، وإلغاء/فشل لا تلغي اشتراكًا صحيحًا ولا تفعّل عدة صفوف.
- endpoints CRM/payment-links الأخرى تبقى عامة عند الحاجة فقط، وتحتفظ بفحص السر/التوقيع وtenant mapping واختبار عدم التكرار.

### C. الجلسات والأسرار وcompat — P1

يشمل `AUD-08` و`AUD-09` و`AUD-16` وS-01/S-04/F-01/F-02.

**التنفيذ المطلوب:**

- استبدل token bridge في query بتبادل لمرة واحدة أو طريقة server-to-server؛ راجع access/refresh storage. إذا اختيرت cookies، نفّذ CSRF/CORS/SameSite/rotation/logout معًا.
- طبّق compat rate limit فعليًا بمفتاح tenant/device ومخزن يناسب تعدد replicas؛ انقل الجلسات إلى مخزن مشترك أو وثّق/افرض تشغيل replica واحد إن كان تصميمًا مقصودًا.
- أزل pepper ومفاتيح التشفير الافتراضية من بيئات تحمل أسرارًا. خطط لتدوير/إعادة تشفير القيم القديمة قبل تغيير المفتاح.
- لا تستخدم hashing بطيئًا على API key عشوائي عالي الإنتروبيا لمجرد أنه مفتاح؛ حدد نموذج تخزين keyed مناسبًا ودوّر السر.

**معايير القبول والاختبار:**

- لا tokens في URLs/Referer/edge logs/browser history، والـbridge لا يعمل مرتين.
- compat يتجاوز الحد بـ429، session يعمل عبر replica/restart وفق التصميم، وإبطال الجهاز يوقف كل الجلسات.
- staging يفشل عند غياب key المطلوب؛ اختبر decrypt قبل/بعد rotation على بيانات اصطناعية ثم خطة بيانات حقيقية منفصلة.
- cookies (إن استُخدمت) تختبر ضد CSRF وعبر origins المسموح بها، لا اختبار حفظ الجلسة وحده.

### D. الاتساق المالي والـdrafts — P1/P2

يشمل `AUD-10` و`AUD-11` وC-01/C-02.

**التنفيذ المطلوب:**

- ربط قيد payroll وحالة المسير، وربط سند الدفع وحالة paid، بنمط ذرّي أو outbox/حالة استعادة مصممة. احتفظ بـ`payroll:${id}` idempotency key واختبر دلالته.
- اجعل تعديل invoice draft للسطور ذريًا، وقرر هل يحافظ على invoice ID. حافظ على سجل المسودة عند فشل validation أو قاعدة البيانات.
- أي عملية قيد/سند يجب أن تعرف سلوك retry حتى عندما لا يرسل العميل `Idempotency-Key`؛ لا تفرض header عالميًا دون تحديد المسارات التي تملك ضمانًا آخر.

**معايير القبول والاختبار:**

- failpoint بعد كل كتابة وقبل الخطوة التالية لا ينتج حالة يتيمة/مكررة بعد retry.
- طلبان متزامنان للـpost/pay/updateDraft لا ينشئان أثرين ولا يمسحان السطور الأصلية.
- راجع قيود unique partial لأرقام payroll؛ تعارض الرقم إما يُعاد تلقائيًا أو يُرجع خطأ مجال آمنًا لا 500 مجهولًا.

### E. فحوص المستودع وCI — P1/P2

يشمل `AUD-18` وF-12/F-13/F-14 المحلي، CI-01/02/06، T-01/T-02/T-05.

`package.json:30` يعرّف `pnpm verify` لكنه يضم TypeScript جذريًا تحت `tsconfig.base.json` قبل lint/build/tests. التقرير المحلي السابق سجّل 363 تشخيصًا لذلك الأمر وTS18003 لحزمة UI؛ هذه نتائج تاريخية غير مكررة هنا. `git ls-files` لم يُظهر ملفات workflow في المسارات `.github/`, `.gitlab-ci.yml`, `.circleci/` ضمن البحث المحدد، كما لم تظهر ملفات Playwright/e2e في البحث المتعقب؛ لا يثبت ذلك غياب CI خارجي.

**معايير القبول:**

- typecheck لكل workspace بإعداد التطبيق/الحزمة ذاته، مع ضمان أن الملفات المفحوصة غير صفر.
- pipeline على PostgreSQL/Redis بإصدارات معلومة يشغّل typegen check وlint وbuild والوحدات وAPI/RLS tests وOpenAPI drift وmigration policy. يعرض السبب إذا كان اختبار ما blocked.
- أصلح marketing tests بمعرفات routes/docs ثابتة، لا أرقام أسطر حساسة لإعادة الترتيب.
- لا تضف coverage threshold اعتباطيًا؛ اجمع baseline ثم اختر حدًا تدريجيًا وفعّالًا.

### F. الرصد والاحتفاظ — P2

- لا تنفّذ O-02 كما لو أن `/metrics` مفقود: endpoint Prometheus موجود. صحح placeholder `erp_queue_depth=0` قبل استخدامه في alert، وحدد وصول scrape حسب ingress/network policy.
- request ID موجود عبر `X-Request-Id` و`traceId`؛ قيّم إضافة W3C trace context وOpenTelemetry لربط الخدمات بدل إنشاء معرف ثانٍ بلا خطة.
- ابنِ SLO/alerts بعد التأكد من معنى المقاييس وتسمياتها؛ تنبيه على 5xx, dead jobs, DB pool, LLM fallback، وZATCA يجب أن يقابله runbook ومسؤول وعتبة مقاسة.
- فعّل retention عبر خطة موثقة لكل صنف بيانات. `RetentionService.plan()` وحده ليس حذفًا ولا أرشفة؛ احتفظ بسجلات التدقيق بحسب القانون/العقد ولا تحذف audit لمجرد cut-off حسابي.
- نفّذ backup restore drill فعليًا في بيئة معزولة مع زمن/RPO/RTO/checksum؛ لا يكفي نجاح إنشاء archive.

**الاختبار/القبول:** مقياس معروف يطابق مصدره؛ تمرين alert ينتج إشعارًا؛ لا تسريب PII/secrets في traces؛ restore يعيد العلاقات والملفات ويثبت صلاحيات RLS؛ تنظيف retention يختبر dry-run ثم بيانات اصطناعية.

### G. القياس والأداء قبل التحسين — P2/P3

- `DATABASE_POOL_MAX` موجود افتراضيًا 10 وحده 100 (`packages/config/src/env.ts:38`; `packages/database/src/client.ts:29-33`)، والـHPA للـAPI يصل إلى 6 replicas (`deploy/k8s/api.yaml:108-109`). قِس connection budget لكل replica وعند DB قبل pgbouncer أو زيادة/تقليل pool.
- قبل Redis cache، materialized views، read replicas، DataLoader، أو outbox parallelism: سجّل p50/p95، query plans، cache hit/miss، DB pool wait، وعدد tenant/حجم البيانات. اعمل invalidation/read-after-write tests.
- لا تضف فهرس لـ`item_price_history` دون query فعلي (لا استخدام خدمة ظهر في البحث)؛ فهرس outbox يعتمد على استعلام retention/health الذي سيستهلكه. استخدم `EXPLAIN (ANALYZE, BUFFERS)` على dataset ممثل.
- الأرقام `MAX+1` تحتاج transaction/sequence/unique retry حسب السجل؛ لا تكتفِ بـ`FOR UPDATE` على جدول فارغ. اختبر توليد متزامن على Parties/HRM/Marina/Content.

## 3. مطابقة فرص التحسين المحلية الـ12

| رقم القائمة المحلية | القرار بعد المراجعة |
|---|---|
| 1. نموذج تفويض واحد واختبار RBAC | **اعتماد P1.** شارك registry/aliases، واختبر API لا الواجهة فقط. لا توسع الصلاحيات أثناء توحيدها. |
| 2. عقد branchScope وscopes | **اعتماد مع قرار منتج أولًا.** افصل per-role scopes عن `X-Branch-Id` وتجنب الادعاء بأنها حد أمني قبل تطبيقه. |
| 3. دورة حياة الجلسة | **اعتماد P1.** يضم AUD-01/AUD-07/AUD-08؛ حدد زمن إبطال access token والـCSRF إذا تحولت الجلسة إلى cookie. |
| 4. Webhooks والفوترة | **اعتماد P1.** يشمل RLS/raw body/idempotency وحالة `/billing/*` مقابل API الأحدث. |
| 5. التحقق في CI لكل workspace | **اعتماد P1/P2.** أصلح tsc/UI أولًا ثم CI قادرًا على تشغيل API على PostgreSQL معروف. |
| 6. مراجع marketing | **اعتماد P2.** route keys أو IDs ثابتة بدل أرقام أسطر ومراجع ملفات غير موجودة؛ نتائج الاختبارات المذكورة تاريخية. |
| 7. مصفوفة E2E للصلاحيات | **اعتماد مرحلي P2.** ابدأ بالهوية/الفوترة/payroll/portal؛ لا يلزم بناء منصة ضخمة قبل إصلاح API tests الأساسية. |
| 8. trace/audit operations | **اعتماد مع تنقيح.** `X-Request-Id` و`traceId` قائمَان؛ أضف W3C/telemetry إن كانت لها جهة استقبال، ولا تسجل secrets أو PII. |
| 9. قياس TenantGuard | **اعتماد.** baseline لعدد/زمن الاستعلامات قبل cache؛ أي cache يجب أن يبطل فور تغير role/scope. |
| 10. اختبار استعادة backup | **اعتماد P2.** استعادة كاملة مع RPO/RTO وRLS/attachments، لا مجرد dry-run. |
| 11. اختبارات تنافس/حمل | **اعتماد انتقائي.** اختبر مسارات المال والـMAX+1 أولًا؛ حمل k6 بعد تعريف SLO وسعة واقعية. |
| 12. اتساق UX/accessibility | **اعتماد P2/P3.** اختبارات segment وimpersonation وkeyboard/screen reader؛ لا تحول تفضيل واجهة إلى bug أمني. |

## 4. مطابقة `origin/main/docs/IMPROVEMENTS.md` — جميع العناوين الـ85

عناوين IDs الظاهرة **85 لا 86** كما تقول خاتمة المستند البعيد. «اختياري» لا يعني «مرفوض»؛ يعني أن الدليل الحالي لا يبرر إصلاحًا عاجلًا دون قياس أو قرار منتج.

### O — Observability

| ID | القرار/التصحيح |
|---|---|
| O-01 | OpenTelemetry فرصة صحيحة إذا لم يوجد collector/instrumentation خارجي؛ لا تدّعِ أن trace ID مفقود. ابدأ بربط API/DB/provider وحدد sampling وPII. |
| O-02 | **تصحيح جوهري:** endpoint Prometheus موجود في `apps/api/src/ops/metrics.controller.ts:7-13` و`metrics.service.ts:79-123`. أصلح placeholder queue metric وحدد وصول scrape؛ لا تنشئ endpoint مكررًا. |
| O-03 | قواعد alert/SLO لا تُعد defect برمجيًا؛ أنشئها بعد تثبيت مقاييس صحيحة ومالك/runbook لكل تنبيه. |
| O-04 | W3C `traceparent` لم يظهر في middleware، لكن `X-Request-Id` يُنقّح ويُعاد في response ويُنشر كـ`traceId` (`request-id.middleware.ts:7-47`). أضف W3C عند الحاجة للتوافق. |
| O-05 | retention غير موثق/غير مكتمل لبعض الجداول؛ توجد خطة حسابية وسياسات أخرى للـbackup/export. عرّف سياسة مصنفة قانونيًا ولا تزعم غياب كل retention. |

### T — Testing

| ID | القرار/التصحيح |
|---|---|
| T-01 | Playwright/E2E غير ظاهر في الملفات المتعقبة المطابقة؛ فرصة اختبار مفيدة بعد جعل بيئة seed/PostgreSQL قابلة للتكرار. ابدأ بمسارات المال والـRBAC والبوابات. |
| T-02 | يوجد `openapi:export` في `package.json:23`؛ فرصة contract diff/lint، لا غياب OpenAPI. لا تقارن live production token endpoint من CI؛ قارن artifact محليًا. |
| T-03 | coverage gate اقتراح. قس baseline لكل حزمة ثم اعتمد حدًا تدريجيًا؛ 60/50 رقم مقترح لا requirement مثبت. |
| T-04 | load test مفيد بعد تعريف الحمل وسعة PostgreSQL؛ قيم RPS المقترحة لا تمثل SLA أو حملًا مثبتًا. |
| T-05 | 15 up migrations بلا down مطابق؛ سياسة rollback لم تُحسم. اختبر up/down فقط للـmigrations المعلنة reversible، ووثق forward-only/restore strategy للبقية. |
| T-06 | mutation testing اختياري؛ طبقه على الوحدات المالية إذا أثبتت قيمة مقابل زمن/تكلفة CI. |
| T-07 | اختبارات sandbox/contract للمزودين مفيدة؛ استخدم secrets اصطناعية وfixtures منزوعة البيانات، ولا تعتمد على availability الإنترنت في كل CI. |

### P — Performance

| ID | القرار/التصحيح |
|---|---|
| P-01 | لا تبنِ cache مع وعد خفض DB 30–50% دون baseline. افحص Redis/usage الحالي ثم اختر مفاتيح TTL/invalidation واختبارات stale permissions. |
| P-02 | **الادعاء المحدد غير صحيح بالمصدر المفحوص:** `PartiesService.list()` يستدعي `decorate` مرة، والـdecorator يجلب definitions وvalues لعدة IDs دفعة (`parties.service.ts:24-27`; `custom-fields.service.ts:224-243`). لا DataLoader هنا دون profiler جديد. |
| P-03 | materialized views قد تسرّع تقارير ثقيلة، لكن لا trigger تلقائيًا على journal قبل خطة consistency/invalidation وbenchmark/EXPLAIN. |
| P-04 | **pool setting موجود أصلًا:** `DATABASE_POOL_MAX` default 10/max 100 (`env.ts:38`) ويستهلكه `createPool` (`client.ts:29-33`). لا تضف الإعداد مرة أخرى؛ احسب إجمالي replicas×pool مقابل DB max_connections، واضبط بالمقاس. |
| P-05 | pg_stat_statements/report أسبوعي فرصة تشغيلية؛ تحقق من extension والصلاحية والـretention قبل إضافة cron. |
| P-06 | read replica قرار بنية مبكر؛ يلزم proof لزمن القراءة، replication lag وread-after-write/RLS قبل تحويل endpoints. |
| P-07 | تقارير async مناسبة فقط للمسارات التي تتجاوز timeout تحت حجم ممثل؛ queue/exports القائمة قد توفر أساسًا. قس قبل إضافة job API. |
| P-08 | التوازي في outbox قد يرفع الحمل ويغير ordering/failure semantics؛ قس زمن drain وعدد tenants، ثم concurrency cap واختبارات idempotency. |

### D — Developer Experience

| ID | القرار/التصحيح |
|---|---|
| D-01 | لا `turbo.json` ظاهر في الجذر؛ Turbo خيار. أثبت أولًا أن CI/workspaces bottleneck caching، ولا تستهدف 50% دون قياس. |
| D-02 | `scripts/typegen.mjs` و`pnpm typegen` موجودان. وثّق التوقيت وأضف check/diff mode إن لم يوفره السكربت؛ لا تعِد إنشاء typegen. |
| D-03 | `db:reset:demo` convenience؛ غير مطلوب لإصلاح خطأ. صممه بحيث لا يستطيع إسقاط بيئة غير demo. |
| D-04 | **ادعاء «لا تحقق Zod شامل/رسالة مفتاح واحد» يحتاج تصحيحًا:** يوجد `envSchema` في `packages/config/src/env.ts`، و`assertRuntimeEnv()` يجمع missing variables (`:254-273`). حسّن شروط env ناقصة مثل transport/key حسب المخاطر؛ لا تستبدل النظام كاملًا. |
| D-05 | تبسيط `local-start.sh` فرصة صيانة بعد مراجعة خطواته ويدوياته، لا خطر تشغيل مؤكد. حافظ على readiness/shutdown وبيئة Arena. |
| D-06 | لم تظهر PR template في الملفات المتعقبة المطابقة. مفيد للفريق، لكنه لا يعوض CI/code review. |
| D-07 | Storybook قرار فريق UI؛ اعتمده إذا كانت المكونات المشتركة تعيق التطوير، مع stories لRTL/keyboard states. |
| D-08 | OpenAPI موجود/يُصدّر؛ typed SDK فرصة، لا ضرورة لإعادة كتابة كل `fetch`. ابدأ بمساحة واجهة واحدة وقارن type drift/bundle. |

### CI — CI/CD والنشر

| ID | القرار/التصحيح |
|---|---|
| CI-01 | لا workflow CI ظهر في المسارات المتعقبة التي فُحصت؛ `pnpm verify` موجود لكن typecheck root سبق أن أعطى 363 تشخيصًا في تشغيل محلي تاريخي. أصلح verify ثم ابنِ pipeline PostgreSQL/Redis؛ وصف «حرج» يخص غياب حاجز الدمج إن تأكدت بيئة GitHub الفعلية. |
| CI-02 | dependency Husky موجودة في root، لكن ملفات `.husky/` لم تظهر ضمن الملفات المتعقبة المطابقة. pre-commit مفيد كتجربة مطور؛ لا تجعله بديلًا لCI ولا تمنع التثبيت/offline workflows. |
| CI-03 | GitOps خيار تشغيل مرتبط بملكية cluster/secrets، لا إصلاح للمصدر. ثبّت environment/approval/rollback model أولًا. |
| CI-04 | وثّق migration → API → web → smoke/rollback إن كان التسلسل غير موثق في runbooks الحالية؛ تحقق من الموجود قبل إنشاء نسخة ثانية. |
| CI-05 | Canary يعتمد على ingress/traffic/SLO. تأجيله مقبول قبل وجود instrumentation/rollback آلي. |
| CI-06 | SQL migration linter وسلامة lock checks مفيدان؛ طبق على PostgreSQL المستهدف وراجع false positives وقيود migrations القديمة. لا تمنع كل DDL بلا تقدير خطر. |

### DOC — Documentation

| ID | القرار/التصحيح |
|---|---|
| DOC-01 | ADRs مفيدة عند اتخاذ قرار حقيقي؛ افحص سجل ADR الحالي ثم أضف decision records لقرارات telemetry/retention عند اعتمادها. |
| DOC-02 | C4 diagram تحسين onboarding؛ اختياري، ويجب توليده/مراجعته مع تغيّر modules. |
| DOC-03 | `/api/docs`/Swagger موجودة عبر `bootstrap.ts:54-58`. Sandbox/try-it-out يتطلب tenant بيانات اختبار منفصلًا ومنع الوصول إلى بيانات حقيقية. |
| DOC-04 | runbooks استثمار تشغيلي؛ ابدأ بـRLS failure، webhook replay، dead jobs، key rotation، backup restore بعد الاتفاق على مالك الحادث. |
| DOC-05 | CONTRIBUTING/branch/commit guidance يرفع DX؛ افحص docs الحالية قبل إنشاء تكرار. |
| DOC-06 | وثّق مصفوفة RLS من `pg_policies`/schema، لا تعتمد على `rlsProtectedTables` القائمة وحدها كقائمة تنفيذ كاملة. |

### F — Feature completeness

| ID | القرار/التصحيح |
|---|---|
| F-01 | تتبع تحسينات مستقبلية خيار إدارة backlog، لا عيب تشغيل؛ لا تفتح 18 تذكرة دون مالك وقيمة. |
| F-02 | مُبدل العملة قرار UX؛ تحقق من `currencies` و`fx_rates`، عملة الفاتورة القانونية، وعدم تغيير مبلغ الاستحقاق عند اختيار عملة عرض. |
| F-03 | workflow approvals موجود جزئيًا حسب docs/source؛ احصر السياسات المعتمدة والمراحل المطلوبة قبل القول إنه «غير موجود» أو بناء محرك XL. |
| F-04 | custom report builder ميزة جديدة؛ API قبول `unknown` إن وُجد يستحق schema review منفصلًا، لا يثبت أن كل المنشئين مفقودون. |
| F-05 | تطبيق `/m` responsive موجود؛ native app/PWA خيار منتج، وليس defect باسم «لا mobile». |
| F-06 | SDK npm فرصة تكامل؛ لا تنشر عميلًا قبل تثبيت OpenAPI compatibility/versioning/auth policy. |
| F-07 | WMS advanced feature roadmap؛ حدد القطاعات التي تتطلب pick/pack/shipping قبل تقدير gap. |
| F-08 | Projects advanced roadmap؛ لا يضاف CPM/EVM ما لم يكن ضمن عقد المنتج. |
| F-09 | CRM advanced roadmap؛ قس طلب السوق والخصوصية قبل email tracking pixels/attribution. |
| F-10 | marketplace apps فرصة؛ افصلها عن التكاملات المبنية، وحدد sandbox/permission model للمطور الخارجي. |

### SH — Security hardening

| ID | القرار/التصحيح |
|---|---|
| SH-01 | **أولوية P2 قوية:** CSP يسمح `unsafe-inline`, `unsafe-eval`, و`frame-ancestors *` في التطبيقات الأربعة (مواضع config في findings). اختبر nonce/hash مع Next production واحتياجات embed؛ تجنب كسر التطبيق بإزالة الكلمات مباشرة. |
| SH-02 | SRI فقط للموارد الخارجية المثبتة؛ لا قيمة لإضافة hashes إلى أصول محلية ذات build hash. جرد تحميل CDN الحالي. |
| SH-03 | SBOM/Dependency-Track خيار supply-chain مفيد بعد CI؛ ثبّت format/version/retention قبل upload خارجي. |
| SH-04 | dependency alerts مفيدة؛ راجع GitHub security settings/lockfile bot الفعلي؛ لا تستنتج غياب الفحص خارج Git من غياب `.github/dependabot.yml` وحده. |
| SH-05 | IBAN/account number بيانات حساسة حسب السياسة. تحقّق من masking، encryption-at-rest في storage، صلاحيات DB، البحث/export والـrotation قبل تشفير أعمدة جديدة؛ migration بلا خطة فهرسة/بحث قد يعطل الدفع. |
| SH-06 | اعمل route matrix لـlogin/refresh/change-password/MFA/e-sign/supplier auth. `@RateLimit` metadata يعمل فقط مع guard؛ login المورد لديه حد IP. اضبط per-account/token limits بحذر من lockout DoS. |
| SH-07 | `PlatformAdminGuard` يحمل TODO صريحًا لـbreak-glass audit (`apps/api/src/modules/platform/guards/platform-admin.guard.ts:68-69`). تحقق من audit المخصص لكل route الحساسة، ثم نفّذ actor/reason/target logging بلا أسرار. |
| SH-08 | mTLS خدمة-إلى-خدمة قرار threat model/cluster؛ تحقّق من TLS الحالي بين DB/Redis/providers قبل وصفه plaintext. |
| SH-09 | secret scanning مفيد مع CI، لكنه يجب أن يفحص التاريخ/الإضافات الجديدة وخيارات الاستثناء؛ لا تضع مفاتيح حقيقية في اختبار أو artifact. |
| SH-10 | pentest مستقل موصى به قبل إطلاق حساس؛ أعد نطاقًا يضم tenant isolation/RLS/webhooks/auth/impersonation، ثم صنف النتائج وأعد الاختبار. ليس تعديل مصدر تلقائيًا. |

### SC — Scalability

| ID | القرار/التصحيح |
|---|---|
| SC-01 | pgbouncer مشروط بميزانية الاتصال/الاستعلامات. الموجود max=10 وHPA max=6 يعني حدًا نظريًا قد يصل 60 اتصالًا للـAPI قبل بقية الخدمات؛ قارنه بحد DB الفعلي وpool queues أولًا. |
| SC-02 | لا دليل على sticky sessions في ingress من هذه المراجعة. أغلب auth JWT stateless، لكن compat `Map` لا يشارك بين replicas؛ افحص ingress بعد حل AUD-09 ولا تعمم «sticky يعطل HPA». |
| SC-03 | sharding/DB-per-tenant تنبؤ بعيد يتطلب عتبات نمو وعمليات partition; لا تبدأ عند رقم 1,000 tenant افتراضي دون benchmark. |
| SC-04 | partitioning للجداول قرار حجم/retention؛ audit log مرشح للتحقيق، لكن journal/invoice/inventory لا تُقسم جماعيًا قبل فحص المفاتيح وRLS والتقارير. |
| SC-05 | CDN للstatic assets يعتمد على public asset policy وcache busting؛ لا تخزن HTML خاص بالمستخدم على edge. |
| SC-06 | async webhook delivery يعتمد على معدل bursts وSLO وidempotency؛ اختبر ترتيب الرسائل وإعادة المحاولة قبل فصل worker. |

### CO — Cost optimization

| ID | القرار/التصحيح |
|---|---|
| CO-01 | S3 lifecycle إعداد infrastructure/provider قد لا يظهر في التطبيق. تحقق من bucket الحالي وretention/restore obligations قبل تغيير tier أو expiry. |
| CO-02 | `estimateCost` موجود حسب التقرير؛ تحقق من `UsageService`/quota الحالية قبل إضافة budget مكرر. أضف per-tenant limit إذا العقد لا يغطي LLM، مع سجل رفض/تكلفة. |
| CO-03 | reserved DB instances قرار شراء بعد تحليل workload/forecast، خارج إصلاحات المصدر. |
| CO-04 | worker autoscaling يعتمد على queue lag ووقت بدء العامل؛ لا scale-to-zero إذا كان يخرق latency أو dead-letter recovery. |
| CO-05 | `next/image`/sharp تحسين أداء بعد قياس حجم الصور وعقد التخزين؛ لا تحوّل صور invoice/product الخاصة إلى CDN عام. |
| CO-06 | cost dashboard اقتراح حوكمة؛ عرّف مصادر الفواتير/العملة والمالك والميزانية قبل تصميمه. |

### CMP — Compliance

| ID | القرار/التصحيح |
|---|---|
| CMP-01 | اختبار ZATCA sandbox قيمة عالية قبل الإنتاج؛ النتائج/stubs المحلية لا تثبت قبول sandbox. اختبر clearance/reporting والـnotes ببيانات اعتماد اختبارية، وثق المواصفة/version. |
| CMP-02 | data residency قرار قانون/عقد وسوق؛ لا تفترض GDPR ينطبق على كل tenant ولا تضف region field بلا خطة migration/routing. |
| CMP-03 | سياسة retention مطلوبة بحسب نوع البيانات والاختصاص. فرّق audit/accounting/HR/PII/backups؛ احفظ القيود القانونية على المحاسبة قبل purge. |
| CMP-04 | export للعميل يتبع الولاية/العقد والتحقق من الهوية؛ لا تنشئ endpoint عام قبل حسم نطاق البيانات والتدقيق. |
| CMP-05 | erasure لا يجوز أن تمحو سجلات مالية يلزم حفظها؛ صمم anonymization/retention وفق legal review لكل علاقة. |
| CMP-06 | backup restore drill أولوية تشغيلية؛ استعد backup حقيقيًا في بيئة معزولة وقس RPO/RTO/attachments/RLS شهريًا أو حسب سياسة الفريق. |
| CMP-07 | توقيع XML/متطلبات ZATCA لا تعني تلقائيًا أن PDF يجب أن يحمل PAdES. اطلب رأيًا قانونيًا/متطلب عميل قبل ميزة توقيع PDF. |

### I18N — Internationalization

| ID | القرار/التصحيح |
|---|---|
| I18N-01 | دعم EN/next-intl مشروع منتج متعدد الأسابيع؛ اعتمده إذا كانت الإنجليزية ضمن عقد المنتج، واختبر RTL/LTR على الصفحات لا chrome فقط. |
| I18N-02 | error codes ثابتة؛ ترجمة العرض في client/API مفيدة لكن تفاوض `Accept-Language` يحتاج عقدًا موحدًا ولا يغير codes. |
| I18N-03 | `Intl.NumberFormat` فرصة عرض؛ لا تحوّل الحساب المالي أو المخزن من Decimal/string إلى float؛ اعرض currency code والعملة الفعلية. |
| I18N-04 | `Intl.DateTimeFormat` مناسب للعرض حسب tenant locale/timezone؛ افصل date-only عن timestamp كما في AUD-17، ولا تعِد تفسير تاريخ ledger. |
| I18N-05 | French locale تابع للسوق المستهدف، ليس نقصًا عامًا. |
| I18N-06 | glossary AR/EN/FR يقلل التباين إذا بدأ التعريب المتعدد؛ لا حاجة إليه قبل حسم المصطلحات/اللغات المعتمدة. |

## 5. ما لا ينبغي فعله دون دليل

- لا تنشئ `/metrics` جديدًا؛ صحح المقاييس الموجودة وسياستها الشبكية.
- لا تضف DataLoader لـ`PartiesService.list()` استجابةً لادعاء N+1 الذي يخالف batch الحالي.
- لا تضف `DATABASE_POOL_MAX` ثانية؛ قِس الميزانية الحالية أولًا.
- لا تضف migrations down عكسية قد تحذف بيانات backfill دون استعادة/forward-only policy.
- لا تغيّر key encryption مباشرة؛ احفظ القدرة على فك كل بيانات key-version القديمة.
- لا تحوّل auth إلى cookies بلا CSRF، ولا تضع token في URL كحل مؤقت.
- لا تجعل كل POST يتطلب Idempotency-Key دون فحص قواعد status/unique الحالية.
- لا تعمم منع download عند `skipped` virus scan إلا بعد تحديد شرط المنتج/الامتثال؛ لكن لا تسجل `skipped` على أنه `clean`.
- لا تضف cache/index/partition/replica/parallelism قبل baseline واختبار invalidation وconsistency.
- لا تخفض اختبارات فاشلة ولا توسّع صلاحية أو تتجاوز RLS لإمرار pipeline.

## 6. بوابة القبول النهائية لكل إصلاح

قبل إغلاق أي تذكرة، أرفق:

1. ID المصدر/النتيجة المحدثة وقرار `confirmed / conditional / not reproduced / product decision`.
2. الملفات التي تغيّرت وسلوك قبل/بعد، دون الاعتماد على لقطة واجهة فقط.
3. اختبار سلبي وإيجابي يغطي الأثر الموصوف؛ واختبار concurrency/failpoint إذا كان الادعاء يعتمد على السباق أو الفشل بين معاملتين.
4. نوع قاعدة البيانات/الدور/سياسات RLS ونسخة البيئة حيث ينطبق.
5. أوامر تحقق منفذة ونتيجة كل workspace، مع تمييز `blocked` من `pass`.
6. migration/rollback أو forward-only/backfill/key-rotation plan حيث تنطبق؛ لا تقبل فقد بيانات ضمني.
7. قياس baseline وبعده لأي تحسين أداء/تكلفة، وإزالة الوعود الرقمية غير المقاسة.

**حد النطاق:** هذه الخطة توجّه إصلاحات مبنية على مقارنة التقريرين المحليين بتقارير `origin/main` ومراجعة ساكنة موجّهة. لا تفترض أن 85 فرصة التحسين أخطاء، ولا تدّعي فحص كل سطر أو تشغيل اختبارات/بيئة إنتاج.
