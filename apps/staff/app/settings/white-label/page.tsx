'use client';

import { useEffect, useState } from 'react';

import { Notice } from '../../../components/data-view';
import { Screen } from '../../../components/screen';
import { ApiError, apiData, apiDelete, apiPost, apiPut } from '../../../lib/api';

type DomainRow = {
  id: string;
  domain: string;
  status: string;
  sslStatus: string;
  txtHost: string;
  txtValue: string;
  verifiedAt: string | null;
};

type Brand = {
  logoFileId: string;
  logoUrl: string;
  primaryColor: string;
  secondaryColor: string;
  nameAr: string;
};

type Presign = { fileId: string; uploadUrl: string; requiredHeaders: Record<string, string> };

export default function WhiteLabelPage() {
  const [domains, setDomains] = useState<DomainRow[]>([]);
  const [domain, setDomain] = useState('');
  const [brand, setBrand] = useState<Brand>({
    logoFileId: '',
    logoUrl: '',
    primaryColor: '#0f766e',
    secondaryColor: '#115e59',
    nameAr: '',
  });
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'info'; text: string }>();
  const [busy, setBusy] = useState('');

  async function reload() {
    const [nextDomains, nextBrand] = await Promise.all([
      apiData<DomainRow[]>('/settings/white-label/domains'),
      apiData<Brand>('/settings/white-label/branding'),
    ]);
    setDomains(nextDomains);
    setBrand({
      logoFileId: nextBrand.logoFileId ?? '',
      logoUrl: nextBrand.logoUrl ?? '',
      primaryColor: nextBrand.primaryColor || '#0f766e',
      secondaryColor: nextBrand.secondaryColor || '#115e59',
      nameAr: nextBrand.nameAr ?? '',
    });
  }

  useEffect(() => {
    reload().catch((error: unknown) => setNotice({ kind: 'danger', text: messageOf(error) }));
  }, []);

  async function addDomain() {
    setBusy('domain');
    setNotice(undefined);
    try {
      const created = await apiPost<DomainRow>('/settings/white-label/domains', { domain });
      setDomain('');
      setNotice({
        kind: 'info',
        text: `أضف سجل TXT على ${created.txtHost} بالقيمة ${created.txtValue} ثم اضغط تحقق. الشهادة تُركَّب يدوياً على الخادم الوكيل.`,
      });
      await reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: messageOf(error) });
    } finally {
      setBusy('');
    }
  }

  async function verify(id: string) {
    setBusy(id);
    setNotice(undefined);
    try {
      const verified = await apiPost<DomainRow>(`/settings/white-label/domains/${id}/verify`, {});
      setNotice({ kind: 'ok', text: `${verified.domain} أصبح ${verified.status}. ssl: ${verified.sslStatus}.` });
      await reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: messageOf(error) });
    } finally {
      setBusy('');
    }
  }

  async function remove(id: string) {
    setBusy(id);
    try {
      await apiDelete(`/settings/white-label/domains/${id}`);
      await reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: messageOf(error) });
    } finally {
      setBusy('');
    }
  }

  async function uploadLogo(file: File) {
    setBusy('logo');
    setNotice(undefined);
    try {
      const presigned = await apiPost<Presign>('/files/presign', {
        name: file.name,
        mime: file.type || 'image/png',
        sizeBytes: file.size,
      });
      const put = await fetch(presigned.uploadUrl, {
        method: 'PUT',
        headers: { ...presigned.requiredHeaders },
        body: file,
      });
      if (!put.ok) throw new Error(`التخزين رفض الرفع (${put.status})`);
      await apiPost(`/files/${presigned.fileId}/finalize`, {});
      const saved = await apiPut<Brand>('/settings/white-label/branding', {
        logoFileId: presigned.fileId,
        primaryColor: brand.primaryColor,
        secondaryColor: brand.secondaryColor,
      });
      setBrand(saved);
      window.dispatchEvent(new Event('erp:brand-changed'));
      setNotice({ kind: 'ok', text: 'حُفظ الشعار. سيظهر في الفاتورة المطبوعة.' });
    } catch (error) {
      setNotice({ kind: 'danger', text: messageOf(error) });
    } finally {
      setBusy('');
    }
  }

  async function saveColors() {
    setBusy('colors');
    setNotice(undefined);
    try {
      const saved = await apiPut<Brand>('/settings/white-label/branding', {
        logoFileId: brand.logoFileId,
        primaryColor: brand.primaryColor,
        secondaryColor: brand.secondaryColor,
      });
      setBrand(saved);
      window.dispatchEvent(new Event('erp:brand-changed'));
      setNotice({ kind: 'ok', text: 'حُفظت الألوان.' });
    } catch (error) {
      setNotice({ kind: 'danger', text: messageOf(error) });
    } finally {
      setBusy('');
    }
  }

  return (
    <Screen
      title="الدومين والشعار"
      subtitle="الدومين يُثبت بسجل TXT. بعد التحقق وجّه السجل A أو CNAME إلى خادم التطبيق، ثم ركّب الشهادة يدوياً على Caddy أو nginx. لا تُصدر شهادة من هنا. الشعار يظهر في ترويسة الفاتورة."
      crumbs={['الإعدادات', 'الدومين والشعار']}
    >
      {notice ? <Notice notice={notice} /> : null}
      <section className="card" style={{ display: 'grid', gap: 12 }}>
        <strong>الشعار والألوان {brand.nameAr ? `— ${brand.nameAr}` : ''}</strong>
        {brand.logoUrl ? <img src={brand.logoUrl} alt="شعار المنشأة" style={{ maxHeight: 64, maxWidth: 180, objectFit: 'contain' }} /> : null}
        <label className="field">
          <span>ملف الشعار (صورة)</span>
          <input
            type="file"
            accept="image/*"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void uploadLogo(file);
            }}
          />
        </label>
        <label className="field">
          <span>اللون الأساسي</span>
          <input dir="ltr" value={brand.primaryColor} onChange={(event) => setBrand({ ...brand, primaryColor: event.target.value })} />
        </label>
        <label className="field">
          <span>اللون الثانوي</span>
          <input dir="ltr" value={brand.secondaryColor} onChange={(event) => setBrand({ ...brand, secondaryColor: event.target.value })} />
        </label>
        <button className="btn primary" type="button" disabled={busy === 'colors'} onClick={() => saveColors()}>
          حفظ الألوان
        </button>
      </section>
      <section className="card" style={{ display: 'grid', gap: 12 }}>
        <strong>دومين خاص</strong>
        <label className="field wide">
          <span>الدومين</span>
          <input dir="ltr" value={domain} placeholder="shop.example.com" onChange={(event) => setDomain(event.target.value)} />
        </label>
        <button className="btn primary" type="button" disabled={busy === 'domain' || !domain.trim()} onClick={() => addDomain()}>
          إضافة
        </button>
        {domains.map((row) => (
          <article key={row.id} style={{ display: 'grid', gap: 4 }}>
            <strong dir="ltr">{row.domain}</strong>
            <span className="muted">
              {row.status} · ssl {row.sslStatus}
              {row.verifiedAt ? ` · ${row.verifiedAt.slice(0, 10)}` : ''}
            </span>
            <code dir="ltr">
              {row.txtHost} TXT {row.txtValue}
            </code>
            <span>
              <button className="btn" type="button" disabled={busy === row.id} onClick={() => verify(row.id)}>
                تحقق
              </button>{' '}
              <button className="btn" type="button" disabled={busy === row.id} onClick={() => remove(row.id)}>
                إزالة
              </button>
            </span>
          </article>
        ))}
      </section>
    </Screen>
  );
}

function messageOf(error: unknown): string {
  if (error instanceof ApiError) return error.detail || error.message;
  return error instanceof Error ? error.message : 'تعذر إكمال الطلب';
}
