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
  /** Monthly AI usage allowance, denominated in Entry Credits (1 credit ==
   * $1 of official vendor-rate model usage, blended input/output) -- NOT
   * raw dollars charged to the user and NOT 1:1 with our actual cash cost
   * (2026-07-19 pricing pass: our supply cost runs well under face value,
   * so Entry Credits are deliberately the abstraction users see/spend,
   * decoupled from whatever the underlying supplier deal is this month).
   * `undefined` == no monthly allowance concept applies (e.g. feature-only
   * flags reuse this same shape's EMPTY_CONFIG, not this one). */
  aiCreditAllowance: z.number().optional(),
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
  StarterPlan = 'starter_plan_v1',
  ProPlan = 'pro_plan_v1',
  PowerPlan = 'power_plan_v1',
  StudioPlan = 'studio_plan_v1',
}

export const FeaturesShapes = {
  administrator: EMPTY_CONFIG,
  early_access: EMPTY_CONFIG,
  unlimited_copilot: EMPTY_CONFIG,
  free_plan_v1: UserPlanQuotaConfig,
  starter_plan_v1: UserPlanQuotaConfig,
  pro_plan_v1: UserPlanQuotaConfig,
  power_plan_v1: UserPlanQuotaConfig,
  studio_plan_v1: UserPlanQuotaConfig,
} satisfies Record<FeatureName, z.ZodObject<any>>;

export type FeatureNameKey = keyof typeof FeaturesShapes;
export type FeatureConfig<T extends FeatureNameKey> = z.infer<(typeof FeaturesShapes)[T]>;

// Pricing pass (2026-07-19): supplier sells $30 of official-rate Claude
// usage for 2 USDT (~6.7% of face value), across every Claude model except
// Mythos (i.e. Fable 5 and below are all in). Tiers below price Entry
// Credits (see aiCreditAllowance's doc comment) at roughly a consistent
// ~75-85% blended gross margin against that supply cost, tapering slightly
// at the top since higher tiers lean on Fable 5/Opus, which burn face-value
// credits far faster per request than Sonnet/Haiku. Numbers are a starting
// proposal pending the real spec PDF -- only this object needs to change
// once real numbers land, nothing else in the codebase hardcodes prices.
export const FeatureConfigs: {
  [K in FeatureNameKey]: { type: FeatureType; configs: FeatureConfig<K> };
} = {
  free_plan_v1: {
    type: FeatureType.Quota,
    configs: { name: 'Free', blobLimit: 10 * OneMB, storageQuota: 10 * OneGB, copilotLimit: undefined, aiCreditAllowance: 2 },
  },
  starter_plan_v1: {
    type: FeatureType.Quota,
    configs: { name: 'Starter', blobLimit: 25 * OneMB, storageQuota: 25 * OneGB, copilotLimit: undefined, aiCreditAllowance: 25 },
  },
  pro_plan_v1: {
    type: FeatureType.Quota,
    configs: { name: 'Pro', blobLimit: 100 * OneMB, storageQuota: 100 * OneGB, copilotLimit: undefined, aiCreditAllowance: 60 },
  },
  power_plan_v1: {
    type: FeatureType.Quota,
    configs: { name: 'Power', blobLimit: 250 * OneMB, storageQuota: 250 * OneGB, copilotLimit: undefined, aiCreditAllowance: 150 },
  },
  studio_plan_v1: {
    type: FeatureType.Quota,
    configs: { name: 'Studio', blobLimit: 500 * OneMB, storageQuota: 500 * OneGB, copilotLimit: undefined, aiCreditAllowance: 400 },
  },
  administrator: { type: FeatureType.Feature, configs: {} },
  early_access: { type: FeatureType.Feature, configs: {} },
  unlimited_copilot: { type: FeatureType.Feature, configs: {} },
};
