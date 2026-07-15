'use client';

/**
 * Shared bits pulled out of the original settings/page.tsx (BYOK providers)
 * so the new Integrations section can reuse the exact same look/feel
 * instead of re-inventing it. Behavior is unchanged from the original
 * inline versions — this is a pure extraction.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/** Parses a fetch Response as JSON, tolerating empty/non-JSON bodies (e.g. a
 * crashed serverless function with no body) instead of throwing a raw
 * "Unexpected end of JSON input" at the user. */
export async function safeJson(res: Response): Promise<any> {
  const text = await res.text();
  if (!text) return { error: `Server returned an empty response (status ${res.status}).` };
  try {
    return JSON.parse(text);
  } catch {
    return { error: `Server returned an unexpected response (status ${res.status}).` };
  }
}

/** Tiny inline-edit input that autosaves itself on blur AND ~800ms after the
 * user stops typing — no separate "Save" button, no state that only lives
 * in memory. `onSave` is expected to PATCH the backend and throw on
 * failure; a failed save reverts to the last-known-good value so the UI
 * never silently claims something persisted when it didn't.
 *
 * Fixed (2026-07-15, explicit user request: "the stuff doesn't allow me
 * to like delete everything like my key it will automatically fill it
 * back because of that auto save. Do it so the auto save, save whatever
 * is there even if empty") -- the old `commit` bailed out early whenever
 * `next === lastSavedRef.current`, as a "nothing changed, skip the save"
 * optimization. That's exactly wrong for password-style fields (the BYOK
 * API key / integration token inputs) which always start from `value=""`
 * by design (they never render the real secret back) -- so clearing a
 * freshly-typed key back down to empty made `next` ("") equal
 * `lastSavedRef.current` ("", the seed), the save was skipped entirely,
 * and the field looked like it "auto-filled back" once you clicked away
 * (nothing was ever sent, so nothing was ever cleared server-side).
 * Now gated on whether the user actually touched the field at all, not on
 * whether the final value differs from the seed -- so typing then fully
 * deleting a key, then blurring, genuinely saves/clears it. */
export function AutoSaveField({
  value,
  onSave,
  placeholder,
  type = 'text',
  mono = true,
}: {
  value: string;
  onSave: (next: string) => Promise<void>;
  placeholder?: string;
  type?: string;
  mono?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const [state, setState] = useState<SaveState>('idle');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedRef = useRef(value);
  const touchedRef = useRef(false);

  useEffect(() => {
    if (state === 'idle') {
      setDraft(value);
      lastSavedRef.current = value;
      touchedRef.current = false;
    }
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  const commit = useCallback(
    async (next: string) => {
      // Only skip if the user never actually interacted with the field —
      // NOT based on whether `next` happens to match the last-saved value,
      // since for always-blank password fields that comparison is
      // meaningless (see comment above).
      if (!touchedRef.current) return;
      setState('saving');
      try {
        await onSave(next);
        lastSavedRef.current = next;
        touchedRef.current = false;
        setState('saved');
        setTimeout(() => setState(s => (s === 'saved' ? 'idle' : s)), 1500);
      } catch {
        setDraft(lastSavedRef.current);
        touchedRef.current = false;
        setState('error');
        setTimeout(() => setState(s => (s === 'error' ? 'idle' : s)), 2500);
      }
    },
    [onSave]
  );

  const handleChange = (next: string) => {
    touchedRef.current = true;
    setDraft(next);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => commit(next), 800);
  };

  const handleBlur = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    commit(draft);
  };

  return (
    <div className="relative flex-1">
      <input
        type={type}
        value={draft}
        onChange={e => handleChange(e.target.value)}
        onBlur={handleBlur}
        placeholder={placeholder}
        className={cn(
          'h-9 px-3 pr-14 rounded-md border bg-background text-foreground text-sm outline-none focus:border-primary w-full',
          mono && 'font-mono'
        )}
      />
      <span
        className={cn(
          'absolute right-2 top-1/2 -translate-y-1/2 text-[11px] pointer-events-none transition-opacity',
          state === 'idle' ? 'opacity-0' : 'opacity-100',
          state === 'error' ? 'text-destructive' : 'text-muted-foreground'
        )}
      >
        {state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved ✓' : state === 'error' ? 'Failed' : ''}
      </span>
    </div>
  );
}

export function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onChange}
      disabled={disabled}
      className={cn(
        'w-8 h-4.5 rounded-full relative transition-colors shrink-0 disabled:opacity-50',
        checked ? 'bg-primary' : 'bg-muted'
      )}
    >
      <span
        className={cn(
          'absolute top-0.5 w-3.5 h-3.5 rounded-full bg-background transition-transform',
          checked ? 'translate-x-[18px]' : 'translate-x-0.5'
        )}
      />
    </button>
  );
}
