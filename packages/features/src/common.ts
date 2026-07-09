/**
 * Replaces models/common/feature.ts. Ported verbatim: same feature names,
 * same enum, same quota numbers (Free: 10MB blob / 10GB storage; Pro:
 * 100MB blob / 100GB storage; both uncapped copilot), same zod shapes.
 */
import { z } from 'zod';

const OneKB = 1024;
const OneMB = OneKB * OneKB;
const OneGB = OneKB * OneMB;

const UserPlanQuotaConfig = z.object({
  name: z.string(),
  blobLimit: z.number(),
  storageQuota: z.number(),
  copilotLimit: z.number().optional(),
});

export type UserQuota = z.infer<typeof UserPlanQuotaConfig>;

const EMPTY_CONFIG = z.object({});

export enum FeatureType {
  Feature = 0,
  Quota = 1,
}

export enum FeatureName {
  Administrator = 'administrator',
  EarlyAccess = 'early_access',
  UnlimitedCopilot = 'unlimited_copilot',
  FreePlan = 'free_plan_v1',
  ProPlan = 'pro_plan_v1',
}

export const FeaturesShapes = {
  administrator: EMPTY_CONFIG,
  early_access: EMPTY_CONFIG,
  unlimited_copilot: EMPTY_CONFIG,
  free_plan_v1: UserPlanQuotaConfig,
  pro_plan_v1: UserPlanQuotaConfig,
} satisfies Record<FeatureName, z.ZodObject<any>>;

export type FeatureNameKey = keyof typeof FeaturesShapes;
export type FeatureConfig<T extends FeatureNameKey> = z.infer<(typeof FeaturesShapes)[T]>;

export const FeatureConfigs: {
  [K in FeatureNameKey]: { type: FeatureType; configs: FeatureConfig<K> };
} = {
  free_plan_v1: {
    type: FeatureType.Quota,
    configs: { name: 'Free', blobLimit: 10 * OneMB, storageQuota: 10 * OneGB, copilotLimit: undefined },
  },
  pro_plan_v1: {
    type: FeatureType.Quota,
    configs: { name: 'Pro', blobLimit: 100 * OneMB, storageQuota: 100 * OneGB, copilotLimit: undefined },
  },
  administrator: { type: FeatureType.Feature, configs: {} },
  early_access: { type: FeatureType.Feature, configs: {} },
  unlimited_copilot: { type: FeatureType.Feature, configs: {} },
};
