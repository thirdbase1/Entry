/**
 * Single source of truth for "which model ids are Mythos-class" (owner's
 * standing instruction: "Hide 'Mythos' models entirely from the model
 * picker").
 *
 * ADDED (2026-08-05, real bug found by full-codebase audit): before this
 * file existed, the ONLY thing keeping claude-fable-5 (Mythos-class, see
 * seed-freemodel-provider/route.ts's header comment for the pricing/
 * naming confirmation) out of the picker was a manual admin toggle click
 * in the DB -- nothing in code actually enforced it. The idempotent seed
 * route that provisions that model was itself setting `isEnabled: true`
 * unconditionally on every run, one re-seed away from silently undoing
 * the hide with no visible signal that it had happened.
 *
 * Import this from ANY place that can set a UserModelProviderModel row's
 * `isEnabled` to true (seed routes, the admin shared-providers PATCH
 * toggle, any future one) and refuse/skip enabling a match -- see
 * `isMythosClassModelId` below. Centralized here (not duplicated per
 * file) specifically so the next new seed route or admin action
 * automatically inherits the guard instead of needing to remember it.
 */

/** Exact known Mythos-class model ids. Matched case-insensitively against
 *  the raw `modelId` column value (never the display label, which varies
 *  per provider/alias) -- extend this list, never work around it, if
 *  another Mythos-class id ever needs seeding for pricing/history
 *  purposes without ever being enabled in the picker. */
const MYTHOS_CLASS_MODEL_IDS = new Set<string>(['claude-fable-5']);

export function isMythosClassModelId(modelId: string): boolean {
  return MYTHOS_CLASS_MODEL_IDS.has(modelId.trim().toLowerCase());
}

export { MYTHOS_CLASS_MODEL_IDS };
