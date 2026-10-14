'use client';

import { useEffect, useState } from 'react';

import { apiData } from '../../../lib/api';

type Slip = { period: string; net: string };
type Leave = { id: string; status: string; starts_on: string | null; ends_on: string | null; reason: string };
type Custody = { id: string; reason: string };

export default function EmployeeProfilePage() {
  const [slips, setSlips] = useState<Slip[]>([]);
  const [leaves, setLeaves] = useState<Leave[]>([]);
  const [custodies, setCustodies] = useState<Custody[]>([]);

  useEffect(() => {
    void Promise.all([
      apiData<Slip[]>('/employee/payslips').catch(() => []),
      apiData<Leave[]>('/employee/leaves').catch(() => []),
      apiData<Custody[]>('/employee/custodies').catch(() => []),
    ]).then(([nextSlips, nextLeaves, nextCustodies]) => {
      setSlips(Array.isArray(nextSlips) ? nextSlips : []);
      setLeaves(Array.isArray(nextLeaves) ? nextLeaves : []);
      setCustodies(Array.isArray(nextCustodies) ? nextCustodies : []);
    });
  }, []);

  return (
    <section className="employee-card">
      <h1>حسابي</h1>
      <h2>كشف الراتب</h2>
      {slips.length === 0 ? <p>لا كشوف بعد.</p> : slips.map((slip) => <p key={slip.period}>{slip.period}: {slip.net}</p>)}
      <h2>إجازاتي</h2>
      {leaves.length === 0 ? <p>لا طلبات إجازة.</p> : leaves.map((leave) => (
        <p key={leave.id}>{leave.starts_on} — {leave.status} — {leave.reason}</p>
      ))}
      <h2>عهدي</h2>
      {custodies.length === 0 ? <p>لا عهد معتمدة.</p> : custodies.map((row) => <p key={row.id}>{row.reason}</p>)}
    </section>
  );
}
