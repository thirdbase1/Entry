'use client';

/**
 * Ported 1:1 from pages/layout/auto-sidebar-padding.tsx.
 * Wraps children with dynamic left padding based on sidebar open/closed state.
 * When the sidebar is collapsed, adds 40px extra left padding so content
 * doesn't overlap the collapsed sidebar.
 */
import type { HTMLAttributes } from 'react';

import { useSidebarStore } from '@/store/sidebar';

export function AutoSidebarPadding({
  style,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  const { open } = useSidebarStore();

  const inputPaddingLeft = style?.paddingLeft ?? 0;

  return (
    <div
      {...props}
      style={{
        ...style,
        paddingLeft: `calc(${inputPaddingLeft}px + ${open ? 0 : 40}px)`,
      }}
    >
      {children}
    </div>
  );
}
