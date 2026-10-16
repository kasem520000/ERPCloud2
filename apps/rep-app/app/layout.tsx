import './globals.css';

import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { ThemeProvider, ThemeScript, ToastProvider } from '@erp/ui';
import { SessionProvider } from '@erp/web-core/session';

import { AuthGate } from '../components/auth-gate';
import { ServiceWorkerRegister } from '../components/service-worker-register';
import { LanguageProvider } from '../lib/i18n';

export const metadata: Metadata = {
  title: 'Cloud ERP — تطبيق المندوب',
  description: 'واجهة مندوب التوزيع: بيع وتحصيل ومرتجع وإغلاق وردية — بلا اتصال أولًا، ومزامنة عبر محركات النظام',
  manifest: '/manifest.webmanifest',
  icons: { icon: '/icon.svg' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#059669',
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="ar" dir="rtl" suppressHydrationWarning>
      <head>
        {/* Design v3 §2.2.3 — paints `html.dark` before React hydrates. */}
        <ThemeScript defaultChoice="system" />
      </head>
      <body>
        <ThemeProvider defaultChoice="system">
          <LanguageProvider>
            <SessionProvider>
              <ToastProvider>
                <AuthGate>{children}</AuthGate>
                <ServiceWorkerRegister />
              </ToastProvider>
            </SessionProvider>
          </LanguageProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
