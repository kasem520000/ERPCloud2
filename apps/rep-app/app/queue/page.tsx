'use client';

import { useState } from 'react';
import { useSession } from '@erp/web-core/session';

import { Empty, Forbidden, Loading, Screen } from '../../components/screen';
import { useOfflineRead } from '../../components/offline-data';
import { useLang } from '../../lib/i18n';
import { useQuery } from '../../lib/use-query';
import { fetchServerQueue, readQueueBoard, retryConflict, runSyncCycle } from '../../lib/offline/rep-sync';

/**
 * M5 — the queue + the conflict inbox: this device's records (pending/synced/conflict,
 * each conflict with the server's errorCode/message/resolution hint and an explicit
 * retry), and the server-side queue rows (the sync log the M4 endpoint exposes).
 */
export default function QueuePage() {
  const { can } = useSession();
  const { t } = useLang();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const board = useOfflineRead(readQueueBoard);
  const serverQueue = useQuery(fetchServerQueue, []);

  async function retry(offlineId: string): Promise<void> {
    await retryConflict(offlineId);
    board.reload();
  }

  async function syncNow(): Promise<void> {
    setBusy(true);
    setMessage(undefined);
    try {
      const cycle = await runSyncCycle();
      setMessage(
        cycle.error
          ? cycle.error
          : cycle.push
            ? `${cycle.push.processed} → ${cycle.push.synced} ✅ / ${cycle.push.conflicts} ⚠`
            : t('sync.pullDone'),
      );
    } finally {
      setBusy(false);
      board.reload();
      serverQueue.reload();
    }
  }

  if (!can('van_sales.view')) return <Forbidden />;

  const records = board.data?.records ?? [];

  return (
    <Screen
      title={t('queue.title')}
      subtitle={t('home.offlineHint')}
      actions={
        <button type="button" className="btn primary" disabled={busy} onClick={() => void syncNow()}>
          {busy ? t('sync.working') : t('queue.syncNow')}
        </button>
      }
    >
      {message ? (
        <div className="card tight" role="status">
          {message}
        </div>
      ) : null}

      {board.loading ? (
        <Loading rows={3} />
      ) : records.length === 0 ? (
        <Empty hint={t('queue.empty')} />
      ) : (
        <div className="grid">
          {records.map((record) => (
            <div key={record.offlineId} className="card tight">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <strong>
                  {t(`op.${record.operation}`)}
                  {record.documentNumber ? ` · ${record.documentNumber}` : ''}
                </strong>
                <span className={`badge ${record.status}`}>{t(`queue.${record.status}`)}</span>
              </div>
              <span className="muted small" style={{ display: 'block' }}>
                {new Date(record.createdAt).toLocaleString()} · #{record.sequenceNo}
              </span>
              {record.total ? (
                <span className="small" style={{ display: 'block' }}>
                  {record.total}
                </span>
              ) : null}
              {record.status === 'conflict' ? (
                <div className="card tight" style={{ boxShadow: 'none', borderColor: 'var(--color-danger)', marginTop: '8px' }}>
                  <strong className="small" style={{ color: 'var(--danger)' }}>
                    {record.errorCode}
                  </strong>
                  <p className="small" style={{ margin: '4px 0' }}>
                    {record.message}
                  </p>
                  {record.resolution ? (
                    <p className="muted small" style={{ margin: 0 }}>
                      {JSON.stringify(record.resolution)}
                    </p>
                  ) : null}
                  <button type="button" className="btn sm" style={{ marginTop: '8px' }} onClick={() => void retry(record.offlineId)}>
                    {t('queue.retry')}
                  </button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <strong>{t('queue.serverInbox')}</strong>
        {serverQueue.status === 'loading' ? (
          <Loading rows={2} />
        ) : serverQueue.status === 'error' ? (
          <p className="muted small" style={{ margin: '6px 0 0' }}>
            {serverQueue.error}
          </p>
        ) : (serverQueue.data ?? []).length === 0 ? (
          <p className="muted small" style={{ margin: '6px 0 0' }}>
            {t('queue.empty')}
          </p>
        ) : (
          <div className="table-wrap" style={{ marginTop: '10px' }}>
            <table>
              <thead>
                <tr>
                  <th>offlineId</th>
                  <th>op</th>
                  <th>status</th>
                  <th>errorCode</th>
                </tr>
              </thead>
              <tbody>
                {(serverQueue.data ?? []).map((row) => (
                  <tr key={row.id}>
                    <td className="num">{row.offlineId}</td>
                    <td>{row.operation}</td>
                    <td>
                      <span className={`badge ${row.status === 'synced' ? 'synced' : row.status === 'conflict' ? 'conflict' : 'pending'}`}>{row.status}</span>
                    </td>
                    <td>{row.errorCode ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Screen>
  );
}
