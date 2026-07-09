/**
 * Replaces core/quota/service.ts (`QuotaService`) + core/quota/types.ts's
 * `UserQuotaHumanReadableType`/`UserQuotaType`. GraphQL `@ObjectType`/
 * `@Field` decorators dropped (no GraphQL layer in this migration — REST
 * Route Handlers instead), plain interfaces/functions otherwise identical.
 *
 * `@OnEvent('user.postCreated')` → the original wires quota setup as a
 * side-effect of user creation via NestJS's event emitter. Ported as a
 * plain export (`setupUserBaseQuota`) that the user-creation call site
 * (models/user.ts's `createUser`) calls directly instead of an event bus —
 * simpler, same effect, no event-emitter infra needed for a single
 * subscriber.
 */
import { InternalServerError } from './errors';
import * as userFeature from './models/user-feature';
import { formatSize } from './utils';
import type { UserQuota } from './common';

export type { UserQuota };

export interface UserQuotaHumanReadable {
  name: string;
  blobLimit: string;
  storageQuota: string;
  usedStorageQuota: string;
  copilotLimit: string;
}

export type UserQuotaWithUsage = UserQuota & { usedStorageQuota: number };

export async function setupUserBaseQuota(userId: string): Promise<void> {
  await userFeature.addUserFeature(userId, 'free_plan_v1' as any, 'sign up');
}

export async function getUserQuota(userId: string): Promise<UserQuota> {
  let quota = await userFeature.getUserQuota(userId);

  if (!quota) {
    await setupUserBaseQuota(userId);
    quota = await userFeature.getUserQuota(userId);
  }

  if (!quota) throw new InternalServerError('User quota not found and can not be created.');

  return quota.configs as UserQuota;
}

// TODO(Phase 4/5 — storage): implement real blob-storage usage accounting once
// the storage/blob layer is ported. Matches the original's own TODO.
export async function getUserStorageUsage(_userId: string): Promise<number> {
  return 0;
}

export async function getUserQuotaWithUsage(userId: string): Promise<UserQuotaWithUsage> {
  const quota = await getUserQuota(userId);
  const usedStorageQuota = await getUserStorageUsage(userId);
  return { ...quota, usedStorageQuota };
}

export function formatUserQuota(quota: UserQuotaWithUsage): UserQuotaHumanReadable {
  return {
    name: quota.name,
    blobLimit: formatSize(quota.blobLimit),
    storageQuota: formatSize(quota.storageQuota),
    usedStorageQuota: formatSize(quota.usedStorageQuota),
    copilotLimit: quota.copilotLimit ? formatSize(quota.copilotLimit) : 'Unlimited',
  };
}

function generateQuotaCalculator(storageQuota: number, blobLimit: number, usedQuota: number, unlimited = false) {
  return (recvSize: number) => {
    const currentSize = usedQuota + recvSize;
    if (currentSize > storageQuota && !unlimited) {
      return { storageQuotaExceeded: true, blobQuotaExceeded: false };
    } else if (recvSize > blobLimit) {
      return { storageQuotaExceeded: false, blobQuotaExceeded: true };
    }
    return undefined;
  };
}

export async function getUserQuotaCalculator(userId: string) {
  const quota = await getUserQuota(userId);
  const usedSize = 0;
  return generateQuotaCalculator(quota.storageQuota, quota.blobLimit, usedSize);
}
