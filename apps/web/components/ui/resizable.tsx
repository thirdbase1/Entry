'use client';

/**
 * Ported from components/ui/resizable.tsx.
 * Thin wrapper around react-resizable-panels v4 with shadcn-style data slots.
 * v4 renamed: PanelGroup→Group, PanelResizeHandle→Separator, direction→orientation.
 */
import * as React from 'react';
import { Group, Panel, Separator, type GroupProps, type PanelProps, type SeparatorProps } from 'react-resizable-panels';

import { cn } from '@/lib/utils';

function ResizablePanelGroup({
  className,
  ...props
}: GroupProps) {
  return (
    <Group
      data-slot="resizable-panel-group"
      className={cn(
        'flex h-full w-full data-[orientation=vertical]:flex-col',
        className
      )}
      {...props}
    />
  );
}

function ResizablePanel({
  ...props
}: PanelProps) {
  return <Panel data-slot="resizable-panel" {...props} />;
}

function ResizableHandle({
  className,
  ...props
}: SeparatorProps) {
  return (
    <Separator
      data-slot="resizable-handle"
      className={cn(
        'relative flex w-px items-center justify-center after:absolute after:inset-y-0 after:left-1/2 after:h-full after:w-px after:-translate-x-1/2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1',
        className
      )}
      {...props}
    />
  );
}

export { ResizablePanel, ResizablePanelGroup, ResizableHandle };
