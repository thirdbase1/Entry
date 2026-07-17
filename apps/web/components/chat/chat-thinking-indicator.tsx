'use client';

/**
 * Extracted (2026-07-17, "improve streaming x5") from
 * direct-chat-interface.tsx's own inline `ThinkingIndicator` so
 * chat-interface.tsx (the default eve-agent path) can show the exact
 * same pre-content latency placeholder -- previously only the direct/BYOK
 * path had one at all; the default path went from "message sent" straight
 * to whatever content showed up with zero visible feedback in between.
 */
export function ThinkingIndicator() {
  return (
    <div className="flex items-center gap-1.5 text-sm text-muted-foreground py-1">
      <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:-0.2s]" />
      <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:-0.1s]" />
      <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/60 animate-bounce" />
    </div>
  );
}
