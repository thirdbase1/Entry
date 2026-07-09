/**
 * Compatibility layer — preserves the export names that 40+ API routes and
 * packages already import from @entry/auth, while delegating to Better Auth
 * under the hood.
 *
 * The key function is getUserSessionFromRequest(), which wraps Better Auth's
 * auth.api.getSession() and returns the same { session: { user, session } | null }
 * shape that all routes expect. This lets us migrate the auth backend without
 * touching every single route file.
 *
 * Exports preserved:
 * - auth (the Better Auth instance — NOT the old namespace object)
 * - getUserSessionFromRequest(req) → { session: { user, session } | null }
 * - userModel { get, getByEmail, create, update, fulfill }
 * - sessionUser(user) → CurrentUser
 * - TokenType (removed — Better Auth handles tokens internally)
 * - getSessionOptionsFromRequest (removed — Better Auth handles cookies)
 */
import { auth } from './auth';
import { prisma } from '@entry/db';

export { auth };
export {
  AUTH_ALLOW_SIGNUP,
  AUTH_REQUIRE_EMAIL_VERIFICATION,
  AUTH_PASSWORD_LIMITS,
  AUTH_SESSION_CONFIG,
} from './config';

// ── Types ────────────────────────────────────────────────────────────────────

export interface CurrentUser {
  id: string;
  email: string;
  name: string;
  avatarUrl?: string;
  emailVerified: boolean;
  registered: boolean;
  disabled: boolean;
}

// ── Session helpers ──────────────────────────────────────────────────────────

/**
 * Wraps Better Auth's getSession() to return the same shape that all our
 * API routes expect: { session: { user: CurrentUser, session: Session } | null }.
 *
 * Better Auth returns { session, user } directly — we wrap it to match the
 * old getUserSessionFromRequest() contract so routes don't need changes.
 */
export async function getUserSessionFromRequest(
  req: Request
): Promise<{ session: { user: CurrentUser; session: any } | null; refreshCookie?: string }> {
  const betterAuthSession = await auth.api.getSession({ headers: req.headers });
  if (!betterAuthSession) return { session: null };

  const user = betterAuthSession.user as any;
  return {
    session: {
      user: sessionUser(user),
      session: betterAuthSession.session,
    },
  };
}

/** Transform a Prisma User (or Better Auth user) into the CurrentUser shape. */
export function sessionUser(user: any): CurrentUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.image ?? user.avatarUrl,
    emailVerified: user.emailVerified ?? !!user.emailVerifiedAt,
    registered: user.registered ?? true,
    disabled: user.disabled ?? false,
  };
}

// ── User model (CRUD via Prisma directly — same interface as before) ─────────

export const userModel = {
  async getUser(id: string) {
    const user = await prisma.user.findUnique({ where: { id } });
    return user;
  },

  async getUserByEmail(email: string) {
    const user = await prisma.user.findUnique({ where: { email } });
    return user;
  },

  async createUser(data: { email: string; name: string; password?: string; avatarUrl?: string }) {
    // Better Auth creates users with accounts — but for admin invites etc.
    // we may need to create a bare user. Use Prisma directly.
    const user = await prisma.user.create({
      data: {
        email: data.email,
        name: data.name,
        image: data.avatarUrl,
      },
    });
    return user;
  },

  async updateUser(id: string, data: Partial<{ name: string; email: string; image: string; emailVerified: boolean; registered: boolean; disabled: boolean }>) {
    // Map our field names to Better Auth's Prisma schema
    const prismaData: any = {};
    if (data.name !== undefined) prismaData.name = data.name;
    if (data.email !== undefined) prismaData.email = data.email;
    if (data.image !== undefined) prismaData.image = data.image;
    if (data.emailVerified !== undefined) prismaData.emailVerified = data.emailVerified;
    if (data.registered !== undefined) prismaData.registered = data.registered;
    if (data.disabled !== undefined) prismaData.disabled = data.disabled;

    const user = await prisma.user.update({ where: { id }, data: prismaData });
    return user;
  },

  async fulfillUser(id: string) {
    // Mark user as registered (finished signup)
    return prisma.user.update({ where: { id }, data: { registered: true } });
  },
};

// ── Re-exports for backward compatibility ────────────────────────────────────

// getSessionOptionsFromRequest was used by sign-out and sessions routes.
// Better Auth handles cookies internally — these routes are replaced by
// the catch-all /api/auth/[...all] handler. But if any code still imports
// it, provide a no-op stub.
export function getSessionOptionsFromRequest(_req: Request): { sessionId?: string; userId?: string } {
  return {};
}

// SESSION_COOKIE_NAME / USER_COOKIE_NAME were used by packages/ws for socket auth.
// Better Auth uses its own cookie names. WS auth is handled differently now.
export const SESSION_COOKIE_NAME = 'better-auth.session_token';
export const USER_COOKIE_NAME = 'better-auth.session_token';

// getUserSession was used by packages/ws for socket auth.
export async function getUserSession(
  _sessionId: string,
  _userId?: string
): Promise<{ user: CurrentUser; session: any } | null> {
  // WS socket auth should validate the Better Auth session token via the
  // auth.api.getSession() endpoint. This stub preserves the export shape.
  return null;
}
