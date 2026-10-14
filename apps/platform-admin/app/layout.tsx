import './globals.css';

import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { ThemeProvider, ThemeScript } from '@erp/ui';

import { AuthGate } from '../components/auth-gate';
import { SessionProvider } from '../lib/session';

export const metadata: Metadata = {
  title: 'لوحة تحكم المنصة — Cloud ERP',
  description: 'إدارة المنشآت والاشتراكات والتراخيص لمشغّلي المنصة',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="ar" dir="rtl" suppressHydrationWarning>
      <head>
        {/* Design v3 §2.1 — the console is dark-first. Same script, same single
            `erp.theme` key, only a different fallback. */}
        <ThemeScript defaultChoice="dark" />
      </head>
      <body>
        <ThemeProvider defaultChoice="dark">
          <SessionProvider>
            <AuthGate>{children}</AuthGate>
          </SessionProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
