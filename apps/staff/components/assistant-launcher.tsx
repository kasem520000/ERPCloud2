'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';

import { useSession } from '../lib/session';

import { AssistantChat } from './assistant-chat';

/** Floating assistant on every staff screen. Hidden without `ai.assistant.use`. */
export function AssistantLauncher() {
  const pathname = usePathname();
  const { can } = useSession();
  const [open, setOpen] = useState(false);
  if (!can('ai.assistant.use') || pathname === '/assistant') return null;

  return (
    <>
      {open ? (
        <aside className="assistant-drawer card" aria-label="المساعد المحاسبي">
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <strong>المساعد المحاسبي</strong>
            <div className="row">
              <Link className="btn" href="/assistant" onClick={() => setOpen(false)}>
                توسيع
              </Link>
              <button className="btn" type="button" onClick={() => setOpen(false)} aria-label="إغلاق المساعد">
                إغلاق
              </button>
            </div>
          </div>
          <AssistantChat compact />
        </aside>
      ) : null}
      <button className="assistant-fab btn primary" type="button" onClick={() => setOpen((value) => !value)}>
        💬 مساعد
      </button>
    </>
  );
}
