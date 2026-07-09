/**
 * Replaces core/features/service.ts (`FeatureService`). Ported 1:1: staff
 * domain check, admin add/check, early-access add/remove/check/gate.
 *
 * `EARLY_ACCESS_CONTROL_ENABLED` is now `false` — Entry is fully live in
 * production (rebrand + relaunch), so there's no more waitlist/early-access
 * gate. Anyone can sign up and sign in immediately. Kept as a named code
 * constant (not an env var) since it's a one-time product-launch decision,
 * not per-deployment config — flip it back in code if a gated beta is ever
 * needed again.
 */
import * as userFeature from './models/user-feature';
import { userModel } from '@entry/auth';

const STAFF_DOMAINS = ['@entry.io'];

export function isStaff(email: string): boolean {
  return STAFF_DOMAINS.some(domain => email.endsWith(domain));
}

export function isAdmin(userId: string) {
  return userFeature.hasUserFeature(userId, 'administrator' as any);
}

export function addAdmin(userId: string) {
  return userFeature.addUserFeature(userId, 'administrator' as any, 'Admin user');
}

export function addEarlyAccess(userId: string) {
  return userFeature.addUserFeature(userId, 'early_access' as any, 'Early access user');
}

export function removeEarlyAccess(userId: string) {
  return userFeature.removeUserFeature(userId, 'early_access' as any);
}

export function isEarlyAccessUser(userId: string) {
  return userFeature.hasUserFeature(userId, 'early_access' as any);
}

// Hardcoded, not an env var — see file header. false = fully live, no gate.
const EARLY_ACCESS_CONTROL_ENABLED = false;

export async function canEarlyAccess(email: string): Promise<boolean> {
  if (EARLY_ACCESS_CONTROL_ENABLED && !isStaff(email)) {
    const user = await userModel.getUserByEmail(email);
    if (!user) return false;
    return isEarlyAccessUser(user.id);
  }
  return true;
}
