# Chat Performance & Indicator Fixes

## Changes Made

### 1. PendingTurn Staleness Fix (Old Chats)
**File:** `apps/web/components/chat/direct-chat-interface.tsx` (~line 356)

**Problem:** The pendingTurn seed heuristic guessed "turn is still running" for any chat whose last message was from the user. This is only sound while the turn could plausibly still be running. Old chats with interrupted turns from days ago never settled — the indicator spun forever, composer stayed locked.

**Fix:** Added `MAX_RESUMABLE_AGE_MS` (2h, 2× the server's 1h tool timeout). The seed now checks `snapshotUpdatedAt` against wall-clock time. A turn whose last persisted message is older than the server's hard ceiling is treated as NOT resumable.

### 2. Recovery Poll Early Return Fix (New/Empty Chats)
**File:** `apps/web/components/chat/direct-chat-interface.tsx` (~line 861)

**Problem:** The recovery poll's `if (!persisted || persisted.length === 0) return;` returned before reaching the settle check. Chats that loaded with no persisted messages (fresh sessions, or snapshot API returning `events: []`) and had `pendingTurn: true` from the seed would poll forever without ever settling — the thinking indicator never cleared.

**Fix:** Changed the guard to `if (!persisted) return;`. An empty persisted array (`[]`) now falls through to the settle check (quiet-time + `/turn-status` ping), which correctly determines the turn is idle and clears `pendingTurn`. Only `persisted === null` (snapshot shape mismatch) still exits early.

## Verification
- `npx tsc --noEmit -p apps/web/tsconfig.json` — passes with 0 errors