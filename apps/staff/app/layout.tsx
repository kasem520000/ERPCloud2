import './globals.css';

import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { ThemeProvider, ThemeScript, ToastProvider } from '@erp/ui';

import { AuthGate } from '../components/auth-gate';
import { TokenBridge } from '../components/token-bridge';
import { LanguageProvider } from '../lib/i18n';
import { SessionProvider } from '../lib/session';
import { ServiceWorkerRegister } from '../components/service-worker-register';

export const metadata: Metadata = {
  title: 'Cloud ERP — لوحة التحكم',
  description: 'نظام محاسبي سحابي متعدد المنشآت',
  manifest: '/manifest.webmanifest',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="ar" dir="rtl" suppressHydrationWarning>
      <head>
        {/* Design v3 §2.2.3 — paints `html.dark` before React hydrates, so a
            visitor in dark mode never sees a white flash. */}
        <ThemeScript defaultChoice="system" />
      </head>
      <body>
        <ThemeProvider defaultChoice="system">
          <LanguageProvider>
          <SessionProvider>
            <TokenBridge />
            <ServiceWorkerRegister />
            <ToastProvider>
              <AuthGate>{children}</AuthGate>
            </ToastProvider>
          </SessionProvider>
        </LanguageProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
