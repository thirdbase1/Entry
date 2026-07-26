'use client';

/**
 * Real brand-logo glyph for a model in the Usage table (owner ask
 * 2026-07-26: "why don't you show real logo, exactly as the model
 * selector in chat does"). Previously this was its own hand-rolled
 * letter-monogram guesser (regex table -> flat colored initial) that
 * duplicated -- and drifted from -- the actual brand-icon set the chat
 * model selector already uses. Now a thin wrapper around the exact same
 * two functions chat-config.tsx calls (inferModelFamily + getProviderIcon)
 * so a model shows the identical lobehub SVG logo everywhere in the app,
 * never a different fallback depending on which screen you're looking at.
 */
import { inferModelFamily } from '@/lib/model-provider';
import { getProviderIcon } from '@/components/icons/provider-icons';

export function ModelIcon({ modelId, size = 20 }: { modelId: string; size?: number }) {
  const family = inferModelFamily(modelId);
  const Icon = getProviderIcon(family);
  return (
    <span
      className="inline-flex items-center justify-center rounded-md shrink-0 overflow-hidden bg-muted/40"
      style={{ width: size, height: size }}
    >
      <Icon width={size * 0.75} height={size * 0.75} />
    </span>
  );
}
