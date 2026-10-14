'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { Notice } from '../../../components/data-view';
import { Screen } from '../../../components/screen';
import { ApiError } from '../../../lib/api';
import { listMentions, markMentionRead, type MentionRow } from '../../../lib/comments';

export default function CommentMentionsPage() {
  const [rows, setRows] = useState<MentionRow[]>([]);
  const [unreadOnly, setUnreadOnly] = useState(true);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'info' | 'warn'; text: string }>();

  async function reload() {
    try {
      setRows(await listMentions(unreadOnly));
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    }
  }

  useEffect(() => {
    void reload();
  }, [unreadOnly]);

  return (
    <Screen title="إشارات التعليقات" subtitle="من أشار إليك في فاتورة أو عميل أو موظف أو مشروع." crumbs={['الإعدادات', 'الإشارات']}>
      <Notice notice={notice} />
      <label className="field inline">
        <input type="checkbox" checked={unreadOnly} onChange={(event) => setUnreadOnly(event.target.checked)} />
        <span>غير المقروء فقط</span>
      </label>
      <div className="card">
        {rows.map((row) => (
          <article key={row.id} className="border-t py-2">
            <strong>{row.authorName}</strong>
            <p>{row.excerpt}</p>
            <div className="flex gap-2">
              <Link className="btn" href={row.href}>
                فتح المستند
              </Link>
              {!row.isRead ? (
                <button className="btn" type="button" onClick={() => void markMentionRead(row.id).then(reload)}>
                  تحديد كمقروء
                </button>
              ) : null}
            </div>
          </article>
        ))}
        {rows.length === 0 ? <p className="muted">لا إشارات.</p> : null}
      </div>
    </Screen>
  );
}
