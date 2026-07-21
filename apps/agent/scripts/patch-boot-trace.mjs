// TEMPORARY diagnostic + hardening patch, added 2026-07-21 to fix a Render
// silent-startup hang: @workflow/world-postgres's initial Postgres pool
// connection had no connectionTimeoutMillis (see the
// @workflow+world-postgres patch), and even after bounding it, pg/pg-pool's
// timeout-triggered stream.destroy() during the CONNECT handshake raises an
// 'error' event outside of any promise chain -- an unhandled EventEmitter
// error that crashes the whole process via Node's uncaughtException path,
// even though our try/catch around the awaited call is fine. This installs
// a process-level safety net as literally the first thing index.mjs
// executes (before eve's own nitro plugin init, and before eve's OWN
// trapUnhandledErrors() which only registers *after* serve() is reached --
// too late for a crash that happens *during* plugin init/boot). Once we've
// confirmed the deploy is healthy this can be narrowed/removed, but leaving
// a permanent safety net here is also just good practice: one flaky
// dependency's socket error should never be able to kill the whole server.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outputDir = join(here, '..', '.output', 'server');

const traceMarkerFor = (label) =>
  `console.error('[BOOT-TRACE] ${label}: TOP OF FILE, pid=' + process.pid + ' uptime=' + process.uptime(), new Date().toISOString());\n`;

const safetyNet = [
  "process.on('uncaughtException', (err) => {",
  "  console.error('[BOOT-HANG FIX] uncaughtException survived (server keeps running):', err && err.stack || err);",
  "});",
  "process.on('unhandledRejection', (err) => {",
  "  console.error('[BOOT-HANG FIX] unhandledRejection survived (server keeps running):', err && err.stack || err);",
  "});",
  "",
].join('\n');

const targets = [
  { file: join(outputDir, 'index.mjs'), label: 'index.mjs', withSafetyNet: true },
  { file: join(outputDir, '_libs', 'eve.mjs'), label: 'eve.mjs', withSafetyNet: false },
];

for (const { file, label, withSafetyNet } of targets) {
  if (!existsSync(file)) {
    console.log(`[patch-boot-trace] skip (not found): ${file}`);
    continue;
  }
  const content = readFileSync(file, 'utf8');
  if (content.startsWith('console.error(\'[BOOT-TRACE]') || content.startsWith("process.on('uncaughtException'")) {
    console.log(`[patch-boot-trace] already patched: ${file}`);
    continue;
  }
  const prefix = (withSafetyNet ? safetyNet : '') + traceMarkerFor(label);
  writeFileSync(file, prefix + content);
  console.log(`[patch-boot-trace] patched: ${file}${withSafetyNet ? ' (+ safety net)' : ''}`);
}

