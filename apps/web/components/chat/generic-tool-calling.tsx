/**
 * Ported ~1:1 from pages/chats/renderers/generic-tool-calling.tsx — the
 * "in progress" pill shown while a tool call is running (a spinner/icon +
 * title + live elapsed-time counter).
 */
'use client';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

export function GenericToolCalling({ icon, title, displayTime = true }: { icon?: React.ReactNode; title: string; displayTime?: boolean }) {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => setSeconds(prev => prev + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  const elapsed = seconds > 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;

  return (
    <div className={cn('h-14 flex items-center gap-2 border rounded-2xl px-4')} style={{ boxShadow: '0px 1px 5px 0px rgba(0, 0, 0, 0.05)' }}>
      <div className="size-5 shrink-0 text-xl flex items-center justify-center">
        {icon ?? <Spinner />}
      </div>
      <div className="w-0 flex-1 text-sm font-medium text-text-primary">
        {title}
        {displayTime ? <span className="ml-1 font-normal text-text-tertiary">{elapsed}</span> : null}
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <svg className="animate-spin size-4" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}
