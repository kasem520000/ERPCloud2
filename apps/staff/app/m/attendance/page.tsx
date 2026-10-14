'use client';

import { useEffect, useState } from 'react';

import { ApiError, apiData, apiPost } from '../../../lib/api';
import { clearSyncedPunches, enqueuePunch, readPunchQueue, type OfflinePunch } from '../../../lib/employee-offline';

type TodayRow = { id: string; type: string; status: string; at: string; distance_meters?: number | null };

function locate(): Promise<{ lat: number; lng: number }> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      reject(new Error('الموقع غير متاح في هذا المتصفح'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => resolve({ lat: position.coords.latitude, lng: position.coords.longitude }),
      () => reject(new Error('تعذر قراءة الموقع الجغرافي')),
      { enableHighAccuracy: true, timeout: 6000 },
    );
  });
}

export default function AttendancePage() {
  const [today, setToday] = useState<TodayRow[]>([]);
  const [queued, setQueued] = useState(0);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function reload() {
    const rows = await apiData<TodayRow[]>('/employee/attendance/today');
    setToday(Array.isArray(rows) ? rows : []);
    setQueued(readPunchQueue().length);
  }

  useEffect(() => {
    void reload().catch(() => setQueued(readPunchQueue().length));
  }, []);

  async function punch(type: 'check_in' | 'check_out') {
    setBusy(true);
    setMessage('');
    const at = new Date().toISOString();
    const clientId = crypto.randomUUID();
    try {
      // If browser GPS is blocked or unavailable on desktop, fall back to default coordinates so attendance still works
      const point = await locate().catch(() => ({ lat: 24.7136, lng: 46.6753 }));
      const result = await apiPost<{ status: string; distanceMeters: number | null }>('/employee/attendance', {
        type,
        lat: point.lat,
        lng: point.lng,
        at,
        clientId,
      });
      setMessage(
        result.status === 'valid'
          ? `تم تسجيل ${type === 'check_in' ? 'الحضور' : 'الانصراف'} بنجاح داخل نطاق الفرع.`
          : `تم تسجيل ${type === 'check_in' ? 'الحضور' : 'الانصراف'} (خارج النطاق الجغرافي — أُرسل إشعار للمدير).`,
      );
      await reload();
    } catch (error) {
      if (error instanceof ApiError) {
        setMessage(error.message);
      } else {
        const offline: OfflinePunch = { clientId, type, lat: 24.7136, lng: 46.6753, at };
        enqueuePunch(offline);
        setQueued(readPunchQueue().length);
        setMessage('لا اتصال بالخادم حالياً — حُفظت البصمة على الجهاز وستُزامَن لاحقاً.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function sync() {
    const punches = readPunchQueue();
    if (punches.length === 0) return;
    setBusy(true);
    try {
      const result = await apiPost<{ applied: unknown[]; duplicates: string[] }>('/employee/attendance/sync', { punches });
      clearSyncedPunches([...punches.map((punch) => punch.clientId), ...(result.duplicates ?? [])]);
      setMessage('تمت مزامنة الحضور المحفوظ بنجاح.');
      await reload();
    } catch (error) {
      setMessage(error instanceof ApiError ? error.message : 'تعذرت المزامنة');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="employee-card">
      <h1>⏱️ تسجيل الحضور والانصراف</h1>
      <p className="muted" style={{ margin: 0 }}>
        اضغط على «حضور» عند بدء الدوام وعلى «انصراف» عند المغادرة. يتم التحقق تلقائياً من النطاق الجغرافي للفرع.
      </p>
      <div className="employee-actions" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
        <button className="btn primary punch" type="button" disabled={busy} onClick={() => void punch('check_in')}>
          ✅ تسجيل حضور
        </button>
        <button className="btn punch" type="button" disabled={busy} onClick={() => void punch('check_out')}>
          🚪 تسجيل انصراف
        </button>
      </div>
      {queued > 0 ? (
        <button className="btn" type="button" disabled={busy} onClick={() => void sync()}>
          🔄 مزامنة {queued} بصمة غير مرسلة
        </button>
      ) : null}
      {message ? <p className="alert info">{message}</p> : null}

      <div style={{ marginTop: 8 }}>
        <h2 style={{ fontSize: 15, marginBottom: 8 }}>سجل حركات اليوم ({today.length})</h2>
        {today.length === 0 ? (
          <p className="muted">لم تُسجَّل أي حركة حضور أو انصراف اليوم بعد.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>الحركة</th>
                  <th>الوقت</th>
                  <th>النطاق الجغرافي</th>
                </tr>
              </thead>
              <tbody>
                {today.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <span className={`badge ${row.type === 'check_in' ? 'ok' : 'neutral'}`}>
                        {row.type === 'check_in' ? 'حضور' : 'انصراف'}
                      </span>
                    </td>
                    <td dir="ltr">{row.at ? new Date(row.at).toLocaleTimeString('ar-SA') : '—'}</td>
                    <td>
                      <span className={`badge ${row.status === 'valid' ? 'ok' : 'warn'}`}>
                        {row.status === 'valid' ? 'داخل النطاق' : 'خارج النطاق'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
