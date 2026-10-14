'use client';

import { NotificationInbox } from '../../components/notification-bell';
import { Screen } from '../../components/screen';
import { useLang } from '../../lib/i18n';

/**
 * مركز الإشعارات — شاشة المستأجر التي يطلبها P-C7 (`docs/roadmap/PLATFORM_CONSOLE_PLAN.md`
 * §4: «مركز إشعارات في staff: جرس + شاشة»، بلا نقاط نهاية جديدة: يستهلك `/notifications`
 * القائم).
 *
 * لا مقابل لها في `Desktop_ERP`: النسخة المكتبية تُظهر التنبيهات في نافذةٍ عابرة
 * (`frmNotification.xaml`-style popups) ولا تُبقي صندوقاً دائماً لكل عضويّة؛ وهذا الصندوق
 * يُبنى على جدول `notifications` القائم (0001) الموجَّه للعضويّة، والإعلان يكتب فيه عبر
 * `NotificationsService` نفسه.
 *
 * ولغة العرض تتبع لغة الواجهة: الإعلان يحمل نصّين (ar/en) لأن المشغّل يكتبهما معاً
 * (قرار P-C7 في `packages/contracts/src/platform/announcements.ts`)، فلا ترجمة آليّة هنا.
 */
export default function NotificationsPage() {
  const { lang, t } = useLang();

  return (
    <Screen
      title={lang === 'ar' ? 'مركز الإشعارات' : 'Notification centre'}
      subtitle={
        lang === 'ar'
          ? 'كل ما وصلك: إعلانات المنصة وإشعارات النظام، مرتّبةً بالأحدث، مع وسم المقروء. الرقم في الجرس هو عدد غير المقروء في هذه الصفحة نفسها.'
          : 'Everything addressed to you: platform announcements and system notifications, newest first, with read-marking. The bell shows the same unread count this screen shows.'
      }
      crumbs={[t('nav.settings'), lang === 'ar' ? 'الإشعارات' : 'Notifications']}
    >
      <NotificationInbox locale={lang} />
    </Screen>
  );
}
