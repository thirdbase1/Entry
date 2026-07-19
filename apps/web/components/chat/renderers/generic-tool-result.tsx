'use client';

/**
 * Shared shell for a completed tool call's result — used by web-search,
 * web-crawl, code-artifact, doc-compose, make-it-real, python-code,
 * task-analysis, browser-use, agent-delegate, choose, ai-reasoning-card,
 * and the generic/default fallback (see message-renderer.tsx's ToolPart
 * dispatch).
 *
 * Rebuilt (2026-07-11) on top of the real AI SDK "Tool" component
 * (components/ui/tool.tsx, hand-ported from `npx ai-elements add tool` —
 * see that file's comment for why hand-ported instead of CLI-installed)
 * per explicit user request ("the real shadcn-style Tool component,
 * collapsible with status badges — add to all the tool calling"). Genuine
 * @radix-ui/react-collapsible under the hood now (was a hand-rolled
 * AnimatePresence height animation before) plus a real status <Badge>
 * (Pending/Running/Completed/Error) in the header — every one of this
 * shell's ~12 call sites gets both automatically with zero changes to
 * those files, since they only ever touch this shared component's public
 * props (icon/title/count/actions/children/onClick/autoExpand), which are
 * unchanged. Only new prop: `status`, defaulting to 'output-available'
 * ("Completed") — callers' existing output-error branches were updated to
 * pass `status="output-error"` so the badge is accurate instead of always
 * reading "Completed".
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ToolStatusBadge, type ToolState } from '@/components/ui/tool';
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
  autoCollapseOnTerminal = false,
  status = 'output-available',
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
  /** Auto-close a card that was open while its call was running as soon
   *  it reaches a completed/error terminal state. Manual toggles still
   *  win for the rest of this card's lifetime. */
  autoCollapseOnTerminal?: boolean;
  /** Status badge shown in the header. Defaults to "Completed" — pass
   *  'output-error' from an error branch, or 'input-streaming' /
   *  'input-available' for a still-running call (see GenericToolCalling,
   *  which renders the same shell in those two states). */
  status?: ToolState;
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

  useEffect(() => {
    // Tool cards deliberately open as soon as an invocation starts so its
    // progress is visible. Before this, the same component instance stayed
    // open forever when its streamed part changed to completed/error -- a
    // long agent run leaves a wall of huge finished JSON cards open. Close
    // that automatic opening at the terminal transition, but never fight a
    // user who explicitly opened/collapsed the card themselves.
    if (!autoCollapseOnTerminal || userToggledRef.current) return;
    if (status === 'output-available' || status === 'output-error') setCollapsed(true);
  }, [autoCollapseOnTerminal, status]);

  return (
    <Collapsible
      open={!collapsed}
      onOpenChange={open => {
        userToggledRef.current = true;
        setCollapsed(!open);
        onCollapseChange?.(!open);
      }}
      className={cn('not-prose mb-1.5 w-full rounded-lg border bg-card/40', onClick ? 'cursor-pointer' : '', className)}
      onClick={onClick}
    >
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-muted-foreground">
        {icon ? <div className="size-3.5 shrink-0 flex items-center justify-center">{icon}</div> : null}
        <div className="min-w-0 truncate flex-1">
          {title}
          {count ? <span className="ml-1 opacity-70">{count}</span> : null}
        </div>
        <ToolStatusBadge state={status} />
        <div className="flex items-center gap-1.5">
          {actions}
          {children ? (
            <CollapsibleTrigger asChild>
              <button
                onClick={e => e.stopPropagation()}
                className="group size-5 shrink-0 flex items-center justify-center rounded hover:bg-accent transition-colors text-muted-foreground/70"
              >
                <ChevronDown className="size-3.5 transition-transform group-data-[state=open]:rotate-180" />
              </button>
            </CollapsibleTrigger>
          ) : null}
        </div>
      </div>
      {children ? (
        <CollapsibleContent
          className={cn(
            'overflow-hidden border-t',
            'data-[state=closed]:animate-out data-[state=open]:animate-in',
            'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
            'data-[state=closed]:slide-out-to-top-1 data-[state=open]:slide-in-from-top-1'
          )}
        >
          <div className="pl-2">{children}</div>
        </CollapsibleContent>
      ) : null}
    </Collapsible>
  );
}
