'use client';
// ============================================================
// Orders Page — full order history with status filter
// ============================================================

import { useEffect, useState, useCallback } from 'react';
import api from '@/lib/api';

interface Order {
  id: string;
  phoneNumber: string;
  service: string;
  country: string;
  status: 'PENDING' | 'RECEIVED' | 'CANCELED' | 'EXPIRED';
  smsCode: string | null;
  smsFullText: string | null;
  price: number;
  provider: string;
  createdAt: string;
}

interface Meta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

const STATUS_FILTERS = ['ALL', 'PENDING', 'RECEIVED', 'CANCELED', 'EXPIRED'];

const STATUS_BADGE: Record<string, string> = {
  PENDING:  'badge-pending',
  RECEIVED: 'badge-received',
  CANCELED: 'badge-canceled',
  EXPIRED:  'badge-canceled',
};

const STATUS_ICON: Record<string, string> = {
  PENDING:  '⏳',
  RECEIVED: '✅',
  CANCELED: '❌',
  EXPIRED:  '⌛',
};

export default function OrdersPage() {
  const [orders, setOrders]       = useState<Order[]>([]);
  const [meta, setMeta]           = useState<Meta | null>(null);
  const [statusFilter, setFilter] = useState('ALL');
  const [page, setPage]           = useState(1);
  const [loading, setLoading]     = useState(true);
  const [canceling, setCanceling] = useState<string | null>(null);

  const fetchOrders = useCallback(async () => {
    setLoading(true);
    try {
      const statusParam = statusFilter !== 'ALL' ? `&status=${statusFilter}` : '';
      const res = await api.get(`/orders?page=${page}&limit=15${statusParam}`);
      setOrders(res.data.orders);
      setMeta(res.data.meta);
    } finally {
      setLoading(false);
    }
  }, [page, statusFilter]);

  useEffect(() => { fetchOrders(); }, [fetchOrders]);

  async function handleCancel(orderId: string) {
    setCanceling(orderId);
    try {
      await api.delete(`/orders/${orderId}`);
      fetchOrders();
    } finally {
      setCanceling(null);
    }
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-8 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-slate-100">My Orders</h1>
        <p className="text-slate-400 text-sm mt-0.5">
          {meta ? `${meta.total} orders total` : '…'}
        </p>
      </div>

      {/* Status filter tabs */}
      <div className="flex gap-2 flex-wrap">
        {STATUS_FILTERS.map((s) => (
          <button
            key={s}
            onClick={() => { setFilter(s); setPage(1); }}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              statusFilter === s
                ? 'bg-primary-600 text-white'
                : 'bg-surface-card border border-surface-border text-slate-400 hover:text-slate-200'
            }`}
          >
            {s !== 'ALL' && STATUS_ICON[s]} {s}
          </button>
        ))}
      </div>

      {/* Orders list */}
      <div className="card">
        {loading ? (
          <div className="text-center py-12 text-slate-500">Loading…</div>
        ) : orders.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-4xl mb-3">📭</p>
            <p className="text-slate-500">No orders found</p>
          </div>
        ) : (
          <div className="divide-y divide-surface-border">
            {orders.map((order) => (
              <div key={order.id} className="py-4 flex flex-col sm:flex-row sm:items-center gap-3">
                {/* Left — number + service */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-slate-100 text-sm">{order.phoneNumber}</span>
                    <span className={STATUS_BADGE[order.status]}>{order.status}</span>
                    <span className="text-xs text-slate-500 uppercase">{order.provider}</span>
                  </div>
                  <p className="text-slate-400 text-sm mt-0.5 capitalize">
                    {order.service} · {order.country.toUpperCase()}
                  </p>
                  <p className="text-slate-600 text-xs mt-0.5">
                    {new Date(order.createdAt).toLocaleString()} · ${(order.price / 100).toFixed(2)}
                  </p>

                  {/* SMS Code — shown prominently when received */}
                  {order.smsCode && (
                    <div className="mt-2 inline-flex items-center gap-2 bg-green-500/10
                                    border border-green-500/30 rounded-lg px-3 py-2">
                      <span className="text-xs text-slate-400">Code:</span>
                      <span className="font-mono font-bold text-green-400 text-lg tracking-widest">
                        {order.smsCode}
                      </span>
                      <button
                        onClick={() => navigator.clipboard.writeText(order.smsCode!)}
                        className="text-slate-500 hover:text-slate-300 text-xs ml-1"
                        title="Copy code"
                      >
                        📋
                      </button>
                    </div>
                  )}

                  {/* Full SMS text */}
                  {order.smsFullText && (
                    <p className="text-slate-500 text-xs mt-1 italic">"{order.smsFullText}"</p>
                  )}
                </div>

                {/* Right — cancel button */}
                {order.status === 'PENDING' && (
                  <button
                    onClick={() => handleCancel(order.id)}
                    disabled={canceling === order.id}
                    className="shrink-0 text-xs text-red-400 border border-red-500/30
                               hover:bg-red-500/10 px-3 py-1.5 rounded-lg transition-colors"
                  >
                    {canceling === order.id ? 'Canceling…' : 'Cancel & Refund'}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Pagination */}
        {meta && meta.totalPages > 1 && (
          <div className="flex items-center justify-between pt-4 border-t border-surface-border">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="btn-primary text-sm disabled:opacity-40"
            >
              ← Prev
            </button>
            <span className="text-slate-400 text-sm">
              Page {meta.page} / {meta.totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(meta.totalPages, p + 1))}
              disabled={page === meta.totalPages}
              className="btn-primary text-sm disabled:opacity-40"
            >
              Next →
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
