'use client';

import { useEffect, useState } from 'react';

import { Screen } from '../../../components/screen';
import { ApiError, apiData, apiPut } from '../../../lib/api';

type Fence = { branch_id: string; branch_name: string; lat: string; lng: string; radius_meters: number };

export default function GeofencesPage() {
  const [rows, setRows] = useState<Fence[]>([]);
  const [branchId, setBranchId] = useState('');
  const [lat, setLat] = useState('');
  const [lng, setLng] = useState('');
  const [radius, setRadius] = useState('200');
  const [message, setMessage] = useState('');

  async function reload() {
    const next = await apiData<Fence[]>('/hrm/geofences');
    setRows(Array.isArray(next) ? next : []);
  }

  useEffect(() => {
    void reload().catch((error: unknown) => setMessage(error instanceof ApiError ? error.message : 'تعذر تحميل النطاقات'));
  }, []);

  return (
    <Screen title="نطاق حضور الفروع" subtitle="الحضور داخل الدائرة يُسجَّل صحيحاً. خارجه يُسجَّل ويصل تنبيه للمدير. الافتراضي 200 متر." crumbs={['الموظفين', 'النطاق']}>
      {message ? <p className="alert info">{message}</p> : null}
      <form
        className="card"
        onSubmit={(event) => {
          event.preventDefault();
          void apiPut(`/hrm/geofences/${branchId}`, { lat: Number(lat), lng: Number(lng), radiusMeters: Number(radius) })
            .then(() => reload())
            .then(() => setMessage('حُفظ نطاق الفرع.'))
            .catch((error: unknown) => setMessage(error instanceof ApiError ? error.message : 'تعذر الحفظ'));
        }}
      >
        <div className="form-grid">
          <label className="field"><span>معرّف الفرع</span><input className="input" dir="ltr" value={branchId} onChange={(event) => setBranchId(event.target.value)} required /></label>
          <label className="field"><span>خط العرض</span><input className="input" dir="ltr" value={lat} onChange={(event) => setLat(event.target.value)} required /></label>
          <label className="field"><span>خط الطول</span><input className="input" dir="ltr" value={lng} onChange={(event) => setLng(event.target.value)} required /></label>
          <label className="field"><span>نصف القطر بالمتر</span><input className="input" dir="ltr" value={radius} onChange={(event) => setRadius(event.target.value)} /></label>
        </div>
        <button className="btn primary" type="submit">حفظ</button>
      </form>
      <section className="card">
        {rows.map((row) => (
          <p key={row.branch_id}>{row.branch_name}: {row.lat}, {row.lng} — {row.radius_meters}م</p>
        ))}
      </section>
    </Screen>
  );
}
