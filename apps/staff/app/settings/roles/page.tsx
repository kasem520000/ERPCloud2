'use client';

import { useEffect, useMemo, useState } from 'react';

import { Notice, QueryView } from '../../../components/data-view';
import { Forbidden, Screen } from '../../../components/screen';
import { ApiError, apiList, apiPost, apiPut } from '../../../lib/api';
import { useSession } from '../../../lib/session';
import { useQuery } from '../../../lib/use-query';

type Role = {
  id: string;
  name: string;
  description?: string | null;
  isSystem?: boolean;
  permissionCodes?: string[];
  permissions?: string[];
};

type Permission = {
  code: string;
  name?: string;
  module?: string;
  description?: string;
};

const ROLE_NAME_AR: Record<string, string> = {
  Owner: 'مالك الحساب (Owner)',
  Accountant: 'محاسب (Accountant)',
  Cashier: 'أمين صندوق / كاشير (Cashier)',
};

const MODULE_LABELS_AR: Record<string, string> = {
  tenant: 'إدارة المنشأة والمستخدمين والأدوار',
  org: 'الهيكل التنظيمي والفروع والأصناف',
  accounting: 'المحاسبة العامة والقيود المالية',
  parties: 'العملاء والموردون',
  sales: 'المبيعات وعروض الأسعار ونقاط البيع',
  purchases: 'المشتريات وأوامر الشراء',
  treasury: 'الخزينة والصناديق والبنوك والسندات',
  hrm: 'الموارد البشرية والرواتب والحضور',
  projects: 'المشاريع والمقاولات والعقود',
  niche: 'القطاعات المتخصصة (التفصيل، النظارات، المرسى)',
  reporting: 'التقارير المالية والتشغيلية',
  einvoicing: 'الفوترة الإلكترونية (ZATCA)',
  pos: 'نقاط البيع غير المتصلة (Offline POS)',
  ocr: 'المسح الضوئي الذكي للفواتير (OCR)',
  employee: 'بوابة الخدمة الذاتية للموظف',
  ai: 'المساعد المحاسبي الذكي (AI)',
  marketplace: 'سوق التطبيقات والربط السحابي',
  migration: 'استيراد البيانات وأدوات الترحيل',
  compat: 'ربط الأجهزة الطرفية والمزامنة',
};

const PERMISSION_LABELS_AR: Record<string, { title: string; detail: string }> = {
  'tenant.view': { title: 'عرض بيانات المنشأة', detail: 'الاطلاع على بيانات المنشأة والاشتراك والاستهلاك' },
  'tenant.manage': { title: 'تعديل إعدادات المنشأة', detail: 'تحديث الهوية والملف الضريبي والإعدادات العامة' },
  'tenant.user.invite': { title: 'دعوة وإضافة مستخدمين', detail: 'إرسال دعوات وإنشاء حسابات لمستخدمي المنشأة' },
  'tenant.user.manage': { title: 'إدارة المستخدمين والعضويات', detail: 'تفعيل أو إيقاف المستخدمين وتعديل بياناتهم وحدود الخصم' },
  'tenant.role.manage': { title: 'إدارة الأدوار والصلاحيات', detail: 'إنشاء الأدوار المخصصة وتعيين الصلاحيات ونطاقات الفروع' },
  'tenant.settings.view': { title: 'عرض إعدادات النظام', detail: 'الاطلاع على تفضيلات وإعدادات المنشأة' },
  'tenant.settings.manage': { title: 'تعديل إعدادات النظام', detail: 'تغيير الخيارات المتقدمة والربط والترقيم' },
  'tenant.audit.view': { title: 'عرض سجل التدقيق والمراجعة', detail: 'الاطلاع على سجل العمليات والتعديلات الأمنية والمحاسبية' },
  'tenant.file.upload': { title: 'رفع وإدارة الملفات والمرفقات', detail: 'رفع الوثائق والمرفقات وحذفها في مدير الملفات' },
  'tenant.notification.view': { title: 'عرض الإشعارات والتنبيهات', detail: 'قراءة مركز الإشعارات والتنبيهات التشغيلية' },
  'tenant.email.log.view': { title: 'عرض سجل البريد الإلكتروني', detail: 'الاطلاع على الرسائل المرسلة وحالتها' },
  'tenant.email.template.manage': { title: 'إدارة إعدادات وقوالب البريد', detail: 'تعديل قوالب الرسائل وإعدادات مزود البريد (Resend / SMTP)' },
  'tenant.backup.manage': { title: 'إدارة النسخ الاحتياطي', detail: 'إنشاء وتنزيل النسخ الاحتياطية لبيانات المنشأة' },
  'tenant.webhook.manage': { title: 'إدارة مفاتيح API والـ Webhooks', detail: 'إنشاء مفاتيح الربط البرمجي وعناوين الإشعارات الفورية' },
  'org.branch.view': { title: 'عرض الفروع والمستودعات', detail: 'الاطلاع على قائمة الفروع والمستودعات والصناديق' },
  'org.branch.manage': { title: 'إدارة الفروع والمستودعات والصناديق', detail: 'إضافة وتعديل الفروع والمستودعات وأماكن النقد' },
  'org.catalog.view': { title: 'عرض دليل الأصناف والوحدات والضرائب', detail: 'الاطلاع على الأصناف والمجموعات والوحدات وقوائم الأسعار' },
  'org.catalog.manage': { title: 'إدارة الأصناف والوحدات والضرائب', detail: 'إضافة وتعديل الأصناف والباركود ومجموعات الضريبة والأسعار' },
  'org.inventory.view': { title: 'عرض المخزون وحركات المستودع', detail: 'الاطلاع على أرصدة المخزون وبطاقات الأصناف' },
  'org.inventory.adjust': { title: 'تسوية وجرد المخزون والمناقلات', detail: 'إجراء التسويات المخزنية والجرد والتحويل بين المستودعات' },
  'accounting.account.view': { title: 'عرض شجرة الحسابات ومراكز التكلفة', detail: 'الاطلاع على دليل الحسابات والسنوات المالية' },
  'accounting.account.manage': { title: 'إدارة شجرة الحسابات ومراكز التكلفة', detail: 'إضافة وتعديل الحسابات ومراكز التكلفة وملفات الترحيل' },
  'accounting.journal.view': { title: 'عرض قيود اليومية والأستاذ العام', detail: 'الاطلاع على قيود اليومية وحركة الحسابات' },
  'accounting.journal.draft': { title: 'إنشاء وتعديل مسودات القيود', detail: 'إدخال قيود اليومية كمسودات قبل الترحيل' },
  'accounting.journal.post': { title: 'ترحيل قيود اليومية', detail: 'اعتماد وترحيل قيود اليومية إلى الأستاذ العام' },
  'accounting.journal.reverse': { title: 'عكس وإلغاء قيود اليومية', detail: 'إنشاء قيود عكسية للقيود المرحّلة' },
  'accounting.period.close': { title: 'إقفال الفترات والسنوات المالية', detail: 'إغلاق الفترات المحاسبية ومنع الترحيل إليها' },
  'accounting.period.reopen': { title: 'إعادة فتح الفترات المالية', detail: 'فتح فترة محاسبية مقفلة للتعديل بإذن خاص' },
  'parties.view': { title: 'عرض العملاء والموردين', detail: 'الاطلاع على بطاقات العملاء والموردين وكشوف حساباتهم' },
  'parties.manage': { title: 'إدارة العملاء والموردين', detail: 'إضافة وتعديل وحذف العملاء والموردين وطرق الدفع' },
  'parties.allocate': { title: 'تخصيص وتسوية الدفعات', detail: 'ربط سندات القبض والصرف بالفواتير المستحقة' },
  'sales.view': { title: 'عرض المبيعات والفواتير', detail: 'الاطلاع على فواتير المبيعات وعروض الأسعار والمرتجعات' },
  'sales.draft': { title: 'إنشاء مسودات فواتير المبيعات وعروض الأسعار', detail: 'إدخال فواتير المبيعات وعروض الأسعار كمسودات' },
  'sales.post': { title: 'اعتماد وترحيل فواتير المبيعات', detail: 'إصدار وترحيل فواتير المبيعات وتأثيرها المالي والمخزني' },
  'sales.return': { title: 'إصدار مرتجعات المبيعات والإشعارات الدائنة', detail: 'إنشاء واعتماد مرتجعات المبيعات والإشعارات الضريبية' },
  'sales.pos': { title: 'البيع عبر شاشة الكاشير (POS)', detail: 'إجراء عمليات البيع المباشر وإدارة الورديات في نقطة البيع' },
  'purchases.view': { title: 'عرض المشتريات والفواتير', detail: 'الاطلاع على فواتير المشتريات وأوامر الشراء والمرتجعات' },
  'purchases.draft': { title: 'إنشاء مسودات فواتير وأوامر الشراء', detail: 'إدخال فواتير المشتريات وطلبات الشراء كمسودات' },
  'purchases.post': { title: 'اعتماد وترحيل فواتير المشتريات', detail: 'ترحيل فواتير المشتريات وإثبات المخزون والذمم الدائنة' },
  'purchases.return': { title: 'إصدار مرتجعات المشتريات', detail: 'إنشاء واعتماد مرتجعات المشتريات والإشعارات المدينة' },
  'treasury.view': { title: 'عرض الخزينة والسندات المالية', detail: 'الاطلاع على سندات القبض والصرف وأرصدة الصناديق' },
  'treasury.voucher.draft': { title: 'إنشاء مسودات سندات القبض والصرف', detail: 'إدخال سندات القبض والصرف كمسودات' },
  'treasury.voucher.post': { title: 'ترحيل سندات القبض والصرف والمناقلات', detail: 'اعتماد السندات المالية وإغلاق اليومية والتحويل بين الخزن' },
  'treasury.bank.view': { title: 'عرض الحسابات البنكية وكشوف الحساب', detail: 'الاطلاع على الحسابات البنكية والتسويات' },
  'treasury.bank.reconcile': { title: 'إجراء التسوية البنكية', detail: 'مطابقة كشوف الحساب البنكية مع القيود المحاسبية' },
  'hrm.view': { title: 'عرض شؤون الموظفين والحضور', detail: 'الاطلاع على بيانات الموظفين والأقسام والحضور والإجازات' },
  'hrm.manage': { title: 'إدارة الموظفين والحضور والإجازات والعقود', detail: 'إضافة وتعديل الموظفين والعقود والحوافز والجزاءات' },
  'hrm.payroll.view': { title: 'عرض مسيرات الرواتب', detail: 'الاطلاع على كشوف ومسيرات الرواتب الشهرية' },
  'hrm.payroll.run': { title: 'إعداد وترحيل وصرف مسيرات الرواتب', detail: 'احتساب الرواتب وترحيلها وصرفها وإصدار ملفات حماية الأجور' },
  'projects.view': { title: 'عرض المشاريع والعقود والمستخلصات', detail: 'الاطلاع على المشاريع ومراحلها وعقود المقاولين' },
  'projects.manage': { title: 'إدارة المشاريع والمقاولات والمستخلصات', detail: 'إنشاء وتعديل المشاريع وجداول الكميات والمستخلصات' },
  'niche.tailoring.manage': { title: 'إدارة طلبات التفصيل والخياطة', detail: 'إدخال المقاسات وطلبات التفصيل ومتابعة حالتها' },
  'niche.optics.manage': { title: 'إدارة فحوصات وطلبات النظارات', detail: 'تسجيل قياسات النظر وطلبات العدسات والنظارات' },
  'niche.marina.manage': { title: 'إدارة عمليات المرسى وتأجير القوارب', detail: 'إدارة القوارب والعقود والحجوزات والمخالفات' },
  'reporting.view': { title: 'عرض جميع التقارير والكشوفات', detail: 'تشغيل واستعراض التقارير المالية والمخزنية والتشغيلية' },
  'reporting.export': { title: 'تصدير وطباعة التقارير', detail: 'تصدير التقارير إلى Excel وPDF وطباعتها' },
  'einvoicing.view': { title: 'عرض حالة الفوترة الإلكترونية (ZATCA)', detail: 'الاطلاع على الفواتير المرسلة لهيئة الزكاة والضريبة' },
  'einvoicing.manage': { title: 'إدارة الربط مع هيئة الزكاة (ZATCA)', detail: 'إعداد شهادات الربط وإرسال الفواتير الإلكترونية' },
  'pos.offline.sync': { title: 'مزامنة نقاط البيع غير المتصلة', detail: 'تحميل الكتالوج ورفع فواتير الكاشير عند عودة الاتصال' },
  'ocr.extract': { title: 'قراءة الفواتير بالمسح الضوئي (OCR)', detail: 'استخراج بيانات فواتير المشتريات تلقائياً من الصور وملفات PDF' },
  'employee.self.view': { title: 'بوابة الموظف: عرض البيانات والقسائم', detail: 'الاطلاع على سجل الحضور وقسائم الراتب الشخصية' },
  'employee.self.punch': { title: 'بوابة الموظف: تسجيل حضور وانصراف', detail: 'تسجيل البصمة الجغرافية للحضور والانصراف' },
  'employee.self.leave': { title: 'بوابة الموظف: تقديم طلب إجازة', detail: 'رفع طلبات الإجازة ومتابعة الموافقة عليها' },
  'ai.use': { title: 'استخدام المساعد المحاسبي الذكي', detail: 'طرح الأسئلة المحاسبية والاستفسار عن البيانات والتنبيهات' },
  'ai.settings.manage': { title: 'إدارة إعدادات الذكاء الاصطناعي (AI API)', detail: 'ضبط مزود الذكاء الاصطناعي ومفتاح الـ API والحدود الشهرية' },
  'marketplace.view': { title: 'عرض سوق التطبيقات والإضافات', detail: 'تصفح الإضافات والتكاملات السحابية المتاحة' },
  'marketplace.manage': { title: 'تفعيل وإدارة تطبيقات المتجر والهوية', detail: 'تثبيت الإضافات السحابية وتخصيص الألوان والشعار' },
  'migration.run': { title: 'تشغيل استيراد وترحيل البيانات', detail: 'استيراد البيانات الأولية ومطابقتها' },
  'compat.devices.manage': { title: 'إدارة الأجهزة الطرفية المتصلة', detail: 'إصدار وإيقاف مفاتيح ربط تطبيقات الجوال والأجهزة' },
};

const ACTION_WORDS_AR: Record<string, string> = {
  view: 'عرض',
  manage: 'إدارة وتعديل',
  draft: 'إنشاء مسودة',
  post: 'اعتماد وترحيل',
  reverse: 'عكس قيد',
  return: 'مرتجع',
  close: 'إقفال',
  reopen: 'إعادة فتح',
  invite: 'دعوة',
  upload: 'رفع ملفات',
  adjust: 'تسوية وجرد',
  allocate: 'تخصيص دفعات',
  reconcile: 'تسوية بنكية',
  run: 'تشغيل',
  export: 'تصدير',
  sync: 'مزامنة',
  extract: 'استخراج ضوئي',
  use: 'استخدام',
  punch: 'تسجيل حضور',
  leave: 'طلب إجازة',
  pos: 'نقطة البيع',
};

function describePermissionAr(permission: Permission): { title: string; detail: string; moduleAr: string } {
  const modKey = permission.module ?? permission.code.split('.')[0] ?? 'other';
  const moduleAr = MODULE_LABELS_AR[modKey] ?? modKey;
  const known = PERMISSION_LABELS_AR[permission.code];
  if (known) {
    return { title: known.title, detail: known.detail, moduleAr };
  }
  const parts = permission.code.split('.');
  const action = parts[parts.length - 1] ?? permission.code;
  const actionAr = ACTION_WORDS_AR[action] ?? action;
  return {
    title: `${actionAr} (${permission.code})`,
    detail: permission.description ?? '',
    moduleAr,
  };
}

export default function RolesPage() {
  const { can, me } = useSession();
  const roles = useQuery<Role[]>(() => apiList<Role>('/roles'), []);
  const permissions = useQuery<Permission[]>(() => apiList<Permission>('/permissions'), []);

  const [selected, setSelected] = useState<Role | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'info'; text: string } | undefined>();

  // Filter out deprecated `platform.*` aliases so each permission appears once in its canonical form.
  const canonicalPermissions = useMemo(
    () =>
      (permissions.data ?? []).filter(
        (permission) => !permission.code.startsWith('platform.') && !permission.code.startsWith('console.'),
      ),
    [permissions.data],
  );

  const grouped = useMemo(() => {
    const groups = new Map<string, Permission[]>();
    const q = searchQuery.trim().toLowerCase();
    for (const permission of canonicalPermissions) {
      const info = describePermissionAr(permission);
      if (
        q &&
        !info.title.toLowerCase().includes(q) &&
        !info.detail.toLowerCase().includes(q) &&
        !info.moduleAr.toLowerCase().includes(q) &&
        !permission.code.toLowerCase().includes(q)
      ) {
        continue;
      }
      const key = permission.module ?? permission.code.split('.')[0] ?? 'other';
      groups.set(key, [...(groups.get(key) ?? []), permission]);
    }
    return [...groups.entries()];
  }, [canonicalPermissions, searchQuery]);

  // Keep `selected` synchronised when roles first load or reload
  useEffect(() => {
    if (!roles.data || roles.data.length === 0) return;
    if (!selected) {
      const first = roles.data[0]!;
      pickRole(first);
      return;
    }
    const updated = roles.data.find((r) => r.id === selected.id);
    if (updated) {
      setSelected(updated);
    }
  }, [roles.data]);

  if (!can('tenant.role.manage')) {
    return (
      <Screen title="الأدوار والصلاحيات" crumbs={['الإعدادات']}>
        <Forbidden />
      </Screen>
    );
  }

  const active = selected ?? roles.data?.[0] ?? null;
  const isOwnerRole = active?.name.trim().toLowerCase() === 'owner';
  const isSystemNonOwner = Boolean(active?.isSystem && !isOwnerRole);
  const canEditActivePermissions = Boolean(
    active && !isOwnerRole && (!active.isSystem || Boolean(me?.membership.isOwner)),
  );

  function pickRole(role: Role) {
    setSelected(role);
    const rawCodes = role.permissionCodes ?? role.permissions ?? [];
    const normalized = rawCodes.map((code) =>
      code.startsWith('platform.') ? `tenant.${code.slice('platform.'.length)}` : code,
    );
    setChecked(new Set(normalized));
    setEditName(role.name);
    setEditDesc(role.description ?? '');
    setNotice(undefined);
  }

  function toggle(code: string) {
    if (!canEditActivePermissions) return;
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  function toggleModuleGroup(items: Permission[], selectAll: boolean) {
    if (!canEditActivePermissions) return;
    setChecked((prev) => {
      const next = new Set(prev);
      for (const item of items) {
        if (selectAll) next.add(item.code);
        else next.delete(item.code);
      }
      return next;
    });
  }

  async function createRole(event: React.FormEvent) {
    event.preventDefault();
    if (!newName.trim()) return;
    setBusy(true);
    setNotice(undefined);
    try {
      const created = await apiPost<Role>('/roles', {
        name: newName.trim(),
        description: newDesc.trim() || undefined,
        permissionCodes: [],
      });
      setNewName('');
      setNewDesc('');
      setNotice({ kind: 'ok', text: `تم إنشاء الدور «${created.name}» بنجاح. يمكنك الآن تحديد صلاحياته وحفظها.` });
      roles.reload();
      pickRole(created);
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function cloneRoleAsCustom(source: Role) {
    setBusy(true);
    setNotice(undefined);
    try {
      const codes = (source.permissionCodes ?? source.permissions ?? []).map((code) =>
        code.startsWith('platform.') ? `tenant.${code.slice('platform.'.length)}` : code,
      );
      const copyName = `${ROLE_NAME_AR[source.name] ? source.name : source.name} - مخصص`;
      const created = await apiPost<Role>('/roles', {
        name: copyName,
        description: source.description ?? 'نسخة مخصصة قابلة للتعديل',
        permissionCodes: codes,
      });
      setNotice({ kind: 'ok', text: `تم نسخ الصلاحيات إلى الدور الجديد «${created.name}».` });
      roles.reload();
      pickRole(created);
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function savePermissions() {
    if (!active) return;
    setBusy(true);
    setNotice(undefined);
    try {
      const permissionCodes = [...checked];
      let saved: Role;
      if (!active.isSystem) {
        saved = await apiPut<Role>(`/roles/${active.id}`, {
          name: editName.trim() || active.name,
          description: editDesc.trim() || null,
          permissionCodes,
        });
      } else {
        saved = await apiPost<Role>(`/roles/${active.id}/permissions`, {
          permissionCodes,
        });
      }
      setSelected(saved);
      setChecked(new Set(saved.permissionCodes ?? saved.permissions ?? permissionCodes));
      setNotice({
        kind: 'ok',
        text: `تم حفظ تعديلات وصلاحيات الدور «${ROLE_NAME_AR[saved.name] ?? saved.name}» (${permissionCodes.length} صلاحية).`,
      });
      roles.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen
      title="الأدوار والصلاحيات"
      subtitle="إدارة الأدوار الوظيفية وتحديد صلاحيات الوصول لكل وحدة وشاشة باللغة العربية."
      crumbs={['الإعدادات', 'الأدوار والصلاحيات']}
    >
      <Notice notice={notice} />

      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <section className="card grid">
          <div>
            <h2 style={{ marginBottom: 4 }}>إنشاء دور وظيفي جديد</h2>
            <p className="muted small" style={{ margin: 0 }}>
              أنشئ دوراً مخصصاً (مثل: مدير مبيعات، أمين مستودع، مدقق حسابات) ثم حدد صلاحياته من القائمة المقابلة.
            </p>
          </div>
          <form className="form" onSubmit={createRole}>
            <div className="form-grid">
              <label className="field">
                <span>اسم الدور *</span>
                <input
                  className="input"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  required
                  placeholder="مثال: مشرف مبيعات"
                />
              </label>
              <label className="field">
                <span>الوصف الوظيفي</span>
                <input
                  className="input"
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                  placeholder="وصف مختصر لمهام الدور"
                />
              </label>
            </div>
            <div className="toolbar">
              <button className="btn primary" type="submit" disabled={busy}>
                + إضافة الدور
              </button>
            </div>
          </form>

          <hr style={{ border: 0, borderTop: '1px solid var(--line)', margin: '4px 0' }} />

          <h3 style={{ marginBottom: 4 }}>الأدوار المسجلة في المنشأة</h3>
          <QueryView query={roles} empty="لا توجد أدوار مسجلة.">
            {(rows) => (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>الدور</th>
                      <th>النوع</th>
                      <th>عدد الصلاحيات</th>
                      <th>إجراء</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((role) => {
                      const isActive = active?.id === role.id;
                      const count = (role.permissionCodes ?? role.permissions ?? []).length;
                      return (
                        <tr
                          key={role.id}
                          className={isActive ? 'row-active clickable' : 'clickable'}
                          onClick={() => pickRole(role)}
                        >
                          <td>
                            <strong>{ROLE_NAME_AR[role.name] ?? role.name}</strong>
                            {role.description ? (
                              <div className="muted small" style={{ marginTop: 2 }}>
                                {role.description}
                              </div>
                            ) : null}
                          </td>
                          <td>
                            <span className={`badge ${role.isSystem ? 'neutral' : 'active'}`}>
                              {role.isSystem ? 'دور نظامي' : 'دور مخصص'}
                            </span>
                          </td>
                          <td className="num">{count}</td>
                          <td>
                            <button
                              className={`btn sm ${isActive ? 'primary' : ''}`}
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                pickRole(role);
                              }}
                            >
                              {isActive ? 'محدد حالياً' : 'تعديل الصلاحيات'}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </QueryView>
        </section>

        <section className="card grid">
          <div className="section-title">
            <div>
              <h2 style={{ marginBottom: 4 }}>
                صلاحيات الدور: {active ? ROLE_NAME_AR[active.name] ?? active.name : 'اختر دوراً'}
              </h2>
              <p className="muted small" style={{ margin: 0 }}>
                محدد حالياً: <strong>{checked.size}</strong> من أصل <strong>{canonicalPermissions.length}</strong> صلاحية
              </p>
            </div>
            {active && (
              <div className="toolbar">
                {isOwnerRole ? (
                  <button
                    className="btn"
                    type="button"
                    disabled={busy}
                    onClick={() => void cloneRoleAsCustom(active)}
                  >
                    نسخ إلى دور مخصص قابل للتعديل
                  </button>
                ) : (
                  <>
                    <button
                      className="btn sm"
                      type="button"
                      disabled={busy || !canEditActivePermissions}
                      onClick={() => setChecked(new Set(canonicalPermissions.map((p) => p.code)))}
                    >
                      تحديد الكل
                    </button>
                    <button
                      className="btn sm"
                      type="button"
                      disabled={busy || !canEditActivePermissions}
                      onClick={() => setChecked(new Set())}
                    >
                      إلغاء الكل
                    </button>
                    <button
                      className="btn primary"
                      type="button"
                      disabled={busy || !canEditActivePermissions}
                      onClick={() => void savePermissions()}
                    >
                      {busy ? 'جاري الحفظ...' : 'حفظ التعديلات'}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>

          {isOwnerRole && (
            <div className="alert info">
              <span>
                دور <strong>مالك الحساب (Owner)</strong> يمتلك كافة صلاحيات المنشأة تلقائياً ولا يمكن تقليص صلاحياته
                حمايةً للحساب. لإنشاء دور مشابه بصلاحيات مخصصة، اضغط على «نسخ إلى دور مخصص قابل للتعديل».
              </span>
            </div>
          )}

          {isSystemNonOwner && !me?.membership.isOwner && (
            <div className="alert warn">
              <span>تعديل الأدوار النظامية متاح لمالك الحساب فقط. يمكنك إنشاء وتعديل الأدوار المخصصة.</span>
            </div>
          )}

          {active && !active.isSystem && (
            <div className="form-grid" style={{ padding: '10px 12px', background: 'var(--surface-2)', borderRadius: 10 }}>
              <label className="field" style={{ marginBottom: 0 }}>
                <span>اسم الدور المخصص</span>
                <input
                  className="input"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  disabled={busy}
                />
              </label>
              <label className="field" style={{ marginBottom: 0 }}>
                <span>وصف الدور</span>
                <input
                  className="input"
                  value={editDesc}
                  onChange={(e) => setEditDesc(e.target.value)}
                  disabled={busy}
                  placeholder="وصف اختياري"
                />
              </label>
            </div>
          )}

          <label className="field" style={{ marginBottom: 4 }}>
            <span>بحث في الصلاحيات</span>
            <input
              className="input"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="ابحث باسم الصلاحية بالعربية أو اسم الوحدة..."
            />
          </label>

          <QueryView query={permissions} empty="لا توجد صلاحيات مسجلة.">
            {() => (
              <div className="grid" style={{ maxHeight: '62vh', overflowY: 'auto', paddingInlineEnd: 4 }}>
                {grouped.map(([mod, list]) => {
                  const moduleTitle = MODULE_LABELS_AR[mod] ?? mod;
                  const selectedInGroup = list.filter((p) => checked.has(p.code)).length;
                  const allSelectedInGroup = list.length > 0 && selectedInGroup === list.length;

                  return (
                    <div key={mod} className="card tight" style={{ background: 'var(--surface-2)' }}>
                      <div
                        className="row"
                        style={{
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          marginBottom: 8,
                          paddingBottom: 6,
                          borderBottom: '1px solid var(--line)',
                        }}
                      >
                        <div>
                          <strong style={{ fontSize: 14 }}>{moduleTitle}</strong>
                          <span className="badge neutral" style={{ marginInlineStart: 8 }}>
                            {selectedInGroup} / {list.length}
                          </span>
                        </div>
                        {canEditActivePermissions && (
                          <button
                            type="button"
                            className="btn sm"
                            onClick={() => toggleModuleGroup(list, !allSelectedInGroup)}
                          >
                            {allSelectedInGroup ? 'إلغاء تحديد القسم' : 'تحديد القسم بالكامل'}
                          </button>
                        )}
                      </div>

                      <div className="grid cols-2" style={{ gap: 8 }}>
                        {list.map((permission) => {
                          const info = describePermissionAr(permission);
                          const isChecked = checked.has(permission.code);
                          return (
                            <label
                              key={permission.code}
                              style={{
                                display: 'flex',
                                gap: 10,
                                alignItems: 'flex-start',
                                padding: '8px 10px',
                                borderRadius: 8,
                                border: `1px solid ${isChecked ? 'var(--brand-line)' : 'var(--line)'}`,
                                background: isChecked ? 'var(--brand-soft)' : 'var(--surface)',
                                cursor: canEditActivePermissions ? 'pointer' : 'default',
                                opacity: canEditActivePermissions || isChecked ? 1 : 0.75,
                              }}
                            >
                              <input
                                type="checkbox"
                                checked={isChecked}
                                disabled={!canEditActivePermissions}
                                onChange={() => toggle(permission.code)}
                                style={{ marginTop: 3, width: 16, height: 16, accentColor: 'var(--brand)' }}
                              />
                              <span style={{ display: 'grid', gap: 2, minWidth: 0 }}>
                                <strong style={{ fontSize: 13 }}>{info.title}</strong>
                                {info.detail ? (
                                  <small className="muted" style={{ fontSize: 11.5, lineHeight: 1.4 }}>
                                    {info.detail}
                                  </small>
                                ) : null}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </QueryView>
        </section>
      </div>
    </Screen>
  );
}
