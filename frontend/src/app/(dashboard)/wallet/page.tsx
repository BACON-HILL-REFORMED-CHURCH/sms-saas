'use client';
// ============================================================
// Wallet Page — balance display + deposit form + tx history
// ============================================================

import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
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

// ── Deposit form schema ────────────────────────────────────

const depositSchema = z.object({
  amountDollars: z.coerce.number().min(1, 'Minimum $1').max(10000, 'Maximum $10,000'),
  method: z.enum(['manual', 'crypto_mock']),
});
type DepositForm = z.infer<typeof depositSchema>;

// ── TX type badge colors ──────────────────────────────────

const txBadge: Record<string, string> = {
  DEPOSIT:   'badge-received',
  DEBIT:     'badge-canceled',
  REFUND:    'badge-received',
  ADMIN_ADJ: 'badge-pending',
};

const txIcon: Record<string, string> = {
  DEPOSIT:   '⬆️',
  DEBIT:     '⬇️',
  REFUND:    '↩️',
  ADMIN_ADJ: '⚙️',
};

// ── Component ─────────────────────────────────────────────

export default function WalletPage() {
  const [balance, setBalance]           = useState<string>('—');
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loadingTx, setLoadingTx]       = useState(true);
  const [depositMsg, setDepositMsg]     = useState('');
  const [depositErr, setDepositErr]     = useState('');

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<DepositForm>({ resolver: zodResolver(depositSchema), defaultValues: { method: 'manual' } });

  // Fetch balance + history on mount
  useEffect(() => {
    fetchBalance();
    fetchHistory();
  }, []);

  async function fetchBalance() {
    try {
      const res = await api.get('/wallet/balance');
      setBalance(res.data.balanceFormatted);
    } catch {}
  }

  async function fetchHistory() {
    setLoadingTx(true);
    try {
      const res = await api.get('/wallet/history?limit=30');
      setTransactions(res.data.transactions);
    } finally {
      setLoadingTx(false);
    }
  }

  // Handle deposit submission
  const onDeposit = async (data: DepositForm) => {
    setDepositMsg('');
    setDepositErr('');
    try {
      const res = await api.post('/wallet/deposit', {
        amount: Math.round(data.amountDollars * 100), // dollars → cents
        method: data.method,
      });
      setDepositMsg(`✅ ${res.data.message} — New balance: ${res.data.newBalanceFormatted}`);
      setBalance(res.data.newBalanceFormatted);
      reset();
      fetchHistory();
    } catch (err: any) {
      setDepositErr(err.response?.data?.message ?? 'Deposit failed');
    }
  };

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-8">

      {/* Balance card */}
      <div className="card flex items-center justify-between">
        <div>
          <p className="text-slate-400 text-sm">Available Balance</p>
          <p className="text-4xl font-bold text-primary-400 mt-1">{balance}</p>
        </div>
        <div className="text-5xl opacity-30">💳</div>
      </div>

      {/* Deposit form */}
      <div className="card">
        <h2 className="text-lg font-semibold text-slate-100 mb-5">Add Funds</h2>
        <form onSubmit={handleSubmit(onDeposit)} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Amount */}
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1.5">
                Amount (USD)
              </label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">$</span>
                <input
                  {...register('amountDollars')}
                  type="number"
                  step="0.01"
                  placeholder="10.00"
                  className="input-field pl-7"
                />
              </div>
              {errors.amountDollars && (
                <p className="text-red-400 text-xs mt-1">{errors.amountDollars.message}</p>
              )}
            </div>

            {/* Method */}
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1.5">
                Payment Method
              </label>
              <select {...register('method')} className="input-field">
                <option value="manual">Manual (Test)</option>
                <option value="crypto_mock">Crypto (Mock)</option>
              </select>
            </div>
          </div>

          {depositMsg && (
            <div className="bg-green-500/10 border border-green-500/30 rounded-lg px-4 py-3">
              <p className="text-green-400 text-sm">{depositMsg}</p>
            </div>
          )}
          {depositErr && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3">
              <p className="text-red-400 text-sm">{depositErr}</p>
            </div>
          )}

          <button type="submit" disabled={isSubmitting} className="btn-primary">
            {isSubmitting ? 'Processing…' : 'Add Funds'}
          </button>
        </form>
      </div>

      {/* Transaction history */}
      <div className="card">
        <h2 className="text-lg font-semibold text-slate-100 mb-5">Transaction History</h2>

        {loadingTx ? (
          <div className="text-center py-8 text-slate-500">Loading…</div>
        ) : transactions.length === 0 ? (
          <div className="text-center py-8 text-slate-500">No transactions yet</div>
        ) : (
          <div className="divide-y divide-surface-border">
            {transactions.map((tx) => (
              <div key={tx.id} className="flex items-center justify-between py-3">
                <div className="flex items-center gap-3">
                  <span className="text-xl">{txIcon[tx.type] ?? '•'}</span>
                  <div>
                    <p className="text-sm text-slate-200">{tx.description}</p>
                    <p className="text-xs text-slate-500">
                      {new Date(tx.createdAt).toLocaleString()}
                    </p>
                  </div>
                </div>
                <div className="text-right">
                  <p className={`text-sm font-semibold ${
                    tx.amount > 0 ? 'text-green-400' : 'text-red-400'
                  }`}>
                    {tx.amount > 0 ? '+' : ''}{tx.amountFormatted}
                  </p>
                  <p className="text-xs text-slate-500">
                    Balance: {tx.balanceAfterFormatted}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
