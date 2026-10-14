import './globals.css';

import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { TokenBridge } from '../components/token-bridge';

export const metadata: Metadata = { title: 'بوابة العملاء', description: 'بوابة العملاء — الفواتير وكشف الحساب والمدفوعات' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="ar" dir="rtl"><body><TokenBridge /><div className="wrap"><header className="top"><Link className="brand" href="/portal"><span className="logo">ERP</span><span>بوابة العملاء</span></Link><nav className="nav" aria-label="portal navigation"><Link className="btn primary" href="/auth/login">دخول</Link></nav></header><main style={{ marginTop: 18 }}>{children}</main></div></body></html>;
}
