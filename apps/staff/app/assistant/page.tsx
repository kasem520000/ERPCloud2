'use client';

import Link from 'next/link';

import { AssistantChat } from '../../components/assistant-chat';
import { Screen } from '../../components/screen';
import { useSession } from '../../lib/session';

export default function AssistantPage() {
  const { can } = useSession();
  return (
    <Screen
      title="المساعد المحاسبي"
      subtitle="يجيب من مجاميع منشأتك ودليل الشاشات. التنبيهات اليومية ومحادثاتك السابقة تظهر هنا. لا يرحّل قيوداً، ولا يرسل رواتب أو أرقام هوية."
      crumbs={['المساعد']}
      actions={can('ai.settings.manage') ? <Link className="btn" href="/settings/ai">الإعدادات</Link> : undefined}
    >
      <section className="card">
        <AssistantChat />
      </section>
    </Screen>
  );
}
