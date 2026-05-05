'use client';
// ============================================================
// Dashboard Layout — sidebar nav + auth guard
// ============================================================

import { useEffect } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import api from '@/lib/api';
import { useAuthStore } from '@/store/auth.store';

const NAV_LINKS = [
  { href: '/dashboard', label: 'Get Number',   icon: '📲' },
  { href: '/orders',    label: 'My Orders',    icon: '📦' },
  { href: '/wallet',    label: 'Wallet',        icon: '💳' },
];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router   = useRouter();
  const pathname = usePathname();
  const { user, setUser, setLoading, logout } = useAuthStore();

  // ── Auth guard — fetch profile on mount ──────────────────
  useEffect(() => {
    const token = localStorage.getItem('access_token');
    if (!token) { router.replace('/login'); return; }

    setLoading(true);
    api.get('/auth/me')
      .then((r) => setUser(r.data))
      .catch(() => { localStorage.removeItem('access_token'); router.replace('/login'); })
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="min-h-screen flex">
      {/* ── Sidebar ──────────────────────────────────────── */}
      <aside className="w-56 shrink-0 bg-surface-card border-r border-surface-border
                        flex flex-col fixed inset-y-0 left-0 z-20">
        {/* Logo */}
        <div className="px-5 py-5 border-b border-surface-border">
          <span className="text-lg font-bold text-primary-400">SMS SaaS</span>
        </div>

        {/* Nav links */}
        <nav className="flex-1 px-3 py-4 space-y-1">
          {NAV_LINKS.map((link) => {
            const active = pathname === link.href;
            return (
              <Link
                key={link.href}
                href={link.href}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  active
                    ? 'bg-primary-600/20 text-primary-400'
                    : 'text-slate-400 hover:bg-surface hover:text-slate-200'
                }`}
              >
                <span>{link.icon}</span>
                {link.label}
              </Link>
            );
          })}

          {/* Admin link — only shown to admins */}
          {user?.role === 'ADMIN' && (
            <Link
              href="/admin"
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                pathname === '/admin'
                  ? 'bg-yellow-500/20 text-yellow-400'
                  : 'text-slate-400 hover:bg-surface hover:text-slate-200'
              }`}
            >
              <span>🛡️</span> Admin
            </Link>
          )}
        </nav>

        {/* User info + logout */}
        <div className="px-4 py-4 border-t border-surface-border">
          {user && (
            <div className="mb-3">
              <p className="text-xs text-slate-500 truncate">{user.email}</p>
              <p className="text-xs text-primary-400 font-semibold mt-0.5">
                ${(user.balance / 100).toFixed(2)}
              </p>
            </div>
          )}
          <button
            onClick={logout}
            className="w-full text-left text-xs text-slate-500 hover:text-red-400 transition-colors"
          >
            → Sign out
          </button>
        </div>
      </aside>

      {/* ── Main content ─────────────────────────────────── */}
      <main className="flex-1 ml-56 min-h-screen bg-surface">
        {children}
      </main>
    </div>
  );
}
