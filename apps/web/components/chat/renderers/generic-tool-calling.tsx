'use client';

/**
 * Ported 1:1 from pages/chats/renderers/generic-tool-calling.tsx — the
 * "tool is running" placeholder card used while a tool-call is in
 * progress but has no partial content to preview yet: h-14 row, spinner
 * (or custom icon), title + a live elapsed-time ticker ("3s" -> "1m 5s"
 * past 60s, ticking every second from first mount). Used by web-search,
 * web-crawl, and the generic/default tool-result fallback.
 */
import { useEffect, useState } from 'react';

function Spinner() {
  return <span className="inline-block w-4 h-4 rounded-full border-2 border-muted-foreground border-t-transparent animate-spin" />;
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
    <div className="h-14 flex items-center gap-2 border rounded-2xl px-4 mb-4 bg-card" style={{ boxShadow: '0px 1px 5px 0px rgba(0, 0, 0, 0.05)' }}>
      <div className="size-5 shrink-0 text-xl flex items-center justify-center">{icon ?? <Spinner />}</div>
      <div className="w-0 flex-1 text-sm font-medium text-foreground">
        {title}
        {displayTime && <span className="ml-1 font-normal text-muted-foreground">{elapsedTime}</span>}
      </div>
    </div>
  );
}
