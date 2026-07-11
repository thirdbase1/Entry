'use client';

/**
 * Shared shell for a completed tool call's result — used by web-search,
 * web-crawl, code-artifact, doc-compose, make-it-real, python-code,
 * task-analysis, browser-use, and the generic/default fallback (see
 * message-renderer.tsx's ToolPart dispatch).
 *
 * Rewritten (2026-07-11) per explicit, repeated user feedback ("I don't
 * like any of the tool card") — previously this rendered a bordered,
 * box-shadowed, rounded-2xl, 56px-tall header on every single tool call,
 * so a multi-tool turn produced a stack of heavy cards before any real
 * answer text appeared. Now a single plain text line (icon + title +
 * count), no box/border/shadow/fixed height. The expand/collapse toggle
 * is kept — detail (search results, code, etc.) is still one click away,
 * just not shoved in your face by default and not wrapped in a "card"
 * anymore when it is expanded either (plain indented block, no bg/border).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ExpandCloseIcon, ExpandFullIcon } from '@blocksuite/icons/rc';
import { cn } from '@/lib/utils';

export function GenericToolResult({
  icon,
  title,
  children,
  count,
  actions,
  onCollapseChange,
  className,
  onClick,
  autoExpand,
}: {
  icon?: ReactNode;
  title: ReactNode;
  count?: number;
  actions?: ReactNode;
  onCollapseChange?: (collapsed: boolean) => void;
  children?: ReactNode;
  className?: string;
  onClick?: () => void;
  /** When set (e.g. AIReasoningCard passing `loading`), auto-opens the
   *  moment this flips true and auto-collapses back the moment it flips
   *  false. A manual expand/collapse click opts out of this for the rest
   *  of this instance's life — the user's explicit choice always wins. */
  autoExpand?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(autoExpand === undefined ? true : !autoExpand);
  const userToggledRef = useRef(false);
  const prevAutoExpandRef = useRef(autoExpand);

  useEffect(() => {
    if (autoExpand === undefined) return;
    if (prevAutoExpandRef.current === autoExpand) return;
    prevAutoExpandRef.current = autoExpand;
    if (userToggledRef.current) return;
    setCollapsed(!autoExpand);
  }, [autoExpand]);

  const toggleCollapsed = () => {
    userToggledRef.current = true;
    setCollapsed(!collapsed);
    onCollapseChange?.(!collapsed);
  };

  return (
    <div className={cn('mb-1.5', className, onClick ? 'cursor-pointer' : '')} onClick={onClick} data-collapsed={collapsed}>
      <div className="flex items-center gap-1.5 py-0.5 text-xs text-muted-foreground">
        {icon ? <div className="size-3.5 shrink-0 flex items-center justify-center">{icon}</div> : null}
        <div className="min-w-0 truncate">
          {title}
          {count ? <span className="ml-1 opacity-70">{count}</span> : null}
        </div>
        <div className="flex items-center gap-1.5">
          {actions}
          {children ? (
            <button
              onClick={e => {
                e.stopPropagation();
                toggleCollapsed();
              }}
              className="size-4 shrink-0 flex items-center justify-center rounded hover:bg-accent transition-colors text-muted-foreground/70"
            >
              {collapsed ? <ExpandFullIcon className="size-3" /> : <ExpandCloseIcon className="size-3" />}
            </button>
          ) : null}
        </div>
      </div>
      {children ? (
        <AnimatePresence>
          {collapsed ? null : (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ damping: 10, stiffness: 100, mass: 0.5 }}
              className="pl-5"
            >
              {children}
            </motion.div>
          )}
        </AnimatePresence>
      ) : null}
    </div>
  );
}
