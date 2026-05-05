// ============================================================
// Auth Store — Zustand global state for authenticated user
// ============================================================

import { create } from 'zustand';

interface AuthUser {
  id: string;
  email: string;
  role: string;
  balance: number;
  isEmailVerified: boolean;
}

interface AuthState {
  user: AuthUser | null;
  isLoading: boolean;
  setUser: (user: AuthUser | null) => void;
  setLoading: (v: boolean) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isLoading: true,

  setUser: (user) => set({ user }),
  setLoading: (v) => set({ isLoading: v }),

  logout: () => {
    if (typeof window !== 'undefined') {
      localStorage.removeItem('access_token');
    }
    set({ user: null });
    window.location.href = '/login';
  },
}));
