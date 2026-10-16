'use client';

import { useState } from 'react';
import { useSession } from '@erp/web-core/session';

import { Forbidden, Screen } from '../../components/screen';
import { useOfflineRead } from '../../components/offline-data';
import { useLang } from '../../lib/i18n';
import { getOrCreateDeviceId, offlineCounts, readMetaBundle, saveSnapshot } from '../../lib/offline/rep-db';
import { fetchSnapshot, runSyncCycle } from '../../lib/offline/rep-sync';

/**
 * M5 — sync management: the device's state (watermark, last pull, what is on the
 * phone), an explicit delta pull, and a full snapshot re-pull (the recovery path when
 * the local data looks wrong — `saveSnapshot` clears and rebuilds every store).
 */
export default function SyncPage() {
  const { can } = useSession();
  const { t } = useLang();
  const [busy, setBusy] = useState<'delta' | 'snapshot' | undefined>(undefined);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const meta = useOfflineRead(readMetaBundle);
  const counts = useOfflineRead(offlineCounts);
  const deviceId = useOfflineRead(getOrCreateDeviceId);

  async function pull(kind: 'delta' | 'snapshot'): Promise<void> {
    setBusy(kind);
    setError(undefined);
    setMessage(undefined);
    try {
      if (kind === 'snapshot') {
        const snapshot = await fetchSnapshot();
        await saveSnapshot(snapshot);
        setMessage(`${t('sync.pullDone')} (${snapshot.customers.length} ${t('nav.customers')})`);
      } else {
        const cycle = await runSyncCycle();
        if (cycle.error) setError(cycle.error);
        else
          setMessage(
            cycle.push
              ? `${t('sync.pullDone')} · ${cycle.push.synced} ✅ / ${cycle.push.conflicts} ⚠`
              : t('sync.pullDone'),
          );
      }
      meta.reload();
      counts.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(undefined);
    }
  }

  if (!can('van_sales.view')) return <Forbidden />;

  return (
    <Screen title={t('sync.title')} subtitle={t('home.offlineHint')}>
      {message ? (
        <div className="card tight" role="status">
          {message}
        </div>
      ) : null}
      {error ? (
        <div className="card tight" role="alert" style={{ borderColor: 'var(--color-danger)' }}>
          {error}
        </div>
      ) : null}

      <div className="card">
        <strong>{t('sync.status')}</strong>
        <table style={{ marginTop: '10px' }}>
          <tbody>
            <tr>
              <td>{t('sync.deviceId')}</td>
              <td className="num">{deviceId.data ?? '—'}</td>
            </tr>
            <tr>
              <td>{t('sync.watermark')}</td>
              <td className="num">{meta.data?.watermark ?? '—'}</td>
            </tr>
            <tr>
              <td>{t('sync.snapshotAt')}</td>
              <td className="num">{meta.data?.snapshotAt ? new Date(meta.data.snapshotAt).toLocaleString() : '—'}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="card">
        <strong>{t('sync.counts')}</strong>
        <div className="row" style={{ marginTop: '10px' }}>
          {Object.entries(counts.data ?? {}).map(([store, count]) => (
            <span key={store} className="badge">
              {store}: {count}
            </span>
          ))}
        </div>
      </div>

      <div className="row">
        <button type="button" className="btn primary" disabled={busy !== undefined} onClick={() => void pull('delta')}>
          {busy === 'delta' ? t('sync.working') : t('sync.pull')}
        </button>
        <button type="button" className="btn" disabled={busy !== undefined} onClick={() => void pull('snapshot')}>
          {busy === 'snapshot' ? t('sync.working') : t('sync.snapshot')}
        </button>
      </div>
    </Screen>
  );
}
