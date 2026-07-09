'use client';

/**
 * Ported 1:1 from pages/chats/renderers/generic-tool-result.tsx +
 * generic-tool-result.css.ts + tool.css.ts. This is the shared collapsible
 * card shell used by web-search, web-crawl, and any other list-style tool
 * result. Previously each renderer hand-rolled its own simplified card
 * (rounded-lg, no shadow, no expand icon, no height animation) — this
 * restores the real shell: rounded-2xl, h-14 header, subtle box-shadow,
 * ExpandFullIcon/ExpandCloseIcon toggle, AnimatePresence height animation,
 * count shown as a plain number next to the title (not a badge), and
 * marginBottom 16px (tool.css.ts's `toolResult`) so cards stack like the
 * original.
 */
import { useState, type ReactNode } from 'react';
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
}: {
  icon?: ReactNode;
  title: ReactNode;
  count?: number;
  actions?: ReactNode;
  onCollapseChange?: (collapsed: boolean) => void;
  children?: ReactNode;
  className?: string;
  onClick?: () => void;
}) {
  const [collapsed, setCollapsed] = useState(true);

  const toggleCollapsed = () => {
    setCollapsed(!collapsed);
    onCollapseChange?.(!collapsed);
  };

  return (
    <div
      className={cn(
        'mb-4 border rounded-2xl overflow-hidden bg-card',
        className,
        onClick ? 'hover:bg-accent cursor-pointer' : ''
      )}
      style={{ boxShadow: '0px 1px 5px 0px rgba(0, 0, 0, 0.05)' }}
      data-collapsed={collapsed}
      onClick={onClick}
    >
      <header
        className={cn(
          'flex items-center gap-2 h-14 px-4 border-b transition-colors duration-400',
          collapsed && 'border-transparent'
        )}
      >
        {icon ? (
          <div className="size-5 shrink-0 text-xl flex items-center justify-center text-icon-primary">
            {icon}
          </div>
        ) : null}
        <div className="w-0 flex-1 text-sm font-medium text-foreground truncate">
          {title}
          {count ? <span className="ml-1 font-normal text-muted-foreground">{count}</span> : null}
        </div>
        <div className="flex items-center gap-2">
          {actions}
          {children ? (
            <button
              onClick={e => {
                e.stopPropagation();
                toggleCollapsed();
              }}
              className="size-6 shrink-0 flex items-center justify-center rounded hover:bg-accent transition-colors text-muted-foreground"
            >
              {collapsed ? <ExpandFullIcon /> : <ExpandCloseIcon />}
            </button>
          ) : null}
        </div>
      </header>
      {children ? (
        <AnimatePresence>
          {collapsed ? null : (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ damping: 10, stiffness: 100, mass: 0.5 }}
            >
              {children}
            </motion.div>
          )}
        </AnimatePresence>
      ) : null}
    </div>
  );
}
