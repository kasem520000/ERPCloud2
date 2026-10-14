'use client';

import { useState } from 'react';

import { ApiError, apiPost } from '../../../../lib/api';

export default function NewEmployeeRequestPage() {
  const [type, setType] = useState('leave');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [reason, setReason] = useState('');
  const [advanceValue, setAdvanceValue] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="employee-card"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setMessage('');
        void apiPost('/employee/requests', { type, from, to, reason, amount: advanceValue || undefined })
          .then(() => {
            setReason('');
            setMessage('أُرسل الطلب إلى المدير.');
          })
          .catch((error: unknown) => setMessage(error instanceof ApiError ? error.message : 'تعذر إرسال الطلب'))
          .finally(() => setBusy(false));
      }}
    >
      <h1>طلب جديد</h1>
      <label className="field">
        <span>النوع</span>
        <select className="input" value={type} onChange={(event) => setType(event.target.value)}>
          <option value="leave">إجازة</option>
          <option value="permission">استئذان</option>
          <option value="custody">عهدة</option>
          <option value="advance">سلفة</option>
        </select>
      </label>
      <label className="field">
        <span>من</span>
        <input className="input" type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
      </label>
      <label className="field">
        <span>إلى</span>
        <input className="input" type="date" value={to} onChange={(event) => setTo(event.target.value)} />
      </label>
      {type === 'advance' ? (
        <label className="field">
          <span>المبلغ</span>
          <input className="input" inputMode="decimal" value={advanceValue} onChange={(event) => setAdvanceValue(event.target.value)} />
        </label>
      ) : null}
      <label className="field">
        <span>السبب</span>
        <textarea className="input" value={reason} onChange={(event) => setReason(event.target.value)} required />
      </label>
      {message ? <p className="alert info">{message}</p> : null}
      <button className="btn primary punch" type="submit" disabled={busy || !reason.trim()}>إرسال</button>
    </form>
  );
}
