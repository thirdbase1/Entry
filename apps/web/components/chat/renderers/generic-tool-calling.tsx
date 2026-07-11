'use client';

/**
 * "Tool is running" placeholder — used while a tool-call is in progress
 * but has no partial content to preview yet.
 *
 * Rebuilt (2026-07-11) to use the real AI SDK "Tool" shell
 * (components/ui/tool.tsx — see generic-tool-result.tsx's file comment
 * for the full story) per explicit user request to put the real
 * shadcn-style Tool component with status badges on every tool-calling
 * surface, including in-flight calls, not just finished ones. Same
 * bordered/rounded Tool container + a real "Pending"/"Running" status
 * <Badge> in place of the old plain spinner-and-text line, elapsed timer
 * kept as-is.
 */
import { useEffect, useState } from 'react';
import { Tool, ToolStatusBadge, type ToolState } from '@/components/ui/tool';

export function GenericToolCalling({
  icon,
  title,
  displayTime = true,
  state = 'input-available',
}: {
  icon?: React.ReactNode;
  title: string;
  displayTime?: boolean;
  /** 'input-streaming' -> "Pending" badge, 'input-available' (default) -> "Running". */
  state?: Extract<ToolState, 'input-streaming' | 'input-available'>;
}) {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => setSeconds(prev => prev + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  const elapsedTime = seconds > 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;

  return (
    <Tool className="mb-1.5">
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-muted-foreground">
        {icon ?? (
          <span className="inline-block w-3 h-3 rounded-full border-2 border-muted-foreground border-t-transparent animate-spin shrink-0" />
        )}
        <span className="min-w-0 truncate flex-1">
          {title}
          {displayTime && <span className="opacity-70"> · {elapsedTime}</span>}
        </span>
        <ToolStatusBadge state={state} />
      </div>
    </Tool>
  );
}
