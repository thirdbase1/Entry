// Process-level safety net, loaded via `node --require` (NODE_OPTIONS).
// Committed directly to the repo (not generated at build time) so it
// exists at a stable path from git checkout onward -- Render applies
// NODE_OPTIONS to BOTH the build command and the start command, so a
// path under .output/ (which only exists after build) breaks the build.
//
// Why this exists: @workflow/world-postgres's initial Postgres connection
// can raise a raw EventEmitter 'error' during the connect-timeout handshake
// that bypasses any try/catch (see patches/eve and
// patches/@workflow+world-postgres). Registering these handlers at the top
// of index.mjs is not early enough either -- ESM import graphs evaluate
// depth-first before any of the importing file's own top-level statements
// run, so eve.mjs's whole transitive graph (where that crash originates)
// still runs first regardless of textual position. A --require preload is
// a genuinely earlier, separate phase, so this always registers first.
process.on('uncaughtException', (err) => {
  console.error('[BOOT-HANG FIX] uncaughtException survived (server keeps running):', err && err.stack || err);
});
process.on('unhandledRejection', (err) => {
  console.error('[BOOT-HANG FIX] unhandledRejection survived (server keeps running):', err && err.stack || err);
});
console.error('[BOOT-TRACE] safety-net.cjs preloaded via --require, pid=' + process.pid, new Date().toISOString());
