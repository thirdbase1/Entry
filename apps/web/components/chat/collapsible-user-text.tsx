'use client';

/**
 * Collapses LONG user messages behind a "Show more" toggle (2026-07-19,
 * user request: "when we send a very long message ... only if I press
 * see more should it show ... and something to click to make it chunk
 * back"). A pasted wall of text (logs, a whole file, a long prompt) used
 * to permanently dominate the transcript; now it renders as a short
 * preview + explicit expand/collapse.
 *
 * Deliberately USER-messages-only: assistant replies already have their
 * own presentation rules (markdown, reasoning accordions, tool cards),
 * and truncating the agent's answer would hide the actual deliverable.
 *
 * Two render paths on purpose:
 * - short message (under both thresholds): `full` is rendered directly,
 *   zero behavior change vs. before this component existed.
 * - long message: collapsed shows a PLAIN-TEXT preview (first lines,
 *   char-capped) so a pasted markdown/code blob can't render half a
 *   giant table as its "preview"; expanded shows `full` (each call site
 *   passes whatever it was already rendering pre-collapse) plus a
 *   "Show less" toggle to fold it back.
 *
 * Used by both chat UIs (direct-chat-interface.tsx bubble and
 * message-renderer.tsx's user branch) so the two paths stay in parity.
 */
import { useState, type ReactNode } from 'react';

// A message is "long" past EITHER threshold -- chars catches one-line
// walls (a minified blob), lines catches short-lined pastes (logs,
// stack traces) that are tall without being char-heavy.
const COLLAPSE_CHAR_THRESHOLD = 800;
const COLLAPSE_LINE_THRESHOLD = 12;
const PREVIEW_MAX_CHARS = 450;
const PREVIEW_MAX_LINES = 6;

export function isLongUserText(text: string): boolean {
  return text.length > COLLAPSE_CHAR_THRESHOLD || text.split('\n').length > COLLAPSE_LINE_THRESHOLD;
}

export function CollapsibleUserText({ text, full }: { text: string; full: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  if (!isLongUserText(text)) return <>{full}</>;

  let preview = text.split('\n').slice(0, PREVIEW_MAX_LINES).join('\n');
  if (preview.length > PREVIEW_MAX_CHARS) preview = preview.slice(0, PREVIEW_MAX_CHARS);

  const toggle = (
    <button
      type="button"
      onClick={() => setExpanded(e => !e)}
      aria-expanded={expanded}
      // currentColor + opacity so this reads correctly on BOTH user-bubble
      // styles (primary bg in direct chat, neutral #f3f3f3 in eve's).
      className="block mt-1.5 text-xs font-medium underline underline-offset-2 opacity-75 hover:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 cursor-pointer"
    >
      {expanded ? 'Show less' : `Show more (${text.length.toLocaleString()} characters)`}
    </button>
  );

  if (expanded) {
    return (
      <span className="min-w-0">
        {full}
        {toggle}
      </span>
    );
  }
  return (
    <span className="min-w-0">
      <span className="whitespace-pre-wrap break-words">{preview.trimEnd()}…</span>
      {toggle}
    </span>
  );
}
