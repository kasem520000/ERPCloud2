'use client';

import { useEffect, useState } from 'react';

import { Empty, ErrorBox, Forbidden, Loading, Screen } from '../../../components/screen';
import { ApiError, apiData, apiPut } from '../../../lib/api';
import { useSession } from '../../../lib/session';
import { useQuery } from '../../../lib/use-query';

type Address = {
  plot?: string;
  building?: string;
  street?: string;
  addStreet?: string;
  district?: string;
  city?: string;
  postal?: string;
  countryCode?: string;
};

type Profile = {
  nameAr: string;
  nameEn: string | null;
  taxNo: string | null;
  crNo: string | null;
  logoFileId: string | null;
  address: Address | null;
  phones: string[];
  email: string | null;
  countryCode: string | null;
  einvoiceFlags: { zatca?: boolean; eta?: boolean };
  version: number;
} | null;

type Draft = {
  nameAr: string;
  nameEn: string;
  taxNo: string;
  crNo: string;
  phones: string;
  email: string;
  countryCode: string;
  address: Required<Address>;
};

const EMPTY_ADDRESS: Required<Address> = {
  plot: '', building: '', street: '', addStreet: '', district: '', city: '', postal: '', countryCode: '',
};

const EMPTY_DRAFT: Draft = {
  nameAr: '', nameEn: '', taxNo: '', crNo: '', phones: '', email: '', countryCode: 'SA', address: EMPTY_ADDRESS,
};

const LABELS: Record<string, string> = {
  nameAr: 'الاسم القانوني (عربي)',
  nameEn: 'الاسم القانوني (إنجليزي)',
  taxNo: 'الرقم الضريبي',
  crNo: 'السجل التجاري',
  email: 'البريد الإلكتروني',
  countryCode: 'الدولة',
};

const ADDRESS_LABELS: Record<keyof Address, string> = {
  plot: 'الرقم الفرعي',
  building: 'رقم المبنى',
  street: 'الشارع',
  addStreet: 'الشارع الإضافي',
  district: 'الحي',
  city: 'المدينة',
  postal: 'الرمز البريدي',
  countryCode: 'رمز الدولة',
};

export default function CompanyProfilePage() {
  const { me, can } = useSession();
  const canManage = can('organization.companyprofile.manage');
  const profile = useQuery<Profile>(async () => {
    try {
      return await apiData<Profile>('/company-profile');
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  }, []);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger'; text: string }>();
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);

  useEffect(() => {
    if (profile.status !== 'success') return;
    const row = profile.data;
    setDraft(row ? {
      nameAr: row.nameAr,
      nameEn: row.nameEn ?? '',
      taxNo: row.taxNo ?? '',
      crNo: row.crNo ?? '',
      phones: row.phones.join(', '),
      email: row.email ?? '',
      countryCode: row.countryCode ?? 'SA',
      address: { ...EMPTY_ADDRESS, ...(row.address ?? {}) },
    } : EMPTY_DRAFT);
  }, [profile.status, profile.data]);

  const setAddress = (key: keyof Address, value: string): void =>
    setDraft((current) => ({ ...current, address: { ...current.address, [key]: value } }));

  const save = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setNotice(undefined);
    try {
      const address = Object.fromEntries(
        Object.entries(draft.address).filter(([, value]) => value.trim().length > 0),
      );
      await apiPut('/company-profile', {
        nameAr: draft.nameAr.trim(),
        nameEn: draft.nameEn.trim() || null,
        taxNo: draft.taxNo.trim() || null,
        crNo: draft.crNo.trim() || null,
        address: Object.keys(address).length > 0 ? address : null,
        phones: draft.phones.split(/[,،\n]/).map((phone) => phone.trim()).filter(Boolean),
        email: draft.email.trim() || null,
        countryCode: draft.countryCode.trim().toUpperCase() || null,
        logoFileId: profile.data?.logoFileId ?? null,
        einvoiceFlags: profile.data?.einvoiceFlags ?? {},
        ...(profile.data ? { version: profile.data.version } : {}),
      });
      setNotice({ kind: 'ok', text: 'تم حفظ بيانات المنشأة.' });
      setEditing(false);
      profile.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title="بطاقة المنشأة" subtitle="البيانات القانونية المطبوعة على الفواتير والمستندات." crumbs={['الإعدادات', 'تعاريف المنشأة']}>
      <section className="card">
        <h2>حساب المنشأة على المنصة</h2>
        <dl className="kv">
          <dt>اسم المنشأة</dt>
          <dd>{me?.membership.tenantName}</dd>
          <dt>رمز المنشأة</dt>
          <dd dir="ltr">{me?.membership.tenantCode}</dd>
          <dt>دورك</dt>
          <dd>{me?.membership.isOwner ? 'مالك' : 'مستخدم'}</dd>
        </dl>
      </section>

      {profile.status === 'loading' && <Loading rows={3} />}
      {profile.status === 'forbidden' && <Forbidden />}
      {profile.status === 'error' && <ErrorBox message={profile.error} onRetry={profile.reload} />}
      {profile.status === 'success' && !editing && (
        <section className="card">
          <div className="row">
            <h2>البيانات القانونية</h2>
            {canManage && <button type="button" className="btn primary" onClick={() => { setNotice(undefined); setEditing(true); }}>{profile.data ? 'تعديل البيانات' : 'إضافة بيانات المنشأة'}</button>}
          </div>
          {notice && <p className={`alert ${notice.kind}`}>{notice.text}</p>}
          {!profile.data ? (
            <Empty title="لم تُسجَّل بيانات المنشأة بعد" detail={canManage ? 'أضف الاسم القانوني وبيانات التواصل والعنوان.' : 'اطلب من مالك المنشأة إدخال بياناتها القانونية.'} />
          ) : (
            <dl className="kv">
              <dt>{LABELS.nameAr}</dt><dd>{profile.data.nameAr}</dd>
              <dt>{LABELS.nameEn}</dt><dd>{profile.data.nameEn ?? '—'}</dd>
              <dt>{LABELS.taxNo}</dt><dd dir="ltr">{profile.data.taxNo ?? '—'}</dd>
              <dt>{LABELS.crNo}</dt><dd dir="ltr">{profile.data.crNo ?? '—'}</dd>
              <dt>العنوان الوطني</dt>
              <dd>{profile.data.address ? Object.entries(profile.data.address).map(([key, value]) => value ? `${ADDRESS_LABELS[key as keyof Address]}: ${value}` : null).filter(Boolean).join('، ') || '—' : '—'}</dd>
              <dt>الهاتف</dt><dd dir="ltr">{profile.data.phones.join('، ') || '—'}</dd>
              <dt>{LABELS.email}</dt><dd dir="ltr">{profile.data.email ?? '—'}</dd>
              <dt>{LABELS.countryCode}</dt><dd dir="ltr">{profile.data.countryCode ?? '—'}</dd>
            </dl>
          )}
        </section>
      )}

      {profile.status === 'success' && editing && canManage && (
        <section className="card">
          <h2>{profile.data ? 'تعديل البيانات القانونية' : 'إضافة بيانات المنشأة'}</h2>
          {notice && <p className={`alert ${notice.kind}`}>{notice.text}</p>}
          <form className="form-grid" onSubmit={(event) => void save(event)}>
            <label>الاسم القانوني (عربي)<input required maxLength={200} value={draft.nameAr} onChange={(event) => setDraft({ ...draft, nameAr: event.target.value })} /></label>
            <label>الاسم القانوني (إنجليزي)<input maxLength={200} value={draft.nameEn} onChange={(event) => setDraft({ ...draft, nameEn: event.target.value })} dir="auto" /></label>
            <label>الرقم الضريبي<input maxLength={15} inputMode="numeric" value={draft.taxNo} onChange={(event) => setDraft({ ...draft, taxNo: event.target.value })} dir="ltr" /></label>
            <label>السجل التجاري<input maxLength={20} value={draft.crNo} onChange={(event) => setDraft({ ...draft, crNo: event.target.value })} dir="ltr" /></label>
            <label>البريد الإلكتروني<input type="email" maxLength={320} value={draft.email} onChange={(event) => setDraft({ ...draft, email: event.target.value })} dir="ltr" /></label>
            <label>أرقام الهاتف (افصل بينها بفاصلة)<input value={draft.phones} onChange={(event) => setDraft({ ...draft, phones: event.target.value })} dir="ltr" /></label>
            <label>رمز الدولة<input maxLength={2} value={draft.countryCode} onChange={(event) => setDraft({ ...draft, countryCode: event.target.value })} dir="ltr" /></label>
            <fieldset>
              <legend>العنوان الوطني</legend>
              <div className="form-grid">
                <label>المدينة<input value={draft.address.city} onChange={(event) => setAddress('city', event.target.value)} /></label>
                <label>الحي<input value={draft.address.district} onChange={(event) => setAddress('district', event.target.value)} /></label>
                <label>الشارع<input value={draft.address.street} onChange={(event) => setAddress('street', event.target.value)} /></label>
                <label>الشارع الإضافي<input value={draft.address.addStreet} onChange={(event) => setAddress('addStreet', event.target.value)} /></label>
                <label>رقم المبنى<input value={draft.address.building} onChange={(event) => setAddress('building', event.target.value)} /></label>
                <label>الرقم الفرعي<input value={draft.address.plot} onChange={(event) => setAddress('plot', event.target.value)} /></label>
                <label>الرمز البريدي<input value={draft.address.postal} onChange={(event) => setAddress('postal', event.target.value)} /></label>
                <label>رمز الدولة<input maxLength={2} value={draft.address.countryCode} onChange={(event) => setAddress('countryCode', event.target.value)} dir="ltr" /></label>
              </div>
            </fieldset>
            <div className="row">
              <button type="submit" className="btn primary" disabled={busy || !draft.nameAr.trim()}>{busy ? 'جارٍ الحفظ…' : 'حفظ البيانات'}</button>
              {profile.data && <button type="button" className="btn" disabled={busy} onClick={() => { setNotice(undefined); setEditing(false); }}>إلغاء</button>}
            </div>
          </form>
        </section>
      )}
    </Screen>
  );
}
