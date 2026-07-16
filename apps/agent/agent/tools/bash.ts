import { defineTool } from 'eve/tools';
import { bash } from '../lib/tool-impls/bash.js';

/**
 * FIXED (2026-07-16, real bug: this was the one tool of eve's 21 still
 * using the framework's own bare `defineBashTool` (executeBashOnSandbox in
 * eve/dist/src/execution/sandbox/bash-tool.js) instead of the shared,
 * already-hardened `lib/tool-impls/bash.ts` every other tool re-exports
 * here. That raw version has no timeout at all AND no safe-error
 * wrapping -- a hung command rides the full 300s maxDuration with nothing
 * surfaced, and any thrown error (bad sandbox, killed process, etc.)
 * propagates uncaught instead of becoming a normal tool-error result the
 * model can see and react to -- exactly the "agent stops itself / times
 * out waiting on a tool call" class of bug already fixed everywhere else
 * via with-timeout-signal.ts + safe-execute.ts. Switching to the shared
 * impl (120s timeout, safeExecute-wrapped) closes this last gap so eve's
 * main chat path gets the same protection direct/BYOK chat already had.
 */
export default defineTool(bash as any);
