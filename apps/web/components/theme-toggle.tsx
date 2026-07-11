'use client';

/**
 * Sun/moon toggle. Plain inline SVGs (not @blocksuite/icons — that set has
 * no sun/moon glyph, checked: no Sun, Moon, or Brightness icon export
 * anywhere in its .d.ts) drawn in the same stroke-based style already used elsewhere
 * in this file's neighborhood (main-layout.tsx's own sidebar-toggle button
 * icon), so it doesn't introduce a visually different icon language.
 *
 * Mounted only after client mount (the `mounted` guard) — next-themes'
 * `resolvedTheme` is unknown during SSR/first paint by design (it depends
 * on localStorage / matchMedia, neither available on the server), so
 * rendering an icon before that resolves would flash the wrong one.
 */
import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';
import { cn } from '@/lib/utils';

function SunIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  );
}

function MoonIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
    </svg>
  );
}

export function ThemeToggle({ className }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!mounted) {
    return <div className={cn('w-6 h-6', className)} />;
  }

  const isDark = resolvedTheme === 'dark';

  return (
    <button
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      className={cn('p-1 rounded hover:bg-accent transition-colors text-muted-foreground', className)}
    >
      {isDark ? <SunIcon className="w-4 h-4" /> : <MoonIcon className="w-4 h-4" />}
    </button>
  );
}
