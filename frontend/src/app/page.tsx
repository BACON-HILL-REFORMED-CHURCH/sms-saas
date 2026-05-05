// ============================================================
// Home page — redirects to dashboard or login
// ============================================================

import { redirect } from 'next/navigation';

export default function HomePage() {
  // In a real app, check auth cookie server-side
  // For now, redirect to login
  redirect('/login');
}
