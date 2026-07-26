-- PERFORMANCE (2026-07-26, "9x better overall" pass): the Versions tab
-- list route is the single hottest query in the whole versioning feature
-- -- WHERE chat_id = X AND has_card = true ORDER BY version_number DESC
-- -- hit on every tab open and every silent poll tick for every open
-- chat. The existing (chat_id, version_number) unique index lets Postgres
-- scan in the right order already, but it still has to walk past every
-- hidden per-step safety-net snapshot row (has_card = false; typically
-- several per real turn) to collect a page of real ones. This lets it
-- jump straight to has_card = true rows in version_number order instead.
CREATE INDEX "chat_versions_chat_id_has_card_version_number_idx" ON "chat_versions"("chat_id", "has_card", "version_number");
