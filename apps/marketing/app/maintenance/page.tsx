import type { Metadata } from 'next';

import { MaintenanceView } from '../../components/site/views';
import { staticMetadata } from '../../lib/meta';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  return staticMetadata({ locale: 'ar', path: '/maintenance', titleKey: 'maintenance.title' });
}

export default function MaintenancePage() {
  return <MaintenanceView locale="ar" />;
}
