/**
 * Replaces models/user-feature.ts (`UserFeatureModel`). Ported onto the
 * shared `prisma` client, same method surface (get/getQuota/has/list/add/
 * remove/switchQuota). `switchQuota`'s `@Transactional()` decorator (nestjs-cls
 * transactional AsyncLocalStorage magic) isn't available outside Nest DI —
 * ported as an explicit `prisma.$transaction(...)` instead, same atomicity
 * guarantee, more portable.
 */
import { prisma, type Prisma } from '@entry/db';

import { FeatureType, type FeatureNameKey } from '../common';
import { getFeature, getFeatureType, getFeatureUnchecked } from './feature';

export async function getUserFeature(userId: string, name: FeatureNameKey) {
  const count = await prisma.userFeature.count({ where: { userId, name, activated: true } });
  if (count === 0) return null;
  return getFeature(name);
}

export async function getUserQuota(userId: string) {
  const quota = await prisma.userFeature.findFirst({
    where: { userId, type: FeatureType.Quota, activated: true },
  });
  if (!quota) return null;
  return getFeature(quota.name as FeatureNameKey);
}

export async function hasUserFeature(userId: string, name: FeatureNameKey): Promise<boolean> {
  const count = await prisma.userFeature.count({ where: { userId, name, activated: true } });
  return count > 0;
}

export async function listUserFeatures(userId: string, type?: FeatureType): Promise<FeatureNameKey[]> {
  const where: Prisma.UserFeatureWhereInput =
    type === undefined ? { userId, activated: true } : { userId, activated: true, type };
  const rows = await prisma.userFeature.findMany({ where, select: { name: true } });
  return rows.map(r => r.name as FeatureNameKey);
}

export async function addUserFeature(userId: string, name: FeatureNameKey, reason: string) {
  const feature = await getFeatureUnchecked(name);
  const existing = await prisma.userFeature.findFirst({ where: { userId, name, activated: true } });
  if (existing) return existing;

  return prisma.userFeature.create({
    data: { userId, featureId: feature.id, name, type: getFeatureType(name), activated: true, reason },
  });
}

export async function removeUserFeature(userId: string, name: FeatureNameKey): Promise<number> {
  const { count } = await prisma.userFeature.updateMany({ where: { userId, name }, data: { activated: false } });
  return count;
}

export async function switchUserQuota(userId: string, to: FeatureNameKey, reason: string): Promise<void> {
  await prisma.$transaction(async tx => {
    const quotas = await tx.userFeature.findMany({
      where: { userId, activated: true, type: FeatureType.Quota },
      select: { name: true },
    });

    if (quotas.length) {
      const from = quotas.at(-1)!.name as FeatureNameKey;
      if (from === to) return;
      await tx.userFeature.updateMany({ where: { userId, name: from }, data: { activated: false } });
    }

    const feature = await getFeatureUnchecked(to);
    const existing = await tx.userFeature.findFirst({ where: { userId, name: to, activated: true } });
    if (!existing) {
      await tx.userFeature.create({
        data: { userId, featureId: feature.id, name: to, type: getFeatureType(to), activated: true, reason },
      });
    }
  });
}
