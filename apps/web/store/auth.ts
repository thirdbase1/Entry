/**
 * Auth store — thin wrapper around Better Auth's reactive client.
 * Components that can should import authClient directly from @/lib/auth-client
 * and use useSession() for reactive session state.
 */
'use client';

import { authClient } from '@/lib/auth-client';
import { create } from 'zustand';

export interface User {
  id: string;
  email: string;
  name?: string;
}

export interface AuthState {
  user: User | null;
  isLoading: boolean;
  error: string | null;
  checkUserByEmail: (email: string) => Promise<{ hasPassword: boolean; canSignIn: boolean }>;
  signInPassword: (email: string, password: string) => Promise<void>;
  sendMagicLink: (email: string, options?: { redirectUrl?: string }) => Promise<void>;
  verifyMagicLink: (email: string, token: string) => Promise<void>;
  signInOAuth: (provider: 'google' | 'github') => Promise<void>;
  logout: () => void;
  refreshSession: () => Promise<void>;
  clearError: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isLoading: false,
  error: null,

  checkUserByEmail: async (email) => {
    try {
      const res = await fetch(`/api/auth/check-email?email=${encodeURIComponent(email)}`);
      const text = await res.text();
      const json = text ? JSON.parse(text) : null;
      if (!res.ok || !json) {
        // Fail open to the OTP path (the safer default — never silently
        // blocks a real user) rather than surfacing a raw fetch error here.
        return { hasPassword: false, canSignIn: true };
      }
      return { hasPassword: !!json.hasPassword, canSignIn: json.canSignIn !== false };
    } catch {
      return { hasPassword: false, canSignIn: true };
    }
  },

  signInPassword: async (email, password) => {
    set({ isLoading: true, error: null });
    try {
      const { error } = await authClient.signIn.email({ email, password });
      if (error) throw new Error(error.message || 'Login failed');
      const { data: session } = await authClient.getSession();
      set({ user: session?.user as User ?? null, isLoading: false });
    } catch (error) {
      set({ isLoading: false, error: error instanceof Error ? error.message : 'Login failed' });
      throw error;
    }
  },

  sendMagicLink: async (email, _options) => {
    set({ isLoading: true, error: null });
    try {
      const { error } = await authClient.emailOtp.sendVerificationOtp({ email, type: 'sign-in' });
      if (error) throw new Error(error.message || 'Failed to send sign-in code');
      set({ isLoading: false });
    } catch (err) {
      // Previously this threw without ever setting `error` state, so a
      // failed send (rate limit, network blip, provider error) left the
      // UI showing nothing at all — the "Continue with email" button
      // just silently did nothing with no feedback. Now it surfaces.
      set({ isLoading: false, error: err instanceof Error ? err.message : 'Failed to send sign-in code' });
      throw err;
    }
  },

  verifyMagicLink: async (email, token) => {
    set({ isLoading: true, error: null });
    try {
      const { error } = await authClient.signIn.emailOtp({ email, otp: token });
      if (error) throw new Error(error.message || 'Invalid code');
      const { data: session } = await authClient.getSession();
      set({ user: session?.user as User ?? null, isLoading: false });
    } catch (err) {
      set({ isLoading: false, error: err instanceof Error ? err.message : 'Verification failed' });
      throw err;
    }
  },

  signInOAuth: async (provider) => {
    set({ isLoading: true, error: null });
    try {
      // Land directly on the dashboard after a successful OAuth round-trip
      // instead of the marketing page ('/') — avoids depending on the
      // landing page's client-side "am I logged in now?" redirect dance,
      // which was the root cause of users getting stuck looking at the
      // landing page after Google sign-in instead of reaching /chats.
      await authClient.signIn.social({ provider, callbackURL: '/chats' });
    } catch (err) {
      set({ isLoading: false, error: err instanceof Error ? err.message : 'OAuth login failed' });
      throw err;
    }
  },

  logout: async () => {
    await authClient.signOut();
    set({ user: null, error: null });
  },

  refreshSession: async () => {
    set({ isLoading: true });
    try {
      const { data: session } = await authClient.getSession();
      set({ user: session?.user as User ?? null, isLoading: false });
    } catch {
      set({ user: null, isLoading: false });
    }
  },

  clearError: () => set({ error: null }),
}));
