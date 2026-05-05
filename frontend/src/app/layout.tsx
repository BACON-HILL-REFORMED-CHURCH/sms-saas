// ============================================================
// Root Layout — dark mode by default, Inter font
// ============================================================

import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'SMS SaaS — Virtual Phone Numbers',
  description: 'Receive SMS online with virtual phone numbers. Fast, cheap, reliable.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="bg-surface text-slate-100 antialiased font-sans min-h-screen">
        {children}
      </body>
    </html>
  );
}
