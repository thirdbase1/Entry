-- Distinguishes a real, user-facing version (created at the true end of a
-- turn, with a chat card) from the silent per-step safety-net snapshots
-- captureVersionFromSandboxDiff also writes (skipCard: true, no card) --
-- see ChatVersion.hasCard's schema comment for the full incident.
-- Defaulting existing rows to TRUE is deliberately conservative: it never
-- hides any version history a user has already seen/relied on, it only
-- starts correctly separating the two going forward.
ALTER TABLE "chat_versions" ADD COLUMN "has_card" BOOLEAN NOT NULL DEFAULT true;
