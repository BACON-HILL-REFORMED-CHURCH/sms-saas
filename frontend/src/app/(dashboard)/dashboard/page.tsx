'use client';
// ============================================================
// Dashboard Page — service selector + active order tracker
// ============================================================

import { useEffect, useState, useCallback } from 'react';
import api from '@/lib/api';

// ── Types ──────────────────────────────────────────────────
interface Service {
  name: string;
  displayName: string;
  price: number;  // cents
  count: number;
}

interface Order {
  id: string;
  phoneNumber: string;
  service: string;
  status: 'PENDING' | 'RECEIVED' | 'CANCELED' | 'EXPIRED';
  smsCode: string | null;
  smsFullText: string | null;
  price: number;
  createdAt: string;
}

const COUNTRY_OPTIONS = [
  { value: 'us', label: '🇺🇸 United States' },
  { value: 'ru', label: '🇷🇺 Russia' },
  { value: 'gb', label: '🇬🇧 United Kingdom' },
  { value: 'de', label: '🇩🇪 Germany' },
  { value: 'fr', label: '🇫🇷 France' },
  { value: 'any', label: '🌍 Any Country' },
];

const STATUS_BADGE: Record<string, string> = {
  PENDING:  'badge-pending',
  RECEIVED: 'badge-received',
  CANCELED: 'badge-canceled',
  EXPIRED:  'badge-canceled',
};

export default function DashboardPage() {
  const [services, setServices]       = useState<Service[]>([]);
  const [country, setCountry]         = useState('us');
  const [selected, setSelected]       = useState<string | null>(null);
  const [balance, setBalance]         = useState('—');
  const [activeOrders, setActiveOrders] = useState<Order[]>([]);
  const [creating, setCreating]       = useState(false);
  const [error, setError]             = useState('');

  // ── Load services + balance on mount ─────────────────────
  useEffect(() => {
    fetchBalance();
    fetchServices(country);
  }, [country]);

  // ── Auto-poll active orders every 5s ─────────────────────
  useEffect(() => {
    const interval = setInterval(fetchActiveOrders, 5_000);
    fetchActiveOrders();
    return () => clearInterval(interval);
  }, []);

  async function fetchBalance() {
    try {
      const res = await api.get('/wallet/balance');
      setBalance(res.data.balanceFormatted);
    } catch {}
  }

  async function fetchServices(c: string) {
    try {
      const res = await api.get(`/providers/services?country=${c}`);
      // Flatten services from all providers, dedupe by name
      const allServices: Service[] = Object.values(res.data).flat() as Service[];
      const seen = new Set<string>();
      const unique = allServices.filter((s) => {
        if (seen.has(s.name)) return false;
        seen.add(s.name);
        return true;
      });
      setServices(unique.sort((a, b) => a.displayName.localeCompare(b.displayName)));
    } catch {}
  }

  const fetchActiveOrders = useCallback(async () => {
    try {
      const res = await api.get('/orders?status=PENDING&limit=10');
      setActiveOrders(res.data.orders ?? []);
    } catch {}
  }, []);

  // ── Create order ──────────────────────────────────────────
  async function handleOrder() {
    if (!selected) return;
    setCreating(true);
    setError('');
    try {
      await api.post('/orders', { service: selected, country, provider: 'mock' });
      await fetchActiveOrders();
      await fetchBalance();
      setSelected(null);
    } catch (err: any) {
      setError(err.response?.data?.message ?? 'Failed to create order');
    } finally {
      setCreating(false);
    }
  }

  // ── Cancel order ──────────────────────────────────────────
  async function handleCancel(orderId: string) {
    try {
      await api.delete(`/orders/${orderId}`);
      await fetchActiveOrders();
      await fetchBalance();
    } catch (err: any) {
      setError(err.response?.data?.message ?? 'Cancel failed');
    }
  }

  const selectedService = services.find((s) => s.name === selected);

  return (
    <div className="max-w-5xl mx-auto px-4 py-8 space-y-8">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">Get a Number</h1>
          <p className="text-slate-400 text-sm mt-0.5">Select a service and receive SMS instantly</p>
        </div>
        <div className="text-right">
          <p className="text-xs text-slate-500">Balance</p>
          <p className="text-xl font-bold text-primary-400">{balance}</p>
        </div>
      </div>

      {/* Country selector */}
      <div className="card">
        <label className="block text-sm font-medium text-slate-300 mb-2">Country</label>
        <div className="flex flex-wrap gap-2">
          {COUNTRY_OPTIONS.map((c) => (
            <button
              key={c.value}
              onClick={() => setCountry(c.value)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                country === c.value
                  ? 'bg-primary-600 text-white'
                  : 'bg-surface border border-surface-border text-slate-300 hover:border-primary-500'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

      {/* Service grid */}
      <div className="card">
        <h2 className="text-lg font-semibold text-slate-100 mb-4">Choose a Service</h2>
        {services.length === 0 ? (
          <p className="text-slate-500 text-sm">Loading services…</p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {services.map((svc) => (
              <button
                key={svc.name}
                onClick={() => setSelected(svc.name === selected ? null : svc.name)}
                className={`p-3 rounded-xl border text-left transition-all ${
                  selected === svc.name
                    ? 'border-primary-500 bg-primary-600/10'
                    : 'border-surface-border hover:border-slate-500'
                }`}
              >
                <p className="font-medium text-slate-100 text-sm">{svc.displayName}</p>
                <p className="text-primary-400 text-xs mt-0.5">${(svc.price / 100).toFixed(2)}</p>
                <p className="text-slate-500 text-xs">{svc.count} available</p>
              </button>
            ))}
          </div>
        )}

        {/* Order button */}
        {selected && (
          <div className="mt-5 pt-5 border-t border-surface-border flex items-center justify-between">
            <div>
              <p className="text-slate-300 text-sm">
                <span className="font-semibold text-slate-100">{selectedService?.displayName}</span>
                {' '}· {COUNTRY_OPTIONS.find((c) => c.value === country)?.label}
              </p>
              <p className="text-primary-400 text-sm font-semibold mt-0.5">
                ${((selectedService?.price ?? 0) / 100).toFixed(2)}
              </p>
            </div>
            <button
              onClick={handleOrder}
              disabled={creating}
              className="btn-primary px-6"
            >
              {creating ? 'Getting number…' : 'Get Number →'}
            </button>
          </div>
        )}

        {error && (
          <div className="mt-4 bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3">
            <p className="text-red-400 text-sm">{error}</p>
          </div>
        )}
      </div>

      {/* Active orders */}
      {activeOrders.length > 0 && (
        <div className="card">
          <h2 className="text-lg font-semibold text-slate-100 mb-4">
            Active Orders
            <span className="ml-2 text-xs text-slate-500 font-normal">auto-refreshing every 5s</span>
          </h2>
          <div className="space-y-3">
            {activeOrders.map((order) => (
              <div key={order.id} className="flex items-center justify-between bg-surface rounded-xl p-4 border border-surface-border">
                <div>
                  <div className="flex items-center gap-2">
                    <p className="font-mono text-slate-100 text-sm">{order.phoneNumber}</p>
                    <span className={STATUS_BADGE[order.status]}>{order.status}</span>
                  </div>
                  <p className="text-slate-500 text-xs mt-0.5 capitalize">{order.service}</p>
                  {order.smsCode && (
                    <p className="mt-2 text-lg font-bold text-green-400 font-mono">
                      Code: {order.smsCode}
                    </p>
                  )}
                </div>
                {order.status === 'PENDING' && (
                  <button
                    onClick={() => handleCancel(order.id)}
                    className="text-red-400 hover:text-red-300 text-xs border border-red-500/30 px-3 py-1.5 rounded-lg"
                  >
                    Cancel
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
