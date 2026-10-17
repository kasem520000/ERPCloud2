/**
 * P-M8 — القطاعات: **الوحدات الرأسية القائمة، لا قطاعاتٍ مُخترعة** (`MARKETING_SITE_PLAN.md` §5 و§9).
 *
 * الخطة تقول في §9: «القطاعات مقابل *industries*؛ والوحدات الرأسية القائمة (تفصيل · نظارات ·
 * مرسى · مقاولات · سلة) هي قطاعات فعلاً». أي أن هذه الصفحات **لا تَعِد بميزات**: كل سطرٍ فيها
 * مقابله شاشةٌ تعمل في `apps/staff`، وكل شاشةٍ تحمل **ملفها وسطرها** في
 * `apps/staff/lib/navigation.ts` — كما حملت شاشات الموظّفين مصدرَها من `Desktop_ERP`
 * (القاعدة نفسها في `PROJECT_CONTRACT`: التسمية حرفية والمصدر مذكور).
 *
 * فالقراءة ممكنة: من شكّ في «قياسات العملاء» فتح الملف والسطر ورأى التسمية نفسها. وهذا ما
 * يجعل الصفحة **إثباتاً** لا شعاراً — ولا تُكتب هنا تسميةٌ لم تُنقل بحروفها.
 *
 * وحدٌّ مقصود: **لا وعود ولا أرقام** — لا «٪٣٠ أسرع» ولا «آلاف العملاء» ولا شهادات. الصفحة
 * تصف ما في النظام وتقول لمن يصلح؛ والحكم للزائر.
 */

export type IndustryScreen = {
  /** التسمية **حرفياً** كما في شجرة `apps/staff`. */
  label: string;
  /** مسار الشاشة في تطبيق العمل — يُظهر أن للكلام شاشةً لا فقرة. */
  href: string;
  /** ملف + سطر التسمية — يجعل التحقّق ممكنماً لمن يفتح المستودع. */
  source: string;
  /** ما تعنيه هذه الشاشة لصاحب هذا النشاط — جملة واحدة بلا مبالغة. */
  whatAr: string;
};

export type Industry = {
  slug: string;
  icon: string;
  labelAr: string;
  labelEn: string;
  /** الوحدة (أو المجموعة) في تطبيق العمل، بتسميتها الحرفية ومصدرها. */
  module: { label: string; source: string };
  summaryAr: string;
  /** يومٌ من العمل كما هو — ثلاث نقاطٍ يعرفها من عمل في هذا النشاط. */
  pictureAr: string[];
  screens: IndustryScreen[];
  /** كيف تنتهي الدورة: من الشاشة الأولى إلى الفاتورة الإلكترونية. */
  loopAr: string[];
};

export const industries: readonly Industry[] = [
  {
    slug: 'tailoring',
    icon: '🧵',
    labelAr: 'التفصيل',
    labelEn: 'Tailoring',
    module: { label: 'التفصيل', source: 'apps/staff/lib/navigation.ts#tailoring' },
    summaryAr:
      'الورشة التي تُقاس فيها الأجساد مرّةً وتُطلب الثياب مرّةً بعد مرّة: القياس محفوظٌ على العميل، والخيارات مسعَّرة، والفاتورة إلكترونية.',
    pictureAr: [
      'عميلٌ يقيس عندك أوّل مرّة، ثم يعود بعد سنة ويُطلب منه أن يُعاد القياس — فيذهب إلى ورشةٍ تحفظه.',
      '«كم سعر ياقةٍ مطرّزة؟» سؤالٌ يُجاب من الذاكرة، فيختلف السعر باختلاف من أجاب.',
      'الطلبات تُتابع في دفتر، ومن نسي تسليماً نسيَ موعده.',
    ],
    screens: [
      {
        label: 'إدارة طلبات التفصيل',
        href: '/tailoring/orders',
        source: 'apps/staff/lib/navigation.ts#tailoring-order',
        whatAr: 'الطلب بعميله وقياساته وخياراته وموعد تسليمه في شاشةٍ واحدة.',
      },
      {
        label: 'قياسات العملاء',
        href: '/tailoring/measurements',
        source: 'apps/staff/lib/navigation.ts#tailoring-measurement',
        whatAr: 'القياس يُحفظ على العميل لا على الطلب، فيُعاد استعماله بلا سؤالٍ جديد.',
      },
      {
        label: 'خصائص القياسات',
        href: '/tailoring/measurements/attributes',
        source: 'apps/staff/lib/navigation.ts#tailoring-measurement-attribute',
        whatAr: 'الورشة تُضيف ما تقيسه هي (طول كمّ · محيط صدر · كتف) بلا انتظار مبرمج.',
      },
      {
        label: 'إدارة الخيارات الجاهزة',
        href: '/tailoring/options',
        source: 'apps/staff/lib/navigation.ts#tailoring-options',
        whatAr: 'كل خيارٍ بمجموعته وسعره، فيُسعَّر الطلب من الكتالوج لا من الذاكرة.',
      },
      {
        label: 'أنواع التفصيل',
        href: '/tailoring/types',
        source: 'apps/staff/lib/navigation.ts#tailoring-type',
        whatAr: 'ثوبٌ · بشت · عباية — لكلٍّ نوعُه وقوالبه، والتقرير يفصل بينها.',
      },
      {
        label: 'فواتير التفصيل',
        href: '/tailoring/invoices',
        source: 'apps/staff/lib/navigation.ts#tailoring-invoice',
        whatAr: 'الفاتورة تصدر من الطلب نفسه بترميزٍ ضريبيّ صحيح، لا في دفترٍ آخر.',
      },
    ],
    loopAr: [
      'عميلٌ جديد ⇒ بطاقةُ قياساتٍ تُحفظ مرّةً واحدة.',
      'طلبُ تفصيل من كتالوج الخيارات بأسعاره وموعد تسليمه.',
      'فاتورةٌ إلكترونية من الطلب نفسه، والتحصيل يُخصم من رصيده.',
    ],
  },
  {
    slug: 'optics',
    icon: '👓',
    labelAr: 'النظارات',
    labelEn: 'Optics',
    module: { label: 'النظارات', source: 'apps/staff/lib/navigation.ts#optics' },
    summaryAr:
      'بصرياتٌ تُصدر وصفةً بقياساتها لكل عين، فتبيع النظارة اليوم وتفتح الزيارة القادمة على بيانات العميل نفسها.',
    pictureAr: [
      'الوصفة تُكتب على ورقة: كرةٌ وأسطوانةٌ ومحورٌ ومسافةُ بؤبؤ — وورقةٌ بعد سنةٍ لا تُقرأ.',
      'الحقل الذي يقرؤه الموظّف ليس هو الاسم الذي تعرفه الدكّان، فيُترجم ذهنياً في كل فحص.',
      'العميل يسأل: «ما الذي لبسته آخر مرّة؟» ولا أحد يعرف.',
    ],
    screens: [
      {
        label: 'بيانات النظارات',
        href: '/optics/prescriptions',
        source: 'apps/staff/lib/navigation.ts#optics-prescription',
        whatAr: 'الوصفة بحقولها لكل عين، مربوطةً بالعميل لا بالفاتورة — فتُقرأ بعد سنة.',
      },
      {
        label: 'أسماء الحقول',
        href: '/optics/field-labels',
        source: 'apps/staff/lib/navigation.ts#optics-field-label',
        whatAr: 'التسمية التي تُكتب على الشاشة هي ما يقوله الموظّف للعميل، فتُعرَّب وتُضبط.',
      },
    ],
    loopAr: [
      'فحصٌ يُقيَّد في بطاقة العميل بحقولٍ يعرّفها الدكّان بنفسه.',
      'فاتورةٌ إلكترونية للطلب، والمخزون يُخصم من مستودع الفرع.',
      'الزيارة التالية تُفتح على الوصفة القديمة بتاريخها.',
    ],
  },
  {
    slug: 'marina',
    icon: '⛵',
    labelAr: 'إدارة المراسي',
    labelEn: 'Marina',
    module: { label: 'إدارة المراسي', source: 'apps/staff/lib/navigation.ts#marina' },
    summaryAr:
      'المرسى الذي يؤجّر مكانه بالعقد والفترة لا بالنقاش: إشغالٌ يُرى، وفواتيرُ تأجيرٍ تصدر من الحجز، ومخالفاتٌ تُقيَّد على المركب وصاحبه.',
    pictureAr: [
      'من في أي مرسى؟ ومتى ينتهي عقده؟ سؤالان يُجابان من لوحٍ على الحائط.',
      'مركبٌ وصل ولم يُحضَّر، لأن التحضير قائمةٌ في رأس المشرف لا في النظام.',
      'تأخّرُ مغادرةٍ لا يُقيَّد، فيتحوّل حقُّ المرسى إلى خصامٍ عند التجديد.',
    ],
    screens: [
      {
        label: 'بطاقة الفئة وفترات التأجير',
        href: '/marina/groups',
        source: 'apps/staff/lib/navigation.ts#marina-group',
        whatAr: 'الفئة وفترة التأجير هما سعرُ الإيجار وقاعدته — يُعرَّفان مرّةً ويُطبَّقان.',
      },
      {
        label: 'بطاقات النماذج والمراكب والملاك',
        href: '/marina/vessels',
        source: 'apps/staff/lib/navigation.ts#marina-vessel',
        whatAr: 'المركب ومالكه ونموذجه في بطاقةٍ واحدة، ومنها يُبنى العقد.',
      },
      {
        label: 'الحجوزات',
        href: '/marina/bookings',
        source: 'apps/staff/lib/navigation.ts#marina-bookings',
        whatAr: 'الحجز يقفل المرسى لفترته، ومنه تصدر فاتورة التأجير بلا إعادة كتابة.',
      },
      {
        label: 'الإضافات',
        href: '/marina/additions',
        source: 'apps/staff/lib/navigation.ts#marina-additions',
        whatAr: 'خدماتُ الحجز (كهرباء · ماء · تنظيف) بأسعارها، فتُضاف للفاتورة لا للحساب الشفهي.',
      },
      {
        label: 'تحضير المراكب',
        href: '/marina/preparation',
        source: 'apps/staff/lib/navigation.ts#marina-prep',
        whatAr: 'ما يجب أن يكون جاهزاً قبل الوصول: قائمةٌ تُنفَّذ لا تُتذكَّر.',
      },
      {
        label: 'المخالفات',
        href: '/marina/violations',
        source: 'apps/staff/lib/navigation.ts#marina-violations',
        whatAr: 'المخالفة تُقيَّد على المركب وعقدِه، فتظهر في حساب مالكه لا في نقاشٍ شفهي.',
      },
      {
        label: 'خطة الدور',
        href: '/marina/rota',
        source: 'apps/staff/lib/navigation.ts#marina-rota',
        whatAr: 'دورُ التشغيل بين المراكب مكتوبٌ لا محفوظ.',
      },
      {
        label: 'إغلاق اليومية',
        href: '/marina/day-close',
        source: 'apps/staff/lib/navigation.ts#marina-day-close',
        whatAr: 'مقبوضات اليوم تُقفل في خطوةٍ واحدة، ومعها الورديات.',
      },
      {
        label: 'إغلاقات اليومية',
        href: '/reports/cashier-shift',
        source: 'apps/staff/lib/navigation.ts#marina-day-closes',
        whatAr: 'أثرُ كل إغلاق يبقى للمراجعة، ولا يُصحَّح بعد الصرف.',
      },
      {
        label: 'تقرير فواتير التأجير',
        href: '/reports/marina-rentals',
        source: 'apps/staff/lib/navigation.ts#marina-rental-invoices',
        whatAr: 'ما أُجّر وما حُصّل وما بقي — في تقريرٍ من البيانات نفسها لا من دفتر جانبي.',
      },
    ],
    loopAr: [
      'فئةٌ وفترةُ تأجير ⇒ عقدٌ على مرسى ⇒ حجزٌ يقفل المكان.',
      'تحضيرٌ ومخالفاتٌ وإضافاتٌ تُقيَّد على المركب لا في ذاكرة المشرف.',
      'فاتورةُ تأجيرٍ من الحجز، ثم إغلاقُ يوميةٍ بأرصدتها.',
    ],
  },
  {
    slug: 'contracting',
    icon: '🏗️',
    labelAr: 'المقاولات',
    labelEn: 'Contracting',
    module: { label: 'إدارة المشاريع', source: 'apps/staff/lib/navigation.ts#projects' },
    summaryAr:
      'مقاولٌ يعرف ربح كل مشروع أثناء المشروع لا بعده: عرضٌ من البنود، وعقد، وعقدُ مقاولٍ من الباطن، ومستخلصُ إنجاز.',
    pictureAr: [
      'المشتريات والرواتب والسلف تُقيَّد في أماكن متفرّقة، والربحُ يُحسب في ورقةٍ بعد التسليم.',
      'مقاول الباطن يستلم دفعةً، فلا يُعرف كم بقي له إلا بجمع السندات.',
      'بندٌ يُضاف في الموقع ولا يظهر أثره في العقد مرّة واحدة، فيظهر في الخلاف.',
    ],
    screens: [
      {
        label: 'عروض',
        href: '/projects/offers',
        source: 'apps/staff/lib/navigation.ts#project-offers',
        whatAr: 'العرض يُبنى من البنود بأسعارها، فلا يُعاد ترقيم المشروع بعد الفوز.',
      },
      {
        label: 'بطاقة بند',
        href: '/projects/boq',
        source: 'apps/staff/lib/navigation.ts#boq-item',
        whatAr: 'البند بكميته ووحدته وسعره؛ وأثر أي تعديل يُرى قبل أن يصير خلافاً.',
      },
      {
        label: 'مراحل مشروع',
        href: '/projects/stages',
        source: 'apps/staff/lib/navigation.ts#project-stages',
        whatAr: 'المرحلة هي وحدة الإنجاز والتحصيل، فيُقاس التقدّم بمراحل لا بانطباع.',
      },
      {
        label: 'عقد عميل',
        href: '/projects',
        source: 'apps/staff/lib/navigation.ts#customer-contract',
        whatAr: 'قيمةُ العقد وبنوده ومنه تُصدر المستخلصات والفواتير.',
      },
      {
        label: 'عقد مقاول',
        href: '/projects/contractor-contract',
        source: 'apps/staff/lib/navigation.ts#contractor-contract',
        whatAr: 'التعاقد من الباطن يبقى مربوطاً بالعقد الأصلي، فيُعرف ربح كلٍّ منهما.',
      },
      {
        label: 'سند دفع لمقاول',
        href: '/projects/contractor-payment',
        source: 'apps/staff/lib/navigation.ts#contractor-payment',
        whatAr: 'الدفعة تُقيَّد على المقاول وتُنقص مستحقاته في الحساب نفسه.',
      },
      {
        label: 'متابعة',
        href: '/projects/followup',
        source: 'apps/staff/lib/navigation.ts#project-followup',
        whatAr: 'نسبة الإنجاز والمصروف مقابل قيمة العقد — صورةُ المشروع في سطر.',
      },
    ],
    loopAr: [
      'عرضٌ من بنود (BOQ) ⇒ عقدُ عميلٍ عند الفوز ⇒ مراحلُ إنجاز.',
      'مشترياتٌ ورواتبُ وعقودُ باطنٍ تُقيَّد على المشروع.',
      'مستخلصُ إنجازٍ ⇒ فاتورةٌ إلكترونية ⇒ ربحٌ يظهر أثناء المشروع لا في ورقةٍ بعده.',
    ],
  },
  {
    slug: 'salla',
    icon: '🛍️',
    labelAr: 'متجر سلة',
    labelEn: 'Salla',
    // وهي **تكاملٌ لا وحدة رأسية**، وهذا ما تقوله الصفحة بصراحة: مجموعتُها في شجرة الموظّفين
    // تسكن «المستودعات» (`inventory-salla`)، وشاشةُ إعداداتها في «الإعدادات». فالتسمية حرفية
    // والموضع مذكور — لا يُنسب إلى المخزون ما ليس منه ولا العكس.
    module: { label: 'متجر سلة', source: 'apps/staff/lib/navigation.ts#inventory-salla' },
    summaryAr:
      'متجرُ سلة مربوطٌ بالمخزون: الطلب ينزل من المتجر، ويُخصم الصنف من مستودعه، وتُصدر فاتورته الإلكترونية من الطلب نفسه.',
    pictureAr: [
      'يبيع المتجر صنفاً نفد من المستودع، أو يُخصم مرّتين — والرصيد في مكانين.',
      'معرّفُ المنتج في سلة ليس صنفك، وبدون ربطٍ يبقى الاسم نصّاً حرّاً يُقرأ بلا معنى.',
      'كل طلبٍ يُنقل إلى النظام بكتابةٍ يدوية، والخطأ هنا أكثرُ خطأٍ يتكرّر.',
    ],
    screens: [
      {
        label: 'المنتجات',
        href: '/integrations/salla/products',
        source: 'apps/staff/lib/navigation.ts#salla-products',
        whatAr: 'منتجات المتجر مربوطةٌ بأصناف المستودع، فالسعر والرصيد من نظامٍ واحد.',
      },
      {
        label: 'إدارة الطلبات',
        href: '/integrations/salla/orders',
        source: 'apps/staff/lib/navigation.ts#salla-orders',
        whatAr: 'الطلب ينزل بحالته، ويُستكمل إلى فاتورةٍ إلكترونية بلا إعادة كتابة.',
      },
      {
        label: 'ربط المستودعات',
        href: '/integrations/salla/warehouses',
        source: 'apps/staff/lib/navigation.ts#salla-warehouses',
        whatAr: 'مستودعُ البيع في المتجر = مستودعٌ عندك، فالخصم من المكان الصحيح.',
      },
      {
        label: 'إعدادات ربط سلة',
        href: '/integrations/salla/settings',
        // أُزيح السطر من 1738 إلى 1752 بعد إضافة شاشات الإعدادات؛ والسبيك يفتح
        // الملف عند السطر المكتوب، فيبقى هذا المصدر قابلاً للتحقق عند تغيير القائمة.
        source: 'apps/staff/lib/navigation.ts#salla-settings',
        whatAr: 'الربط ورمزه ومفتاحه في شاشة إعدادات، والسرّ مشفَّرٌ عند التخزين لا نصّاً ظاهراً.',
      },
    ],
    loopAr: [
      'ربطُ المتجر بمفتاحه وربطُ مستودعه.',
      'الطلب ينزل ⇒ يُخصم الصنف من المستودع الصحيح.',
      'فاتورةٌ إلكترونية من الطلب نفسه، والرصيد يبقى واحداً في المكانين.',
    ],
  },
  // ─────────────────────────────────────────────────────────────────────────────
  // M7 — حزم المنتج المتخصص الأربع (خارطة الطريق M7). القاعدة نفسها: لا وعود ولا
  // أرقام، وكل سطرٍ له شاشةٌ تعمل. شاشات الجملة والتصنيع وتواريخ الصلاحية من شجرة
  // الموظّفين (`navigation.ts`)؛ وشاشات المصنع والمناديب يسكبها `app-shell.tsx` عند
  // تفعيل إضافة السوق — فمصدرُها هناك، والمصدر يُفتح ويتحقّق كما يُفتح `navigation.ts`.
  // ─────────────────────────────────────────────────────────────────────────────
  {
    slug: 'wholesale',
    icon: '🏬',
    labelAr: 'الجملة والتوزيع',
    labelEn: 'Wholesale & Distribution',
    module: { label: 'المبيعات', source: 'apps/staff/lib/navigation.ts#sales' },
    summaryAr:
      'تاجرُ جملةٍ يبيع لعملاء يعرفهم بالاسم والسعر: لكل عميلٍ قائمته، والفاتورة تخرج بأسعاره هو، وكشفُ حسابه يفصل ما سُعّر عمّا سُدّد.',
    pictureAr: [
      '«كم سعر الكرتونة لأبي فهد؟» — سؤالٌ يُجاب من الذاكرة، فيختلف السعر باختلاف من ردّ.',
      'العميل يجمع ويؤجّل، والرصيد الحقيقي يظهر عند التسديد لا عند الفاتورة.',
      'نهاية الشهر: من سدّد ومن تأخّر يُجمع من الدفاتر، والمرتجع يُنسيه المندوب.',
    ],
    screens: [
      {
        label: 'فاتورة مبيعات',
        href: '/sales/invoices',
        source: 'apps/staff/lib/navigation.ts#sales-invoice',
        whatAr: 'فاتورةٌ تخرج بأسعار قائمة العميل لا بأسعار الخاطر، وتُصدر إلكترونيةً من الشاشة نفسها.',
      },
      {
        label: 'بطاقة عميل',
        href: '/sales/customers',
        source: 'apps/staff/lib/navigation.ts#customer-card',
        whatAr: 'العميل بقائمته وحده وأرصدته وحدود ائتمانه — بطاقةٌ واحدة لا دفتراً لكل مندوب.',
      },
      {
        label: 'إعدادات الأسعار',
        href: '/settings/price-lists',
        source: 'apps/staff/lib/navigation.ts#sync-prices',
        whatAr: 'قوائم الأسعار تُضبط مرةً وتُثبَّت، فسعرُ الكرتونة قرارُ النظام لا مزاجَ من أجاب الهاتف.',
      },
      {
        label: 'كشف عميل',
        href: '/sales/statements',
        source: 'apps/staff/lib/navigation.ts#customer-statement',
        whatAr: 'الفواتير والسدادات والمرتجعات في كشفٍ واحد يُطبع ويُرسل — وهو الذي يفصل النزاع.',
      },
      {
        label: 'مردود المبيعات',
        href: '/sales/returns',
        source: 'apps/staff/lib/navigation.ts#sales-return',
        whatAr: 'المرتجع يعود للمستودع ويُقيَّد على العميل بالفاتورة الأصلية، فلا يضيع في الطريق.',
      },
    ],
    loopAr: [
      'قائمةُ أسعارٍ لكل عميل تُثبَّت في الإعدادات.',
      'فاتورةٌ بأسعار قائمته ⇒ تحصيلٌ أو أجلٌ يظهر رصيده في الحال.',
      'مرتجعٌ بمساره الصحيح ⇒ كشفُ حسابٍ يُطبع ويُغلق النزاع بلا حسابٍ يدوي.',
    ],
  },
  {
    slug: 'manufacturing',
    icon: '⚙️',
    labelAr: 'التصنيع',
    labelEn: 'Manufacturing',
    module: { label: 'التصنيع', source: 'apps/staff/lib/navigation.ts#manufacturing' },
    summaryAr:
      'مصنعٌ يعرف تكلفة ما ينتجه وهو ينتجه: أمرُ تصنيعٍ من قائمة مواد، والاستهلاك الفعلي وتكلفته يُرحَّلان إلى القيود، لا إلى ورقةٍ تُنسخ.',
    pictureAr: [
      'قائمةُ المواد في ورقةٍ تختلف عمّا صُرف فعلاً على الأرض، والفاقد لا يعرف له أحدٌ حساباً.',
      'تكلفةُ الدفعة تظهر بعد شهرٍ من إنتاجها، فتُسعَّر الدفعةُ التالية بالتخمين.',
      'نصفُ المصنوع واقفٌ في الصالة، وليس له رصيدٌ في أيّ دفتر.',
    ],
    screens: [
      {
        label: 'قوائم المواد',
        href: '/manufacturing/boms',
        source: 'apps/staff/lib/navigation.ts#manufacturing-boms',
        whatAr: 'قائمةُ المواد هي وصفةُ الصنف: ما يدخل فيه وبأي كمية — فالأمر يُبنى عليها لا على الورقة.',
      },
      {
        label: 'أوامر التصنيع',
        href: '/manufacturing/orders',
        source: 'apps/staff/lib/navigation.ts#manufacturing-orders',
        whatAr: 'أمرُ التصنيع يصرفُ مكوّناته ويُنجز منتجه، وكل خطوةٍ لها قيدها في المخزون.',
      },
      {
        label: 'تقرير أمر الإنتاج',
        href: '/inventory/production',
        source: 'apps/staff/lib/navigation.ts#production-order',
        whatAr: 'تقريرُ الأمر: ما صُرف وما أُنتج وما فُقد — بالأرقام لا بالذاكرة.',
      },
    ],
    loopAr: [
      'قائمةُ موادٍ تُعرَّف مرةً لكل صنف.',
      'أمرُ تصنيعٍ يصرف المكونات ⇒ الإنتاج تحت التشغيل ⇒ الإنجاز يُرحّل المنتج بتكلفته الفعلية.',
      'تقريرُ الأمر بالفاقد والتكلفة، والقيودُ مكتوبةٌ في اليومية لا في ورقة.',
    ],
  },
  {
    slug: 'food-factory',
    icon: '🏭',
    labelAr: 'مصنع الأغذية',
    labelEn: 'Food Factory',
    module: {
      label: 'نظام المصنع والمخابز ومناديب التوزيع',
      source: 'apps/staff/components/app-shell.tsx#van-sales',
    },
    summaryAr:
      'مصنعُ أغذيةٍ يوازن بين تاريخِ صلاحيةٍ يقترب ومناديبَ توزيعٍ تنتظر: إنتاجٌ يومي من المستودع الرئيسي، ودفاتٌ بتواريخها، وفاتورةٌ تُصدر من الطريق.',
    pictureAr: [
      'الدفعةُ التي قاربت انتهاء الصلاحية تُكتشف بعد أن بيعت، لا قبل.',
      'إنتاجُ اليوم يُوزَّع غداً، وما تبقّى في المستودع لا يُعرف إلا بجردٍ يطول.',
      'المندوبُ يبيع ويسلّم ويسدّد، والتسوية تنتظر المحاسب أياماً في أوراقٍ متفرّقة.',
    ],
    screens: [
      {
        label: 'الإنتاج اليومي للمصنع والمستودع الرئيسي',
        href: '/van-sales?tab=production',
        source: 'apps/staff/components/app-shell.tsx#van-production',
        whatAr: 'إنتاجُ اليوم يُسجَّل دفعةً بدفعته، فيُعرف ما دخل المستودع وما خرج للتوزيع.',
      },
      {
        label: 'تواريخ الصلاحية',
        href: '/inventory/expiry',
        source: 'apps/staff/lib/navigation.ts#expiry',
        whatAr: 'الأصنافُ بتواريخ انتهائها مرتّبة، فالذي يقترب أجله يُصرَّف قبل الذي بقى له.',
      },
      {
        label: 'صلاحية المواد (الدفعات)',
        href: '/inventory/lots',
        source: 'apps/staff/lib/navigation.ts#lots',
        whatAr: 'كلُّ دفعةٍ بتاريخها ورصيدها، فالبضاعةُ القديمة تُباع ببونصٍ مضبوط لا تُرمى.',
      },
      {
        label: 'فواتير التوزيع (ضريبية ZATCA / عادية) والتحصيل',
        href: '/van-sales?tab=invoice',
        source: 'apps/staff/components/app-shell.tsx#van-invoicing',
        whatAr: 'فاتورةُ التوزيع تُصدر من الطريق ضريبيةً أو عادية، والتحصيل يُقيَّد في حينه.',
      },
    ],
    loopAr: [
      'إنتاجٌ يوميّ يُسجَّل من المستودع الرئيسي.',
      'عهدةُ المناديب ببونصٍ مضبوط ⇒ بيعٌ من الطريق بفاتورةٍ ضريبية.',
      'تواريخُ الصلاحية ترتّب ما يُصرَّف أولاً، وتسويةُ الوردية تنتهي باعتماد المحاسب.',
    ],
  },
  {
    slug: 'van-sales',
    icon: '🚚',
    labelAr: 'البيع المتجول',
    labelEn: 'Van Sales',
    module: {
      label: 'نظام المصنع والمخابز ومناديب التوزيع',
      source: 'apps/staff/components/app-shell.tsx#van-sales',
    },
    summaryAr:
      'مندوبٌ يخرج بسيارةٍ محمّلة وسعرٍ مثبَّت لكل عميل، ويبيع من هاتفه ولو بلا شبكة، ويسوّي عهدته في نهاية اليوم بعدّة لا بذاكرته.',
    pictureAr: [
      'الشبكةُ تقطع في الطريق، فتُرجئ الفواتير إلى الغد — ويُرجئ المندوبُ معها تحصيله.',
      'البونصُ المجاني يُعطى بالمزاج، فيأكل هامشَ الطريق ولا يعرف عنه المالك شيئاً.',
      'عهدةُ السيارة تُعدُّ بورقةٍ في نهاية الوردية، وغالباً ما تختلف عن دفتر الحسابات.',
    ],
    screens: [
      {
        label: 'ضبط وتثبيت أسعار العملاء والائتمان والبونص',
        href: '/van-sales?tab=prices',
        source: 'apps/staff/components/app-shell.tsx#van-customer-tiers',
        whatAr: 'سعرُ كل عميلٍ وحدُّ ائتمانه وبونصه المسموح — تُضبط مرةً ولا تُترك للمندوب.',
      },
      {
        label: 'عهد المناديب وإغلاق الوردية واعتماد المحاسب',
        href: '/van-sales?tab=loads',
        source: 'apps/staff/components/app-shell.tsx#van-loads',
        whatAr: 'تحميلُ السيارة وإغلاقُ الوردية بالعدّ الفعلي، والفرقُ يمرّ باعتماد المحاسب لا بصمت.',
      },
      {
        label: 'فواتير التوزيع (ضريبية ZATCA / عادية) والتحصيل',
        href: '/van-sales?tab=invoice',
        source: 'apps/staff/components/app-shell.tsx#van-invoicing',
        whatAr: 'الفاتورةُ من الطريق بأسعار العميل المثبّتة، والتحصيلُ يقفل رصيده في الحال.',
      },
      {
        label: 'رادار البونص وسجل حركة البضاعة والصلاحيات',
        href: '/van-sales?tab=audit',
        source: 'apps/staff/components/app-shell.tsx#van-audit-radar',
        whatAr: 'من أعطى بونصاً فوق حدّه، ومن حرّك بضاعةً بغير إذن — سجلٌ يُفتح لا شكوى تُروى.',
      },
      {
        label: 'لوحة تحكم صاحب المصنع وتقارير الربحية',
        href: '/van-sales?tab=owner',
        source: 'apps/staff/components/app-shell.tsx#van-owner-dashboard',
        whatAr: 'ربحُ كل سيارةٍ وكل مندوبٍ وكل صنفٍ في لوحةٍ واحدة — قرارُ التوسيع بالأرقام لا بالانطباع.',
      },
    ],
    loopAr: [
      'تحميلُ السيارة من المستودع بأسعارٍ وبونصٍ مثبَّتين.',
      'المندوبُ يبيع من هاتفه — ولو بلا شبكة — ثم يُزامن ويُحصّل.',
      'إغلاقُ الوردية بعدّ الفعلي ⇒ الفرقُ باعتماد المحاسب ⇒ ربحُ الطريق في لوحة المالك.',
    ],
  },
];

export const INDUSTRIES_PATH = '/industries';

/** أسماء القطاعات — تُستعمل في `generateStaticParams` وخريطة الموقع، فلا يُكتب مسارٌ بيد. */
export const industrySlugs: readonly string[] = industries.map((industry) => industry.slug);

export const industryPath = (slug: string): string => `${INDUSTRIES_PATH}/${slug}`;

export function industryBySlug(slug: string): Industry | undefined {
  return industries.find((industry) => industry.slug === slug);
}
