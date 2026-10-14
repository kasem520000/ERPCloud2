'use client';

import { Screen } from '../../../components/screen';
import { apiBaseUrl } from '../../../lib/api';

export default function AboutPage() {
  return (
    <Screen title="عن النظام" subtitle="معلومات المنصة السحابية والامتثال الضريبي والأمني." crumbs={['الدعم الفني']}>
      <section className="card">
        <h2>منصة ERP السحابية المتكاملة</h2>
        <dl className="kv">
          <dt>الإصدار</dt>
          <dd dir="ltr">v1.0.0 — Cloud Enterprise Edition</dd>
          <dt>الامتثال الضريبي</dt>
          <dd>متوافق مع هيئة الزكاة والضريبة والجمارك (ZATCA — المرحلة الثانية للربط والتكامل)</dd>
          <dt>عزل البيانات والأمان</dt>
          <dd>عزل كامل متعدد المنشآت على مستوى الصفوف (PostgreSQL Row-Level Security) + تشفير AES-256-GCM</dd>
          <dt>نقطة اتصال الخدمة</dt>
          <dd dir="ltr">{apiBaseUrl}</dd>
        </dl>
      </section>

      <section className="card" id="updates">
        <h2>التحديثات السحابية والنسخ الاحتياطي</h2>
        <p className="muted">
          يعمل النظام بالكامل على البنية السحابية المؤمّنة؛ تُطبَّق التحديثات الأمنية والمحاسبية والضريبية تلقائياً دون
          توقف للخدمة أو حاجة لأي تثبيت محلي على أجهزة المستخدمين.
        </p>
      </section>
    </Screen>
  );
}
