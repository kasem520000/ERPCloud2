'use client';

import { useState } from 'react';
import {
  Copy,
  Download,
  KeyRound,
  QrCode,
  ShieldCheck,
  ShieldOff,
  Smartphone,
} from 'lucide-react';

import { Screen } from '../../../components/screen';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { ApiError, apiData, apiFetch } from '../../../lib/api';
import { useQuery } from '../../../lib/use-query';

type MfaStatus = { enabled: boolean; enrolled: boolean; recoveryCodesLeft: number };
type MfaEnroll = { secretBase32: string; otpauthUrl: string; issuer: string };

/**
 * التحقق بخطوتين — TOTP (RFC 6238) on the caller's own account.
 *
 * Flow mirrors the API's two-phase enrolment: `enroll` hands over a secret to scan or
 * type into an authenticator app; `enable` only takes effect after a valid code proves
 * the app was really configured — then eight one-time recovery codes appear once.
 */
export default function TwoFactorPage() {
  const status = useQuery<MfaStatus>(() => apiData('/auth/mfa'));

  const [phase, setPhase] = useState<'idle' | 'confirming' | 'codes'>('idle');
  const [enroll, setEnroll] = useState<MfaEnroll | undefined>(undefined);
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [copied, setCopied] = useState<string | undefined>(undefined);

  const fail = (caught: unknown) =>
    setError(caught instanceof ApiError ? caught.message : 'تعذر تنفيذ الطلب. أعد المحاولة.');

  async function start() {
    setBusy(true);
    setError(undefined);
    try {
      const created = await apiData<MfaEnroll>('/auth/mfa/enroll', { method: 'POST', body: JSON.stringify({}) });
      setEnroll(created);
      setPhase('confirming');
    } catch (caught) {
      fail(caught);
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    setBusy(true);
    setError(undefined);
    try {
      const enabled = await apiData<{ recoveryCodes: string[] }>('/auth/mfa/enable', {
        method: 'POST',
        body: JSON.stringify({ code: code.trim() }),
      });
      setRecoveryCodes(enabled.recoveryCodes);
      setPhase('codes');
      setCode('');
      status.reload();
    } catch (caught) {
      fail(caught);
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    setError(undefined);
    try {
      await apiFetch('/auth/mfa/disable', { method: 'POST', body: JSON.stringify({ password }) });
      setPassword('');
      setPhase('idle');
      status.reload();
    } catch (caught) {
      fail(caught);
    } finally {
      setBusy(false);
    }
  }

  function copy(text: string, what: string) {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(what);
      setTimeout(() => setCopied(undefined), 1500);
    });
  }

  function downloadCodes() {
    const blob = new Blob([`Cloud SaaS ERP — recovery codes\n${recoveryCodes.join('\n')}\n`], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'erp-recovery-codes.txt';
    anchor.click();
    URL.revokeObjectURL(url);
  }

  const enabled = status.data?.enabled ?? false;
  const enrolled = status.data?.enrolled ?? false;

  return (
    <Screen
      title="التحقق بخطوتين"
      subtitle="Two-factor authentication (TOTP)"
      crumbs={['الإعدادات', 'المستخدمون']}
    >
      {status.status === 'loading' ? <SkeletonCard /> : null}
      {status.status === 'error' ? <ErrorBox message={status.error} onRetry={status.reload} /> : null}
      {status.status === 'forbidden' ? <ErrorBox message={status.error} /> : null}

      {status.status === 'success' && (
        <>
          {/* status card */}
          <section className="rounded-xl border border-line bg-surface p-4 shadow-1">
            <div className="flex flex-wrap items-center gap-3">
              <span
                className={`grid place-items-center size-12 rounded-2xl ${enabled ? 'bg-ok-soft text-ok' : 'bg-surface-3 text-muted'}`}
              >
                <ShieldCheck size={22} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="m-0 text-[16px] font-bold text-ink">حالة الحماية</h3>
                  <Badge tone={enabled ? 'green' : 'amber'} dot>
                    {enabled ? 'مفعَّل — الدخول يتطلب رمز التطبيق' : 'غير مفعَّل'}
                  </Badge>
                </div>
                <p className="m-0 mt-1.5 text-[13px] text-muted leading-relaxed">
                  يضيف التحقق بخطوتين طبقة حماية فوق كلمة المرور: رمز متغيَّر كل 30 ثانية من تطبيق مصادقة
                  (Google Authenticator أو Microsoft Authenticator أو غيرهما)، مع رموز استرداد تُستخدم مرة واحدة
                  إذا فقدت جهازك.
                </p>
              </div>
              {enabled ? (
                <div className="text-center rounded-xl border border-line bg-surface-2 px-4 py-2.5">
                  <p className="m-0 text-[24px] font-bold text-ink" style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {status.data?.recoveryCodesLeft ?? 0}
                  </p>
                  <p className="m-0 text-[11.5px] font-bold text-muted">رموز استرداد متبقية</p>
                </div>
              ) : null}
            </div>
          </section>

          {error ? (
            <div className="flex items-center gap-2 rounded-xl border border-danger-line bg-danger-soft px-4 py-2.5 text-[13px] font-semibold text-danger-ink">
              {error}
            </div>
          ) : null}

          {/* Phase: not enrolled — offer to start. */}
          {!enrolled && phase === 'idle' ? (
            <section className="rounded-xl border border-line bg-surface p-4 shadow-1 grid gap-3">
              <div className="flex items-center gap-2">
                <span className="grid place-items-center size-8 rounded-lg bg-brand-50 text-brand-600">
                  <Smartphone size={16} />
                </span>
                <h3 className="m-0 text-[15px] font-bold text-ink">ابدأ الإعداد</h3>
              </div>
              <p className="m-0 text-[13px] text-muted">
                سيُنشأ مفتاح خاص بحسابك، تضيفه إلى تطبيق المصادقة ثم تؤكد برمز حيّ لتفعيل الحماية.
              </p>
              <div>
                <Button variant="primary" loading={busy} onClick={() => void start()} icon={<KeyRound size={15} />}>
                  بدء الإعداد
                </Button>
              </div>
            </section>
          ) : null}

          {/* Phase: secret issued — scan/type, then confirm with a live code. */}
          {phase === 'confirming' && enroll ? (
            <section className="rounded-xl border border-line bg-surface p-4 shadow-1 grid gap-5">
              <div>
                <h4 className="m-0 text-[14px] font-bold text-ink flex items-center gap-2">
                  <span className="grid place-items-center size-6 rounded-full bg-brand-600 text-on-accent text-[12px]">1</span>
                  أضف الحساب إلى تطبيق المصادقة
                </h4>
                <p className="m-0 mt-1.5 text-[12.5px] text-muted">
                  امسح الرابط أدناه كرمز QR عبر أي مولّد رموز، أو أدخل المفتاح يدوياً في التطبيق.
                </p>
                <div className="mt-3 grid gap-3">
                  <div className="rounded-lg border border-line bg-surface-2 p-3">
                    <div className="flex items-center justify-between gap-2 mb-1.5">
                      <span className="text-[11.5px] font-bold text-muted flex items-center gap-1.5">
                        <QrCode size={13} /> رابط التهيئة (otpauth)
                      </span>
                      <Button size="sm" variant="secondary" icon={<Copy size={13} />} onClick={() => copy(enroll.otpauthUrl, 'otpauth')}>
                        {copied === 'otpauth' ? 'تم النسخ' : 'نسخ'}
                      </Button>
                    </div>
                    <p className="m-0 text-[12px] text-ink-2 break-all" dir="ltr">
                      {enroll.otpauthUrl}
                    </p>
                  </div>
                  <div className="rounded-lg border border-line bg-surface-2 p-3">
                    <div className="flex items-center justify-between gap-2 mb-1.5">
                      <span className="text-[11.5px] font-bold text-muted">المفتاح (إدخال يدوي)</span>
                      <Button size="sm" variant="secondary" icon={<Copy size={13} />} onClick={() => copy(enroll.secretBase32, 'secret')}>
                        {copied === 'secret' ? 'تم النسخ' : 'نسخ'}
                      </Button>
                    </div>
                    <p className="m-0 text-[15px] font-bold text-ink tracking-[0.2em]" dir="ltr">
                      {enroll.secretBase32}
                    </p>
                  </div>
                </div>
              </div>

              <div className="border-t border-line pt-4">
                <h4 className="m-0 text-[14px] font-bold text-ink flex items-center gap-2">
                  <span className="grid place-items-center size-6 rounded-full bg-brand-600 text-on-accent text-[12px]">2</span>
                  أكِّد برمز التطبيق
                </h4>
                <div className="mt-3 flex flex-wrap items-end gap-3">
                  <div style={{ maxWidth: 180 }}>
                    <Input label="الرمز" value={code} onChange={(e) => setCode(e.target.value)} placeholder="000000" hint="الرمز الست أرقام من التطبيق." />
                  </div>
                  <Button variant="primary" loading={busy} disabled={code.trim().length !== 6} onClick={() => void confirm()}>
                    تفعيل
                  </Button>
                </div>
              </div>
            </section>
          ) : null}

          {/* Phase: just enabled — recovery codes are visible exactly once. */}
          {phase === 'codes' ? (
            <section className="rounded-xl border border-ok-line bg-ok-soft p-4 shadow-1 grid gap-4">
              <div className="flex items-start gap-3">
                <span className="grid place-items-center size-10 rounded-xl bg-ok-soft text-ok-ink flex-none">
                  <ShieldCheck size={20} />
                </span>
                <div>
                  <h3 className="m-0 text-[15px] font-bold text-ok-ink">تم تفعيل التحقق بخطوتين</h3>
                  <p className="m-0 mt-1 text-[13px] text-ok-ink">
                    هذه رموز الاسترداد — تُعرض مرة واحدة فقط ولن تظهر مجدداً. احفظها في مكان آمن؛ كل رمز يعمل مرة واحدة.
                  </p>
                </div>
              </div>
              <div className="rounded-lg bg-surface border border-ok-line p-4" dir="ltr">
                <pre className="m-0 text-[14px] font-bold text-ink" style={{ letterSpacing: 2, lineHeight: 2 }}>
                  {recoveryCodes.join('\n')}
                </pre>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" icon={<Copy size={15} />} onClick={() => copy(recoveryCodes.join('\n'), 'codes')}>
                  {copied === 'codes' ? 'تم النسخ' : 'نسخ الرموز'}
                </Button>
                <Button variant="secondary" icon={<Download size={15} />} onClick={downloadCodes}>
                  تنزيل ملف نصي
                </Button>
              </div>
            </section>
          ) : null}

          {/* Phase: enabled — disable requires the account password. */}
          {enabled && phase !== 'codes' ? (
            <section className="rounded-xl border border-danger-line bg-surface p-4 shadow-1">
              <div className="flex items-center gap-2 mb-2">
                <span className="grid place-items-center size-8 rounded-lg bg-danger-soft text-danger">
                  <ShieldOff size={16} />
                </span>
                <h3 className="m-0 text-[15px] font-bold text-ink">إيقاف التحقق بخطوتين</h3>
              </div>
              <p className="m-0 text-[13px] text-muted mb-3">
                يتطلب كلمة مرور الحساب. لا يُنصح بالإيقاف إلا عند فقدان تطبيق المصادقة.
              </p>
              <div className="flex flex-wrap items-end gap-3">
                <div style={{ maxWidth: 280 }}>
                  <Input
                    label="كلمة المرور"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="كلمة المرور"
                    hint="تُتحقق من كلمة مرور حسابك الحالي."
                  />
                </div>
                <Button variant="danger" loading={busy} disabled={!password} onClick={() => void disable()}>
                  إيقاف التحقق بخطوتين
                </Button>
              </div>
            </section>
          ) : null}
        </>
      )}
    </Screen>
  );
}

function SkeletonCard() {
  return (
    <div className="rounded-xl border border-line bg-surface p-4 shadow-1 grid gap-3" aria-busy="true">
      <div className="h-4 w-1/3 rounded-md bg-surface-3 animate-pulse" />
      <div className="h-9 rounded-md bg-surface-3 animate-pulse" style={{ width: '85%' }} />
      <div className="h-9 rounded-md bg-surface-3 animate-pulse" style={{ width: '60%' }} />
    </div>
  );
}

function ErrorBox({ message, onRetry }: { message?: string; onRetry?: () => void }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4 shadow-1 grid gap-3">
      <p className="m-0 flex items-center gap-2 rounded-xl border border-danger-line bg-danger-soft px-4 py-2.5 text-[13px] font-semibold text-danger-ink">
        {message ?? 'خطأ غير معروف'}
      </p>
      {onRetry ? (
        <Button variant="primary" onClick={onRetry}>
          إعادة المحاولة
        </Button>
      ) : null}
    </div>
  );
}
