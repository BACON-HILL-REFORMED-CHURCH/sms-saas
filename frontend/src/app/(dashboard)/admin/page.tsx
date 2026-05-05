'use client';
// ============================================================
// Admin Panel — Stats + Users + Balance Adjust + Pricing
// ============================================================

import { useEffect, useState } from 'react';
import api from '@/lib/api';

// ── Types ──────────────────────────────────────────────────
interface Stats {
  totalUsers: number;
  totalOrders: number;
  pendingOrders: number;
  totalRevenueFormatted: string;
}

interface AdminUser {
  id: string;
  email: string;
  role: string;
  balanceFormatted: string;
  isEmailVerified: boolean;
  createdAt: string;
  _count: { orders: number };
}

type Tab = 'stats' | 'users' | 'pricing' | 'logs';

// ── Stat Card ──────────────────────────────────────────────
function StatCard({ label, value, icon }: { label: string; value: string | number; icon: string }) {
  return (
    <div className="card flex items-center gap-4">
      <span className="text-3xl">{icon}</span>
      <div>
        <p className="text-slate-400 text-xs">{label}</p>
        <p className="text-2xl font-bold text-slate-100">{value}</p>
      </div>
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────
export default function AdminPage() {
  const [tab, setTab]           = useState<Tab>('stats');
  const [stats, setStats]       = useState<Stats | null>(null);
  const [users, setUsers]       = useState<AdminUser[]>([]);
  const [search, setSearch]     = useState('');
  const [logs, setLogs]         = useState<any[]>([]);
  const [pricing, setPricing]   = useState<any[]>([]);

  // Adjust balance form
  const [adjUserId, setAdjUserId]   = useState('');
  const [adjAmount, setAdjAmount]   = useState('');
  const [adjReason, setAdjReason]   = useState('');
  const [adjMsg, setAdjMsg]         = useState('');
  const [adjErr, setAdjErr]         = useState('');

  // Pricing form
  const [pService,  setPService]    = useState('');
  const [pCountry,  setPCountry]    = useState('us');
  const [pProvider, setPProvider]   = useState('mock');
  const [pMargin,   setPMargin]     = useState('30');
  const [pMsg,      setPMsg]        = useState('');

  useEffect(() => {
    fetchStats();
    fetchUsers();
    fetchLogs();
    fetchPricing();
  }, []);

  async function fetchStats() {
    try { const r = await api.get('/admin/stats'); setStats(r.data); } catch {}
  }
  async function fetchUsers(q = '') {
    try {
      const r = await api.get(`/admin/users?limit=30${q ? `&search=${q}` : ''}`);
      setUsers(r.data.users);
    } catch {}
  }
  async function fetchLogs() {
    try { const r = await api.get('/admin/logs?limit=30'); setLogs(r.data.logs); } catch {}
  }
  async function fetchPricing() {
    try { const r = await api.get('/admin/pricing'); setPricing(r.data); } catch {}
  }

  // ── Adjust balance ────────────────────────────────────────
  async function handleAdjust(e: React.FormEvent) {
    e.preventDefault();
    setAdjMsg(''); setAdjErr('');
    try {
      const r = await api.post('/admin/balance/adjust', {
        userId: adjUserId,
        amount: Math.round(parseFloat(adjAmount) * 100),
        reason: adjReason,
      });
      setAdjMsg(`✅ Done — new balance: ${r.data.newBalanceFormatted}`);
      fetchUsers();
      setAdjAmount(''); setAdjReason('');
    } catch (err: any) {
      setAdjErr(err.response?.data?.message ?? 'Failed');
    }
  }

  // ── Set pricing ───────────────────────────────────────────
  async function handlePricing(e: React.FormEvent) {
    e.preventDefault();
    setPMsg('');
    try {
      await api.post('/admin/pricing', {
        service: pService, country: pCountry,
        provider: pProvider, marginPercent: parseInt(pMargin),
      });
      setPMsg('✅ Pricing updated');
      fetchPricing();
    } catch (err: any) {
      setPMsg(`❌ ${err.response?.data?.message ?? 'Failed'}`);
    }
  }

  const TABS: { key: Tab; label: string; icon: string }[] = [
    { key: 'stats',   label: 'Stats',   icon: '📊' },
    { key: 'users',   label: 'Users',   icon: '👥' },
    { key: 'pricing', label: 'Pricing', icon: '💲' },
    { key: 'logs',    label: 'Logs',    icon: '📋' },
  ];

  return (
    <div className="max-w-6xl mx-auto px-4 py-8 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-slate-100">Admin Panel</h1>
        <p className="text-slate-500 text-sm mt-0.5">Platform management</p>
      </div>

      {/* Tab bar */}
      <div className="flex gap-2 border-b border-surface-border pb-1">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 rounded-t-lg text-sm font-medium transition-colors ${
              tab === t.key
                ? 'bg-primary-600 text-white'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {/* ── Stats tab ─────────────────────────────────────── */}
      {tab === 'stats' && stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard label="Total Users"   value={stats.totalUsers}             icon="👤" />
          <StatCard label="Total Orders"  value={stats.totalOrders}            icon="📦" />
          <StatCard label="Pending"       value={stats.pendingOrders}          icon="⏳" />
          <StatCard label="Revenue"       value={stats.totalRevenueFormatted}  icon="💰" />
        </div>
      )}

      {/* ── Users tab ─────────────────────────────────────── */}
      {tab === 'users' && (
        <div className="space-y-6">
          {/* Search */}
          <div className="flex gap-3">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && fetchUsers(search)}
              placeholder="Search by email…"
              className="input-field max-w-xs"
            />
            <button onClick={() => fetchUsers(search)} className="btn-primary">Search</button>
          </div>

          {/* Users table */}
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-slate-400 border-b border-surface-border">
                  <th className="text-left pb-3 font-medium">Email</th>
                  <th className="text-left pb-3 font-medium">Role</th>
                  <th className="text-left pb-3 font-medium">Balance</th>
                  <th className="text-left pb-3 font-medium">Orders</th>
                  <th className="text-left pb-3 font-medium">Verified</th>
                  <th className="text-left pb-3 font-medium">Joined</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border">
                {users.map((u) => (
                  <tr key={u.id} className="hover:bg-surface/50">
                    <td className="py-3 text-slate-200 font-mono text-xs">{u.email}</td>
                    <td className="py-3">
                      <span className={u.role === 'ADMIN' ? 'badge-pending' : 'badge-received'}>
                        {u.role}
                      </span>
                    </td>
                    <td className="py-3 text-green-400 font-semibold">{u.balanceFormatted}</td>
                    <td className="py-3 text-slate-300">{u._count.orders}</td>
                    <td className="py-3">{u.isEmailVerified ? '✅' : '❌'}</td>
                    <td className="py-3 text-slate-500 text-xs">
                      {new Date(u.createdAt).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Balance adjust form */}
          <div className="card">
            <h3 className="font-semibold text-slate-100 mb-4">⚙️ Adjust Balance</h3>
            <form onSubmit={handleAdjust} className="grid grid-cols-1 sm:grid-cols-4 gap-3">
              <input value={adjUserId} onChange={(e) => setAdjUserId(e.target.value)}
                placeholder="User ID (UUID)" className="input-field sm:col-span-2" required />
              <input value={adjAmount} onChange={(e) => setAdjAmount(e.target.value)}
                placeholder="Amount $  (negative=debit)" type="number" step="0.01" className="input-field" required />
              <input value={adjReason} onChange={(e) => setAdjReason(e.target.value)}
                placeholder="Reason (optional)" className="input-field" />
              <button type="submit" className="btn-primary sm:col-span-4">Apply Adjustment</button>
            </form>
            {adjMsg && <p className="text-green-400 text-sm mt-3">{adjMsg}</p>}
            {adjErr && <p className="text-red-400 text-sm mt-3">{adjErr}</p>}
          </div>
        </div>
      )}

      {/* ── Pricing tab ───────────────────────────────────── */}
      {tab === 'pricing' && (
        <div className="space-y-6">
          {/* Set pricing form */}
          <div className="card">
            <h3 className="font-semibold text-slate-100 mb-4">Set Margin</h3>
            <form onSubmit={handlePricing} className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              <input value={pService}  onChange={(e) => setPService(e.target.value)}
                placeholder="Service (telegram)" className="input-field" required />
              <select value={pCountry} onChange={(e) => setPCountry(e.target.value)} className="input-field">
                {['us','ru','gb','de','fr','any'].map((c) => (
                  <option key={c} value={c}>{c.toUpperCase()}</option>
                ))}
              </select>
              <input value={pProvider} onChange={(e) => setPProvider(e.target.value)}
                placeholder="Provider" className="input-field" required />
              <input value={pMargin}   onChange={(e) => setPMargin(e.target.value)}
                placeholder="Margin %" type="number" min="0" max="500" className="input-field" required />
              <button type="submit" className="btn-primary">Save</button>
            </form>
            {pMsg && <p className="text-sm mt-3 text-slate-300">{pMsg}</p>}
          </div>

          {/* Pricing table */}
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-slate-400 border-b border-surface-border">
                  {['Service','Country','Provider','Margin %','Active'].map((h) => (
                    <th key={h} className="text-left pb-3 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border">
                {pricing.map((p: any) => (
                  <tr key={p.id}>
                    <td className="py-2 text-slate-200">{p.service}</td>
                    <td className="py-2 text-slate-300">{p.country.toUpperCase()}</td>
                    <td className="py-2 text-slate-300">{p.provider}</td>
                    <td className="py-2 text-primary-400 font-semibold">{p.marginPercent}%</td>
                    <td className="py-2">{p.isActive ? '✅' : '❌'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {pricing.length === 0 && (
              <p className="text-slate-500 text-sm text-center py-6">No custom pricing set</p>
            )}
          </div>
        </div>
      )}

      {/* ── Logs tab ──────────────────────────────────────── */}
      {tab === 'logs' && (
        <div className="card">
          <h3 className="font-semibold text-slate-100 mb-4">Audit Logs</h3>
          <div className="space-y-2 max-h-[600px] overflow-y-auto">
            {logs.map((log: any) => (
              <div key={log.id} className="flex items-start gap-3 bg-surface rounded-lg p-3 border border-surface-border">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="badge-pending text-xs">{log.action}</span>
                    <span className="text-slate-500 text-xs">
                      {new Date(log.createdAt).toLocaleString()}
                    </span>
                  </div>
                  {log.details && (
                    <pre className="text-slate-400 text-xs mt-1 overflow-x-auto">
                      {JSON.stringify(log.details, null, 2)}
                    </pre>
                  )}
                </div>
              </div>
            ))}
            {logs.length === 0 && (
              <p className="text-slate-500 text-sm text-center py-6">No logs yet</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
