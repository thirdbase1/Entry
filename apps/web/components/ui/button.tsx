/**
 * Scoped port of packages/frontend/component/src/ui/button/button.tsx —
 * only the props actually exercised by pages ported so far
 * (onClick/disabled/children/className). The original also supports
 * loading spinners, prefix/suffix icons, and tooltips via `Loading` and
 * `Tooltip` sub-components; those are NOT ported here since no ported
 * page uses them yet. Extend this (not silently fork a second Button)
 * when a page needs those props — flagged in ROADMAP.md as explicit
 * remaining work, not hidden.
 */
'use client';
import type { ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';
import styles from './button.module.css';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {}

export function Button({ className, children, ...props }: ButtonProps) {
  return (
    <button className={cn(styles.button, className)} {...props}>
      {children}
    </button>
  );
}
