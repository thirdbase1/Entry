'use client';

/**
 * "Tool is running" placeholder — used while a tool-call is in progress
 * but has no partial content to preview yet.
 *
 * Rewritten (2026-07-11) per explicit, repeated user feedback ("I don't
 * like any of the tool card") — the old version was a bordered,
 * box-shadowed, rounded-2xl, 56px-tall card. With a multi-tool turn
 * (common — task_analysis -> web_search -> bash -> ...) that meant a
 * stack of heavy boxes taking up most of the screen before any real
 * answer text ever appeared. Now a single plain text line: spinner +
 * title + elapsed time, no box/border/shadow at all — matches the
 * minimal inline style direct-chat-interface.tsx already used for its
 * own (non-eve) tool call rendering, so both chat paths now look the same.
 */
import { useEffect, useState } from 'react';

function Spinner() {
  return <span className="inline-block w-3 h-3 rounded-full border-2 border-muted-foreground border-t-transparent animate-spin" />;
}

export function GenericToolCalling({
  icon,
  title,
  displayTime = true,
}: {
  icon?: React.ReactNode;
  title: string;
  displayTime?: boolean;
}) {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => setSeconds(prev => prev + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  const elapsedTime = seconds > 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;

  return (
    <div className="flex items-center gap-1.5 py-1 text-xs text-muted-foreground">
      {icon ?? <Spinner />}
      <span>{title}</span>
      {displayTime && <span className="opacity-70">· {elapsedTime}</span>}
    </div>
  );
}
