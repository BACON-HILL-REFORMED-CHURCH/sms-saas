'use client';
// ============================================================
// Wallet Page — balance + crypto deposit + manual recharge + tx history
// ============================================================

import { useEffect, useState, useCallback } from 'react';
import api from '@/lib/api';

// ── Types ──────────────────────────────────────────────────

interface Transaction {
  id: string;
  type: string;
  amount: number;
  amountFormatted: string;
  balanceAfterFormatted: string;
  description: string;
  createdAt: string;
}

interface RechargeRequest {
  id: string;
  amountUsd: number;
  method: string;
  status: string;
  createdAt: string;
  txid?: string;
}

type WalletTab = 'crypto' | 'manual' | 'history';
type RechargeMethod = 'BINANCE' | 'USDT' | 'IBAN' | 'CIH';

// ── Payment details — from NEXT_PUBLIC_* env vars ──────────

const PAYMENT_METHODS: {
  key: RechargeMethod;
  label: string;
  icon: string;
  fields: { name: string; envKey: string }[];
}[] = [
  {
    key: 'BINANCE',
    label: 'Binance Pay',
    icon: '🟡',
    fields: [{ name: 'Binance Pay ID', envKey: 'NEXT_PUBLIC_PAYMENT_BINANCE_ID' }],
  },
  {
    key: 'USDT',
    label: 'USDT TRC20',
    icon: '💚',
    fields: [{ name: 'Wallet Address', envKey: 'NEXT_PUBLIC_PAYMENT_USDT_ADDRESS' }],
  },
  {
    key: 'IBAN',
    label: 'Bank Transfer',
    icon: '🏦',
    fields: [
      { name: 'IBAN',      envKey: 'NEXT_PUBLIC_PAYMENT_IBAN' },
      { name: 'Reference', envKey: '' }, // static
    ],
  },
  {
    key: 'CIH',
    label: 'CIH Bank',
    icon: '🏛️',
    fields: [{ name: 'Account', envKey: 'NEXT_PUBLIC_PAYMENT_CIH_BANK' }],
  },
];

function getEnv(key: string): string {
  if (!key) return 'SMS Shop Deposit';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (process.env as any)[key] ?? '—';
}

// ── Sub-components ─────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  }
  return (
    <button
      onClick={copy}
      className="text-xs text-primary-400 border border-primary-500/30 px-2 py-0.5
                 rounded hover:bg-primary-500/10 transition-colors shrink-0"
    >
      {copied ? '✅' : '📋'}
    </button>
  );
}

const TX_ICON: Record<string, string> = {
  DEPOSIT: '⬆️', DEBIT: '⬇️', REFUND: '↩️', ADMIN_ADJ: '⚙️',
};

const RECHARGE_BADGE: Record<string, string> = {
  PENDING: 'badge-pending', APPROVED: 'badge-received', REJECTED: 'badge-canceled', EXPIRED: 'badge-canceled',
};

// ── Page ───────────────────────────────────────────────────

export default function WalletPage() {
  const [tab, setTab]           = useState<WalletTab>('crypto');
  const [balance, setBalance]   = useState('—');
  const [txns, setTxns]         = useState<Transaction[]>([]);
  const [recharges, setRecharges] = useState<RechargeRequest[]>([]);
  const [loadingTx, setLoadingTx] = useState(false);

  // Crypto deposit state
  const [cryptoAmount, setCryptoAmount] = useState('');
  const [cryptoPending, setCryptoPending] = useState(false);
  const [cryptoPayment, setCryptoPayment] = useState<{
    uuid: string; address: string; amount: string; currency: string; url: string;
  } | null>(null);
  const [cryptoErr, setCryptoErr] = useState('');
  const [cryptoChecking, setCryptoChecking] = useState(false);
  const [cryptoPaid, setCryptoPaid] = useState(false);

  // Manual recharge state
  const [selMethod, setSelMethod]   = useState<RechargeMethod | null>(null);
  const [manualAmt, setManualAmt]   = useState('');
  const [manualTxid, setManualTxid] = useState('');
  const [manualProof, setManualProof] = useState('');
  const [manualLoading, setManualLoading] = useState(false);
  const [manualMsg, setManualMsg]   = useState('');
  const [manualErr, setManualErr]   = useState('');

  const fetchBalance = useCallback(async () => {
    try {
      const r = await api.get('/wallet/balance');
      setBalance(r.data.balanceFormatted ?? r.data.balance ?? '—');
    } catch {}
  }, []);

  const fetchHistory = useCallback(async () => {
    setLoadingTx(true);
    try {
      const [txRes, rchRes] = await Promise.allSettled([
        api.get('/wallet/history?limit=30'),
        api.get('/recharge/my'),
      ]);
      if (txRes.status === 'fulfilled') setTxns(txRes.value.data.transactions ?? txRes.value.data ?? []);
      if (rchRes.status === 'fulfilled') {
        const d = rchRes.value.data;
        setRecharges(Array.isArray(d) ? d : (d.recharges ?? []));
      }
    } finally {
      setLoadingTx(false);
    }
  }, []);

  useEffect(() => {
    fetchBalance();
    if (tab === 'history') fetchHistory();
  }, [tab, fetchBalance, fetchHistory]);

  // ── Crypto deposit ─────────────────────────────────────────

  async function createCryptoDeposit() {
    const amt = parseFloat(cryptoAmount);
    if (!amt || amt < 1) { setCryptoErr('Minimum deposit is $1'); return; }
    setCryptoPending(true); setCryptoErr('');
    try {
      const r = await api.post('/wallet/deposit/crypto', { amountUsd: amt });
      setCryptoPayment({
        uuid:     r.data.uuid || r.data.payment_uuid,
        address:  r.data.address,
        amount:   r.data.amount,
        currency: r.data.currency,
        url:      r.data.url || r.data.payment_url || '',
      });
    } catch (err: any) {
      setCryptoErr(err.response?.data?.message ?? 'Failed to create payment');
    } finally {
      setCryptoPending(false);
    }
  }

  async function checkCryptoPayment() {
    if (!cryptoPayment) return;
    setCryptoChecking(true);
    try {
      const r = await api.get(`/wallet/deposit/check/${cryptoPayment.uuid}`);
      if (r.data.status === 'paid' || r.data.credited === true) {
        setCryptoPaid(true);
        await fetchBalance();
      } else {
        setCryptoErr('Payment not confirmed yet — try again in a moment');
      }
    } catch (err: any) {
      setCryptoErr(err.response?.data?.message ?? 'Check failed');
    } finally {
      setCryptoChecking(false);
    }
  }

  function resetCrypto() {
    setCryptoPayment(null); setCryptoAmount('');
    setCryptoPaid(false); setCryptoErr('');
  }

  // ── Manual recharge ────────────────────────────────────────

  async function submitManual(e: React.FormEvent) {
    e.preventDefault();
    if (!selMethod) { setManualErr('Select a payment method'); return; }
    const amt = parseFloat(manualAmt);
    if (!amt || amt < 1) { setManualErr('Enter a valid amount (min $1)'); return; }
    if (!manualTxid.trim()) { setManualErr('Enter your transaction ID / reference'); return; }
    setManualLoading(true); setManualMsg(''); setManualErr('');
    try {
      await api.post('/recharge', {
        amountUsd: amt,
        method:    selMethod,
        txid:      manualTxid.trim(),
        proofUrl:  manualProof.trim() || undefined,
      });
      setManualMsg('✅ Request submitted! We\'ll review it within 24 hours.');
      setManualAmt(''); setManualTxid(''); setManualProof(''); setSelMethod(null);
    } catch (err: any) {
      setManualErr(err.response?.data?.message ?? 'Submission failed');
    } finally {
      setManualLoading(false);
    }
  }

  // ── Render ─────────────────────────────────────────────────

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-6">

      {/* Balance card */}
      <div className="card flex items-center justify-between">
        <div>
          <p className="text-slate-400 text-sm">Available Balance</p>
          <p className="text-4xl font-bold text-primary-400 mt-1">{balance}</p>
        </div>
        <div className="text-5xl opacity-20">💳</div>
      </div>

      {/* Tab switcher */}
      <div className="flex gap-2">
        {([
          { key: 'crypto',  label: '₿ Crypto Deposit' },
          { key: 'manual',  label: '🏦 Manual Transfer' },
          { key: 'history', label: '📋 History' },
        ] as { key: WalletTab; label: string }[]).map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              tab === t.key
                ? 'bg-primary-600 text-white'
                : 'bg-surface-card border border-surface-border text-slate-400 hover:text-slate-200'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Crypto tab ──────────────────────────────────────── */}
      {tab === 'crypto' && (
        <div className="card space-y-5">
          <h2 className="text-lg font-semibold text-slate-100">Pay with Crypto</h2>
          <p className="text-slate-400 text-sm">
            Deposit using Bitcoin, USDT, ETH, and 100+ cryptocurrencies via Cryptomus.
          </p>

          {!cryptoPayment && !cryptoPaid && (
            <>
              {/* Quick amounts */}
              <div>
                <p className="text-sm font-medium text-slate-300 mb-2">Choose Amount (USD)</p>
                <div className="flex gap-2 flex-wrap mb-3">
                  {[5, 10, 20, 50, 100].map((a) => (
                    <button
                      key={a}
                      onClick={() => setCryptoAmount(String(a))}
                      className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
                        cryptoAmount === String(a)
                          ? 'bg-primary-600 border-primary-500 text-white'
                          : 'bg-surface border-surface-border text-slate-300 hover:border-slate-500'
                      }`}
                    >
                      ${a}
                    </button>
                  ))}
                </div>
                <div className="relative max-w-xs">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">$</span>
                  <input
                    type="number"
                    min="1"
                    step="0.01"
                    value={cryptoAmount}
                    onChange={(e) => setCryptoAmount(e.target.value)}
                    placeholder="Custom amount"
                    className="input-field pl-7"
                  />
                </div>
              </div>

              {cryptoErr && (
                <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3">
                  <p className="text-red-400 text-sm">{cryptoErr}</p>
                </div>
              )}

              <button
                onClick={createCryptoDeposit}
                disabled={cryptoPending || !cryptoAmount}
                className="btn-primary px-6 disabled:opacity-40"
              >
                {cryptoPending ? 'Creating payment…' : 'Continue to Payment →'}
              </button>
            </>
          )}

          {cryptoPayment && !cryptoPaid && (
            <div className="space-y-4">
              <div className="bg-surface border border-surface-border rounded-xl p-5 text-center space-y-3">
                <div className="text-4xl">₿</div>
                <p className="text-slate-400 text-sm">Send exactly this amount to:</p>
                <div className="flex items-center justify-center gap-2">
                  <p className="font-mono text-slate-100 text-sm break-all">{cryptoPayment.address}</p>
                  <CopyButton text={cryptoPayment.address} />
                </div>
                <p className="text-2xl font-bold text-primary-400">
                  {cryptoPayment.amount} {cryptoPayment.currency}
                </p>
              </div>

              {cryptoPayment.url && (
                <a
                  href={cryptoPayment.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn-primary w-full text-center block"
                >
                  🔗 Open Payment Page
                </a>
              )}

              {cryptoErr && (
                <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3">
                  <p className="text-red-400 text-sm">{cryptoErr}</p>
                </div>
              )}

              <div className="flex gap-3">
                <button
                  onClick={checkCryptoPayment}
                  disabled={cryptoChecking}
                  className="btn-primary flex-1 disabled:opacity-40"
                >
                  {cryptoChecking ? 'Checking…' : '🔄 Check Payment'}
                </button>
                <button onClick={resetCrypto} className="px-4 py-2 rounded-lg text-sm text-slate-400 border border-surface-border hover:text-slate-200">
                  ← Back
                </button>
              </div>
            </div>
          )}

          {cryptoPaid && (
            <div className="text-center space-y-3 py-4">
              <div className="text-5xl">✅</div>
              <p className="text-green-400 font-semibold text-lg">Payment confirmed!</p>
              <p className="text-slate-400 text-sm">Your balance has been updated.</p>
              <button onClick={resetCrypto} className="btn-primary px-6">Make Another Deposit</button>
            </div>
          )}
        </div>
      )}

      {/* ── Manual tab ──────────────────────────────────────── */}
      {tab === 'manual' && (
        <div className="card space-y-6">
          <div>
            <h2 className="text-lg font-semibold text-slate-100">Manual Transfer</h2>
            <p className="text-slate-400 text-sm mt-1">
              Send payment via one of the methods below, then submit your transaction details.
              Requests are reviewed within 24 hours.
            </p>
          </div>

          {/* Method selector */}
          <div>
            <p className="text-sm font-medium text-slate-300 mb-3">Select Payment Method</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {PAYMENT_METHODS.map((m) => (
                <button
                  key={m.key}
                  onClick={() => setSelMethod(m.key)}
                  className={`flex flex-col items-center gap-2 p-4 rounded-xl border text-sm font-medium transition-all ${
                    selMethod === m.key
                      ? 'border-primary-500 bg-primary-600/10 text-slate-100'
                      : 'border-surface-border text-slate-400 hover:border-slate-500 hover:text-slate-200'
                  }`}
                >
                  <span className="text-2xl">{m.icon}</span>
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          {/* Payment details */}
          {selMethod && (() => {
            const m = PAYMENT_METHODS.find((x) => x.key === selMethod)!;
            return (
              <div className="bg-surface border border-surface-border rounded-xl overflow-hidden">
                <div className="px-4 py-2.5 border-b border-surface-border bg-surface-card">
                  <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
                    {m.icon} Payment Details — {m.label}
                  </p>
                </div>
                <div className="divide-y divide-surface-border">
                  {m.fields.map((f) => {
                    const val = getEnv(f.envKey);
                    return (
                      <div key={f.name} className="flex items-center justify-between px-4 py-3 gap-3">
                        <span className="text-slate-500 text-sm shrink-0">{f.name}</span>
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="font-mono text-slate-100 text-sm break-all">{val}</span>
                          {val !== '—' && <CopyButton text={val} />}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()}

          {/* Submission form */}
          {selMethod && (
            <form onSubmit={submitManual} className="space-y-4 pt-2 border-t border-surface-border">
              <h3 className="font-medium text-slate-200">Confirm Your Transfer</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-1.5">Amount (USD)</label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">$</span>
                    <input
                      type="number" min="1" step="0.01" required
                      value={manualAmt}
                      onChange={(e) => setManualAmt(e.target.value)}
                      placeholder="20.00"
                      className="input-field pl-7"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-1.5">Transaction ID / Reference</label>
                  <input
                    type="text" required
                    value={manualTxid}
                    onChange={(e) => setManualTxid(e.target.value)}
                    placeholder="Paste your transaction hash or reference"
                    className="input-field"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1.5">
                  Screenshot URL <span className="text-slate-500 font-normal">(optional)</span>
                </label>
                <input
                  type="url"
                  value={manualProof}
                  onChange={(e) => setManualProof(e.target.value)}
                  placeholder="https://…"
                  className="input-field"
                />
              </div>

              {manualMsg && (
                <div className="bg-green-500/10 border border-green-500/30 rounded-lg px-4 py-3">
                  <p className="text-green-400 text-sm">{manualMsg}</p>
                </div>
              )}
              {manualErr && (
                <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3">
                  <p className="text-red-400 text-sm">{manualErr}</p>
                </div>
              )}

              <button type="submit" disabled={manualLoading} className="btn-primary disabled:opacity-40">
                {manualLoading ? 'Submitting…' : '📨 Submit Recharge Request'}
              </button>
            </form>
          )}
        </div>
      )}

      {/* ── History tab ─────────────────────────────────────── */}
      {tab === 'history' && (
        <div className="space-y-6">
          {/* Transactions */}
          <div className="card">
            <h2 className="text-lg font-semibold text-slate-100 mb-5">Transactions</h2>
            {loadingTx ? (
              <div className="text-center py-8 text-slate-500">Loading…</div>
            ) : txns.length === 0 ? (
              <div className="text-center py-8 text-slate-500">No transactions yet</div>
            ) : (
              <div className="divide-y divide-surface-border">
                {txns.map((tx) => (
                  <div key={tx.id} className="flex items-center justify-between py-3 gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="text-xl shrink-0">{TX_ICON[tx.type] ?? '•'}</span>
                      <div className="min-w-0">
                        <p className="text-sm text-slate-200 truncate">{tx.description}</p>
                        <p className="text-xs text-slate-500">{new Date(tx.createdAt).toLocaleString()}</p>
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <p className={`text-sm font-semibold ${tx.amount > 0 ? 'text-green-400' : 'text-red-400'}`}>
                        {tx.amount > 0 ? '+' : ''}{tx.amountFormatted}
                      </p>
                      <p className="text-xs text-slate-500">Bal: {tx.balanceAfterFormatted}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Recharge requests */}
          <div className="card">
            <h2 className="text-lg font-semibold text-slate-100 mb-5">Recharge Requests</h2>
            {loadingTx ? (
              <div className="text-center py-8 text-slate-500">Loading…</div>
            ) : recharges.length === 0 ? (
              <div className="text-center py-8 text-slate-500">No recharge requests yet</div>
            ) : (
              <div className="divide-y divide-surface-border">
                {recharges.map((r) => (
                  <div key={r.id} className="flex items-center justify-between py-3 gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="text-slate-100 font-semibold">${(r.amountUsd ?? 0).toFixed(2)}</p>
                        <span className={RECHARGE_BADGE[r.status] ?? 'badge-pending'}>{r.status}</span>
                      </div>
                      <p className="text-slate-500 text-xs mt-0.5">
                        {r.method} · {r.txid ? r.txid.substring(0, 20) + '…' : 'no txid'} · {new Date(r.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
