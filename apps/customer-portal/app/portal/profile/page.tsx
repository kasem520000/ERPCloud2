'use client';

import { PortalShell, usePortalProfile } from '../../../components/portal-shell';
import { moneyText } from '../../../lib/format';

function Details() {
  const { profile } = usePortalProfile();
  const party = profile?.party;
  const company = profile?.company;

  return (
    <>
      <section>
        <h1>بياناتي</h1>
        <p className="muted">هذه هي البيانات المسجلة لك في دفاتر المورد. لتعديلها تواصل معه مباشرة — البوابة لا تعدّل البيانات الأساسية.</p>
      </section>

      <div className="grid cols">
        <section className="card">
          <h2>بطاقتي لدى المورد</h2>
          <table>
            <tbody>
              <tr>
                <td className="muted">الاسم</td>
                <td>{party?.name ?? '—'}</td>
              </tr>
              <tr>
                <td className="muted">رقم العميل</td>
                <td>{party?.code ?? '—'}</td>
              </tr>
              <tr>
                <td className="muted">الرقم الضريبي</td>
                <td>{party?.taxNo || '—'}</td>
              </tr>
              <tr>
                <td className="muted">الجوال</td>
                <td>{party?.phone || '—'}</td>
              </tr>
              <tr>
                <td className="muted">البريد</td>
                <td>{party?.email || '—'}</td>
              </tr>
              <tr>
                <td className="muted">حد الائتمان</td>
                <td>{moneyText(party?.creditLimit ?? '0')}</td>
              </tr>
              <tr>
                <td className="muted">الرصيد الحالي</td>
                <td>
                  <strong>{moneyText(profile?.balance ?? '0')}</strong>
                </td>
              </tr>
            </tbody>
          </table>
        </section>

        <section className="card">
          <h2>بيانات المورد</h2>
          <table>
            <tbody>
              <tr>
                <td className="muted">المنشأة</td>
                <td>{company?.nameAr || '—'}</td>
              </tr>
              <tr>
                <td className="muted">Company</td>
                <td>{company?.nameEn || '—'}</td>
              </tr>
              <tr>
                <td className="muted">الرقم الضريبي</td>
                <td>{company?.taxNo || '—'}</td>
              </tr>
              <tr>
                <td className="muted">البريد</td>
                <td>{company?.email ? <a href={`mailto:${company.email}`}>{company.email}</a> : '—'}</td>
              </tr>
              <tr>
                <td className="muted">الهواتف</td>
                <td>{company?.phones?.length ? company.phones.join(' · ') : '—'}</td>
              </tr>
            </tbody>
          </table>
        </section>
      </div>
    </>
  );
}

export default function ProfilePage() {
  return (
    <PortalShell>
      <Details />
    </PortalShell>
  );
}
