/**
 * Ported 1:1 from packages/frontend/app/src/lib/utils.ts. The `text()`
 * helper originally returned a vanilla-extract `CSSProperties` object for
 * use inside `.css.ts` style()` calls; since component styles here are
 * CSS Modules instead (see app/globals.css comment), it now returns a
 * plain React inline-style object — same shape, same call sites' intent.
 */
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import type { CSSProperties } from 'react';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function text(
  size: number,
  lineHeight: number,
  fontWeight: number,
  options: { ellipsis?: boolean } = {}
): CSSProperties {
  const style: CSSProperties = {
    fontSize: size,
    lineHeight: `${lineHeight}px`,
    fontWeight,
  };
  if (options.ellipsis) {
    style.overflow = 'hidden';
    style.textOverflow = 'ellipsis';
    style.whiteSpace = 'nowrap';
  }
  return style;
}

export async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  }
}
