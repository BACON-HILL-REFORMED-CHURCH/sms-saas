'use client';
// ============================================================
// eSIM Page — browse plans + purchase + view orders
// ============================================================

import { useEffect, useState, useCallback } from 'react';
import api from '@/lib/api';

interface EsimProduct {
  id: string;
  name: string;
  country: string;
  countryCode: string;
  gb: number;
  days: number;
  price: number;
  stock: number;
}

interface EsimOrder {
  id: string;
  price: number;
  status: string;
  createdAt: string;
  product: EsimProduct;
  inventory: {
    qrCodeData: string;
    activationCode: string | null;
  } | null;
}

const FLAG: Record<string, string> = {
  ae: '🇦🇪', us: '🇺🇸', gb: '🇬🇧', fr: '🇫🇷', de: '🇩🇪',
  sa: '🇸🇦', ma: '🇲🇦', eg: '🇪🇬', tn: '🇹🇳', tr: '🇹🇷',
  es: '🇪🇸', it: '🇮🇹', ru: '🇷🇺', cn: '🇨🇳', jp: '🇯🇵',
  in: '🇮🇳', br: '🇧🇷', ca: '🇨🇦', au: '🇦🇺', nl: '🇳🇱',
};

export default function EsimPage() {
  const [tab, setTab]           = useState<'browse' | 'orders'>('browse');
  const [products, setProducts] = useState<EsimProduct[]>([]);
  const [orders, setOrders]     = useState<EsimOrder[]>([]);
  const [buying, setBuying]     = useState<string | null>(null);
  const [loading, setLoading]   = useState(true);
  const [selectedQr, setSelectedQr] = useState<EsimOrder | null>(null);
  const [copied, setCopied]     = useState(false);
  const [search, setSearch]     = useState('');

  const fetchProducts = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/esim/products');
      setProducts(Array.isArray(res.data) ? res.data : []);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchOrders = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/esim/orders');
      setOrders(Array.isArray(res.data) ? res.data : []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === 'browse') fetchProducts();
    else fetchOrders();
  }, [tab, fetchProducts, fetchOrders]);

  async function handleBuy(productId: string) {
    if (!confirm('Confirm purchase? Balance will be deducted.')) return;
    setBuying(productId);
    try {
      const res = await api.post(`/esim/purchase/${productId}`);
      alert('✅ eSIM purchased! Check "My eSIMs" tab.');
      setTab('orders');
      fetchOrders();
    } catch (err: any) {
      alert(err?.response?.data?.message ?? 'Purchase failed');
    } finally {
      setBuying(null);
    }
  }

  function copyQr(text: string) {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const filtered = products.filter((p) =>
    search === '' ||
    p.country.toLowerCase().includes(search.toLowerCase()) ||
    p.name.toLowerCase().includes(search.toLowerCase())
  );

  // Group by country
  const grouped = filtered.reduce<Record<string, EsimProduct[]>>((acc, p) => {
    if (!acc[p.country]) acc[p.country] = [];
    acc[p.country].push(p);
    return acc;
  }, {});

  return (
    <div className="max-w-5xl mx-auto px-4 py-8 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-slate-100">📡 eSIM Store</h1>
        <p className="text-slate-400 text-sm mt-0.5">
          Buy data-only eSIM plans and activate them instantly on your device
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-2">
        {(['browse', 'orders'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              tab === t
                ? 'bg-primary-600 text-white'
                : 'bg-surface-card border border-surface-border text-slate-400 hover:text-slate-200'
            }`}
          >
            {t === 'browse' ? '🌍 Browse Plans' : '📋 My eSIMs'}
          </button>
        ))}
      </div>

      {/* ── Browse tab ──────────────────────────────────── */}
      {tab === 'browse' && (
        <div className="space-y-6">
          {/* Search */}
          <input
            type="text"
            placeholder="🔍 Search by country..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full max-w-sm input"
          />

          {loading ? (
            <div className="text-center py-16 text-slate-500">Loading plans…</div>
          ) : Object.keys(grouped).length === 0 ? (
            <div className="card text-center py-16">
              <p className="text-4xl mb-3">📡</p>
              <p className="text-slate-400">No eSIM plans available yet.</p>
              <p className="text-slate-600 text-sm mt-1">Check back soon!</p>
            </div>
          ) : (
            Object.entries(grouped).map(([country, plans]) => (
              <div key={country} className="card space-y-3">
                {/* Country header */}
                <div className="flex items-center gap-2 pb-2 border-b border-surface-border">
                  <span className="text-2xl">
                    {FLAG[plans[0].countryCode.toLowerCase()] ?? '🌍'}
                  </span>
                  <h2 className="text-slate-100 font-semibold">{country}</h2>
                  <span className="text-xs text-slate-500">({plans.length} plans)</span>
                </div>

                {/* Plans grid */}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {plans.map((plan) => (
                    <div
                      key={plan.id}
                      className={`rounded-xl border p-4 flex flex-col gap-3 transition-colors ${
                        plan.stock > 0
                          ? 'border-surface-border hover:border-primary-500/50 bg-surface'
                          : 'border-surface-border opacity-50 bg-surface'
                      }`}
                    >
                      {/* Plan details */}
                      <div>
                        <div className="flex items-center justify-between">
                          <span className="text-lg font-bold text-slate-100">
                            {plan.gb} GB
                          </span>
                          <span className="text-xs bg-primary-600/20 text-primary-400
                                           px-2 py-0.5 rounded-full">
                            {plan.days} days
                          </span>
                        </div>
                        <p className="text-slate-400 text-xs mt-1">{plan.name}</p>
                      </div>

                      {/* Price + stock */}
                      <div className="flex items-center justify-between">
                        <span className="text-primary-400 font-bold">
                          ${(plan.price / 100).toFixed(2)}
                        </span>
                        <span className={`text-xs ${plan.stock > 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {plan.stock > 0 ? `${plan.stock} in stock` : 'Out of stock'}
                        </span>
                      </div>

                      {/* Buy button */}
                      <button
                        onClick={() => handleBuy(plan.id)}
                        disabled={plan.stock === 0 || buying === plan.id}
                        className="btn-primary w-full text-sm disabled:opacity-40"
                      >
                        {buying === plan.id ? 'Processing…' : 'Buy Now'}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* ── My eSIMs tab ────────────────────────────────── */}
      {tab === 'orders' && (
        <div className="card">
          {loading ? (
            <div className="text-center py-12 text-slate-500">Loading…</div>
          ) : orders.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-4xl mb-3">📡</p>
              <p className="text-slate-500">No eSIM purchases yet</p>
              <button
                onClick={() => setTab('browse')}
                className="btn-primary mt-4 text-sm"
              >
                Browse Plans
              </button>
            </div>
          ) : (
            <div className="divide-y divide-surface-border">
              {orders.map((order) => (
                <div key={order.id} className="py-4 flex flex-col sm:flex-row sm:items-center gap-3">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xl">
                        {FLAG[order.product.countryCode?.toLowerCase()] ?? '🌍'}
                      </span>
                      <span className="text-slate-100 font-medium">{order.product.country}</span>
                      <span className="text-xs bg-green-500/20 text-green-400 px-2 py-0.5 rounded-full">
                        {order.product.gb} GB / {order.product.days} days
                      </span>
                    </div>
                    <p className="text-slate-500 text-xs mt-1">
                      {new Date(order.createdAt).toLocaleString()} · ${(order.price / 100).toFixed(2)}
                    </p>
                  </div>
                  <button
                    onClick={() => setSelectedQr(order)}
                    className="shrink-0 btn-primary text-sm"
                  >
                    📱 Show QR Code
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── QR Code Modal ───────────────────────────────── */}
      {selectedQr && (
        <div
          className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
          onClick={() => setSelectedQr(null)}
        >
          <div
            className="bg-surface-card border border-surface-border rounded-2xl p-6 max-w-md w-full space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-slate-100 font-bold text-lg">Your eSIM</h3>
              <button onClick={() => setSelectedQr(null)} className="text-slate-500 hover:text-slate-300">✕</button>
            </div>

            <div className="text-center space-y-2">
              <p className="text-slate-400 text-sm">
                {FLAG[selectedQr.product.countryCode?.toLowerCase()] ?? '🌍'}{' '}
                {selectedQr.product.country} — {selectedQr.product.gb} GB / {selectedQr.product.days} days
              </p>
            </div>

            {selectedQr.inventory ? (
              <div className="space-y-3">
                {/* QR Code display */}
                <div className="bg-white rounded-xl p-4 text-center">
                  <p className="text-xs text-gray-500 mb-2">Scan with your phone's camera or eSIM app</p>
                  {/* QR code as text for now — can integrate qrcode lib later */}
                  <div className="bg-gray-100 rounded-lg p-3 break-all text-xs text-gray-700 font-mono text-left">
                    {selectedQr.inventory.qrCodeData}
                  </div>
                </div>

                {selectedQr.inventory.activationCode && (
                  <div className="bg-surface border border-surface-border rounded-lg p-3">
                    <p className="text-xs text-slate-500 mb-1">Manual Activation Code:</p>
                    <p className="font-mono text-slate-100 text-sm break-all">
                      {selectedQr.inventory.activationCode}
                    </p>
                  </div>
                )}

                <button
                  onClick={() => copyQr(selectedQr.inventory!.qrCodeData)}
                  className="btn-primary w-full text-sm"
                >
                  {copied ? '✅ Copied!' : '📋 Copy Activation Data'}
                </button>

                <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-3">
                  <p className="text-yellow-400 text-xs font-medium mb-1">📱 How to activate:</p>
                  <ol className="text-slate-400 text-xs space-y-1 list-decimal list-inside">
                    <li>Go to Settings → Mobile Data / Cellular</li>
                    <li>Tap "Add eSIM" or "Add Data Plan"</li>
                    <li>Scan QR code or enter manually</li>
                    <li>Follow on-screen instructions</li>
                  </ol>
                </div>
              </div>
            ) : (
              <p className="text-center text-slate-500">No activation data available</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
