'use client';
// ============================================================
// Email Verification Page — reads token from URL, calls API
// ============================================================

import { useEffect, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import api from '@/lib/api';

function VerifyEmailContent() {
  const params = useSearchParams();
  const token = params.get('token');
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!token) {
      setStatus('error');
      setMessage('No verification token found.');
      return;
    }

    api.get(`/auth/verify-email?token=${token}`)
      .then((res) => {
        setStatus('success');
        setMessage(res.data.message);
      })
      .catch((err) => {
        setStatus('error');
        setMessage(err.response?.data?.message ?? 'Verification failed.');
      });
  }, [token]);

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="card w-full max-w-md text-center">
        {status === 'loading' && (
          <>
            <div className="text-4xl mb-4 animate-pulse">⏳</div>
            <p className="text-slate-400">Verifying your email…</p>
          </>
        )}
        {status === 'success' && (
          <>
            <div className="text-5xl mb-4">✅</div>
            <h2 className="text-xl font-semibold text-green-400">Email Verified!</h2>
            <p className="text-slate-400 mt-2">{message}</p>
            <Link href="/login" className="btn-primary inline-block mt-6">Go to Login</Link>
          </>
        )}
        {status === 'error' && (
          <>
            <div className="text-5xl mb-4">❌</div>
            <h2 className="text-xl font-semibold text-red-400">Verification Failed</h2>
            <p className="text-slate-400 mt-2">{message}</p>
            <Link href="/login" className="btn-primary inline-block mt-6">Back to Login</Link>
          </>
        )}
      </div>
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-4xl animate-pulse">⏳</div>
      </div>
    }>
      <VerifyEmailContent />
    </Suspense>
  );
}
