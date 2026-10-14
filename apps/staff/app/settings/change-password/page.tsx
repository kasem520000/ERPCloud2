'use client';

import { useState } from 'react';

import { Screen } from '../../../components/screen';
import { ApiError, apiFetch } from '../../../lib/api';
import { useSession } from '../../../lib/session';

export default function ChangePasswordPage() {
  const { signOut } = useSession();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'danger'; text: string } | undefined>();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (next !== confirm) {
      setMessage({ kind: 'danger', text: 'كلمتا المرور غير متطابقتين.' });
      return;
    }
    setBusy(true);
    setMessage(undefined);
    try {
      await apiFetch('/auth/change-password', { method: 'POST', body: JSON.stringify({ current, new: next }) });
      setMessage({ kind: 'ok', text: 'تم تغيير كلمة المرور. سيتم إنهاء جميع الجلسات خلال لحظات.' });
      setTimeout(() => void signOut(), 2000);
    } catch (error) {
      setMessage({
        kind: 'danger',
        text: error instanceof ApiError ? `${error.message}${error.detail ? ` — ${error.detail}` : ''}` : String(error),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen title="تغيير كلمة المرور" subtitle="تغيير كلمة المرور يُبطل كل الجلسات النشطة." crumbs={['الإعدادات', 'إعدادات المستخدمين']}>
      <form className="card" onSubmit={submit} style={{ maxWidth: 520 }}>
        <label className="field">
          <span>كلمة المرور الحالية *</span>
          <input className="input" dir="ltr" type="password" value={current} onChange={(event) => setCurrent(event.target.value)} required />
        </label>
        <label className="field">
          <span>كلمة المرور الجديدة * (12 حرفاً على الأقل)</span>
          <input className="input" dir="ltr" type="password" minLength={12} value={next} onChange={(event) => setNext(event.target.value)} required />
        </label>
        <label className="field">
          <span>تأكيد كلمة المرور الجديدة *</span>
          <input className="input" dir="ltr" type="password" minLength={12} value={confirm} onChange={(event) => setConfirm(event.target.value)} required />
        </label>
        {message && <p className={`alert ${message.kind}`}>{message.text}</p>}
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? 'جارٍ الحفظ…' : 'تغيير كلمة المرور'}
        </button>
      </form>
    </Screen>
  );
}
