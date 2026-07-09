/**
 * Replaces models/feature.ts (`FeatureModel`). Ported onto the shared
 * `prisma` client. `refreshFeatures()` (seed/upsert every FeatureConfigs
 * entry into the DB) is meant to run once at deploy/migration time —
 * exposed here as a plain function; a workflow/migration script should
 * call it (not wired to a route yet, flagged in ROADMAP.md).
 */
import { prisma } from '@entry/db';

import { FeatureConfigs, FeaturesShapes, FeatureType, type FeatureConfig, type FeatureNameKey } from '../common';

export async function getFeatureUnchecked(name: FeatureNameKey) {
  const feature = await prisma.feature.findFirst({ where: { name } });
  if (!feature) throw new Error(`Feature ${name} not found`);
  return feature as typeof feature & { configs: Record<string, any> };
}

export function checkFeatureConfig<T extends FeatureNameKey>(name: T, config: unknown): FeatureConfig<T> {
  const shape = FeaturesShapes[name] ?? ({} as any);
  const result = shape.safeParse(config);
  if (!result.success) throw new Error(`Invalid feature config for ${name}`, { cause: result.error });
  return result.data as FeatureConfig<T>;
}

export async function getFeature<T extends FeatureNameKey>(name: T) {
  const feature = await getFeatureUnchecked(name);
  return { ...feature, configs: checkFeatureConfig(name, feature.configs) };
}

export function getFeatureType(name: FeatureNameKey): FeatureType {
  return FeatureConfigs[name].type;
}

async function upsertFeature<T extends FeatureNameKey>(name: T, configs: FeatureConfig<T>) {
  const parsed = checkFeatureConfig(name, configs);
  const latest = await prisma.feature.findFirst({ where: { name } });
  if (!latest) {
    return prisma.feature.create({ data: { name, configs: parsed as any } });
  }
  return prisma.feature.update({ where: { id: latest.id }, data: { configs: parsed as any } });
}

/** Seeds/refreshes every hardcoded FeatureConfigs entry into the DB. Run once at deploy time. */
export async function refreshFeatures(): Promise<void> {
  for (const name of Object.keys(FeatureConfigs) as FeatureNameKey[]) {
    await upsertFeature(name, FeatureConfigs[name].configs as any);
  }
}
