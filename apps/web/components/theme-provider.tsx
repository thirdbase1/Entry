'use client';

/**
 * Thin wrapper around next-themes. attribute="data-theme" + the value map
 * below is deliberate, not the library's default ("class"): this app's
 * entire color system already flows through @toeverything/theme's CSS
 * variables (globals.css's --color-* tokens -> --affine-v2-* vars), and
 * that package's compiled style.css already ships a full dark palette
 * gated behind [data-theme=dark]/[data-theme=light] selectors (confirmed
 * directly in node_modules/@toeverything/theme/dist/style.css) — it's the
 * exact mechanism AFFiNE (the original app this is ported from) uses for
 * its own dark mode. So no new color values needed anywhere, no `dark:`
 * Tailwind variants needed in any of the ~40+ component files that already
 * use bg-card/text-foreground/etc. — this provider just needs to flip the
 * one attribute those variables are already listening for.
 */
import { ThemeProvider as NextThemesProvider } from 'next-themes';

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider
      attribute="data-theme"
      defaultTheme="system"
      enableSystem
      themes={['light', 'dark']}
      disableTransitionOnChange
    >
      {children}
    </NextThemesProvider>
  );
}
