/**
 * Ported ~1:1 from pages/chats/renderers/generic-tool-result.tsx — a
 * collapsible card used as the catch-all display for any tool result that
 * doesn't have its own specialized renderer yet (browser-use, web-search,
 * code-artifact, etc. — see TODO in message.tsx). Framer-motion collapse
 * animation kept verbatim; expand/collapse icon swapped for inline SVGs
 * since `@blocksuite/icons` isn't wired into apps/web yet.
 */
'use client';
import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { cn } from '@/lib/utils';

export function GenericToolResult({
  icon,
  title,
  children,
  count,
  actions,
  className,
}: {
  icon?: React.ReactNode;
  title: React.ReactNode;
  count?: number;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  const [collapsed, setCollapsed] = useState(true);

  return (
    <div className={cn('border rounded-2xl overflow-hidden', className)} style={{ boxShadow: '0px 1px 5px 0px rgba(0, 0, 0, 0.05)' }}>
      <header className="flex items-center gap-2 h-14 px-4 border-b">
        {icon ? <div className="size-5 shrink-0 text-xl flex items-center justify-center">{icon}</div> : null}
        <div className="w-0 flex-1 text-sm font-medium text-text-primary truncate">
          {title}
          {count ? <span className="ml-1 font-normal text-text-tertiary">{count}</span> : null}
        </div>
        <div className="flex items-center gap-2">
          {actions}
          {children ? (
            <button onClick={() => setCollapsed(c => !c)} className="size-6 flex items-center justify-center rounded hover:bg-accent" aria-label={collapsed ? 'Expand' : 'Collapse'}>
              {collapsed ? '⌄' : '⌃'}
            </button>
          ) : null}
        </div>
      </header>
      {children ? (
        <AnimatePresence>
          {collapsed ? null : (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ damping: 10, stiffness: 100, mass: 0.5 }}>
              <div className="p-4">{children}</div>
            </motion.div>
          )}
        </AnimatePresence>
      ) : null}
    </div>
  );
}
