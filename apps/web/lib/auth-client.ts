/**
 * Better Auth client for the frontend.
 *
 * Replaces the zustand auth store (store/auth.ts) with Better Auth's
 * reactive client. Provides:
 * - useSession() — reactive session hook (replaces refreshSession)
 * - signIn.email(), signIn.emailOtp(), signIn.social() — sign-in methods
 * - signOut() — sign out
 * - changePassword(), changeEmail() — account management
 * - sendVerificationEmail() — email verification
 *
 * The client uses nano-stores for reactive state and better-fetch for
 * HTTP requests. No manual cookie management needed.
 */
import { createAuthClient } from 'better-auth/react';
import { emailOTPClient } from 'better-auth/client/plugins';

export const authClient = createAuthClient({
  plugins: [emailOTPClient()],
});

// Re-export the session hook for convenience
export const { useSession, signIn, signOut, changePassword, changeEmail, sendVerificationEmail } = authClient;
