/**
 * Better Auth catch-all route handler.
 *
 * This single route replaces all 13 hand-rolled auth API routes:
 * - /api/auth/sign-in, /api/auth/sign-out, /api/auth/session
 * - /api/auth/magic-link, /api/auth/verify-email
 * - /api/auth/change-email, /api/auth/change-password
 * - /api/auth/preflight, /api/auth/sessions, /api/auth/challenge
 *
 * Better Auth also handles social sign-on (Google, GitHub) via:
 * - GET /api/auth/sign-in/social (initiates OAuth flow)
 * - GET /api/auth/callback/{provider} (handles OAuth callback)
 *
 * This replaces packages/oauth entirely.
 */
import { auth } from '@entry/auth';
import { toNextJsHandler } from 'better-auth/next-js';

export const { GET, POST } = toNextJsHandler(auth);
