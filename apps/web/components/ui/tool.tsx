'use client';

/**
 * The real AI SDK "Tool" component (`npx ai-elements add tool`) —
 * hand-ported (2026-07-11) rather than pulled via the ai-elements CLI,
 * because that CLI expects a shadcn `components.json` this project never
 * set up (CSS-Modules-based styling, no shadcn init) and the interactive
 * installer has no non-interactive path. Same public API/shape as the
 * real registry component: <Tool>, <ToolHeader>, <ToolContent>,
 * <ToolInput>, <ToolOutput> — genuinely collapsible (real
 * @radix-ui/react-collapsible under the hood, not a custom AnimatePresence
 * div) with a real status <Badge>, built on this project's own
 * primitives (components/ui/collapsible.tsx, components/ui/badge.tsx,
 * components/ui/code-block.tsx) and `cn()` instead of the upstream
 * registry's shadcn/lucide imports it'd otherwise assume are already
 * present.
 *
 * Wired into every tool-calling surface via generic-tool-result.tsx +
 * generic-tool-calling.tsx (the shared shell every renderer under
 * chat/renderers/* already goes through) and direct-chat-interface.tsx's
 * own inline (non-eve) tool-part rendering — see those files' comments.
 */
import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  Circle,
  Clock,
  Wrench,
  XCircle,
} from 'lucide-react';
import { Badge } from './badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './collapsible';
import { CodeBlock } from './code-block';
import { cn } from '@/lib/utils';

export type ToolState = 'input-streaming' | 'input-available' | 'output-available' | 'output-error';

/**
 * A timeout is technically just another tool error (with-agent-timeout.ts
 * rethrows `"${toolName} timed out after ${s}s"` through the same
 * output-error path every other failure takes), but it isn't the same
 * KIND of failure -- the tool didn't break, it just ran out of its
 * allotted budget, which is common and often expected for a genuinely
 * long call (2026-07-21, "show it in UI when agent time out"). Detected
 * by matching the exact rethrow message shape from
 * apps/agent/agent/lib/tool-impls/with-agent-timeout.ts rather than a
 * new dedicated ToolState, so every existing call site (which only ever
 * passes state + errorText, already computed) gets the distinct
 * treatment for free with no prop-shape changes beyond the new optional
 * `errorText` param added below.
 */
export function isTimeoutError(errorText?: string | null): boolean {
  if (!errorText) return false;
  return /timed out after \d+(\.\d+)?s\b/i.test(errorText);
}

export type ToolProps = ComponentProps<typeof Collapsible>;

export function Tool({ className, ...props }: ToolProps) {
  return <Collapsible className={cn('not-prose mb-2 w-full rounded-lg border bg-card/50', className)} {...props} />;
}

const STATUS_LABEL: Record<ToolState, string> = {
  'input-streaming': 'Pending',
  'input-available': 'Running',
  'output-available': 'Completed',
  'output-error': 'Error',
};

function StatusIcon({ state, timedOut }: { state: ToolState; timedOut?: boolean }) {
  switch (state) {
    case 'input-streaming':
      return <Circle className="size-3" />;
    case 'input-available':
      return <Clock className="size-3 animate-pulse" />;
    case 'output-available':
      return <CheckCircle2 className="size-3 text-green-600" />;
    case 'output-error':
      return timedOut ? <Clock className="size-3 text-amber-500" /> : <XCircle className="size-3 text-destructive" />;
  }
}

/**
 * Live elapsed-time ticker while a tool is actually running (2026-07-17,
 * "improve real time streaming" push) -- a tool that takes 20s to run a
 * shell command previously just sat on a static "Running" badge the
 * whole time, giving zero feedback that anything is actually happening.
 * Starts counting from this component's own mount (i.e. the first render
 * where the part exists at all, which for a running tool is right when
 * its input starts streaming in) -- not exact vs. the server's own
 * clock, but accurate enough to convey "this is alive and ticking," which
 * is the actual goal. Stops/freezes the instant state leaves the running
 * states so a completed tool's badge doesn't keep counting up forever.
 */
function useElapsedSeconds(running: boolean): number {
  const startRef = useRef<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!running) return;
    if (startRef.current === null) startRef.current = Date.now();
    const id = setInterval(() => {
      setElapsed(Math.max(0, Math.round((Date.now() - (startRef.current ?? Date.now())) / 1000)));
    }, 1000);
    return () => clearInterval(id);
  }, [running]);
  return elapsed;
}

export function ToolStatusBadge({ state, errorText }: { state: ToolState; errorText?: string | null }) {
  const running = state === 'input-streaming' || state === 'input-available';
  const elapsed = useElapsedSeconds(running);
  const timedOut = state === 'output-error' && isTimeoutError(errorText);
  const label = timedOut ? 'Timed out' : STATUS_LABEL[state];
  return (
    <Badge
      variant={state === 'output-error' && !timedOut ? 'destructive' : 'secondary'}
      className={cn('rounded-full tabular-nums', timedOut && 'bg-amber-500/15 text-amber-600 dark:text-amber-400')}
    >
      <StatusIcon state={state} timedOut={timedOut} />
      {label}
      {running && elapsed > 0 && <span className="text-muted-foreground/80">· {elapsed}s</span>}
    </Badge>
  );
}

/**
 * Controlled auto-open/auto-close Tool wrapper (2026-07-19, "it auto
 * opens the card when a tool call starts, which is good, but it doesn't
 * auto close when it's completed or errored"). `defaultOpen` on the plain
 * <Tool> is uncontrolled, so a card opened while running just stays open
 * forever once the call finishes. This wrapper drives `open` from the
 * tool part's live state instead: open while input-streaming /
 * input-available, auto-collapsed the moment state transitions to
 * output-available or output-error. A manual expand/collapse click opts
 * this instance out of auto-management for the rest of its life -- the
 * user's explicit choice always wins (same opt-out pattern as
 * generic-tool-result.tsx's autoExpand handling on the eve path).
 */
export function AutoCollapseTool({
  state,
  className,
  children,
}: {
  state: ToolState;
  className?: string;
  children: ReactNode;
}) {
  const running = state === 'input-streaming' || state === 'input-available';
  const [open, setOpen] = useState(running);
  const userToggledRef = useRef(false);
  const prevRunningRef = useRef(running);
  useEffect(() => {
    if (prevRunningRef.current === running) return;
    prevRunningRef.current = running;
    if (userToggledRef.current) return;
    setOpen(running);
  }, [running]);
  return (
    <Tool
      className={className}
      open={open}
      onOpenChange={o => {
        userToggledRef.current = true;
        setOpen(o);
      }}
    >
      {children}
    </Tool>
  );
}

export interface ToolHeaderProps {
  title: ReactNode;
  state: ToolState;
  icon?: ReactNode;
  className?: string;
  /** Passed through to ToolStatusBadge so a timeout renders as a distinct
   *  amber "Timed out" badge instead of a red "Error" one -- see
   *  isTimeoutError above. Optional/omittable everywhere else. */
  errorText?: string | null;
}

export function ToolHeader({ title, state, icon, className, errorText }: ToolHeaderProps) {
  return (
    <CollapsibleTrigger data-tool-state={state} className={cn('group flex w-full items-center justify-between gap-2 p-2.5 text-left', className)}>
      <div className="flex min-w-0 items-center gap-2">
        {icon ?? <Wrench className="size-3.5 shrink-0 text-muted-foreground" />}
        <span className="min-w-0 truncate text-xs font-medium text-foreground">{title}</span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <ToolStatusBadge state={state} errorText={errorText} />
        <ChevronDown className="size-3.5 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
      </div>
    </CollapsibleTrigger>
  );
}

export function ToolContent({ className, ...props }: ComponentProps<typeof CollapsibleContent>) {
  return (
    <CollapsibleContent
      className={cn(
        'overflow-hidden border-t data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:slide-out-to-top-1 data-[state=open]:slide-in-from-top-1',
        className
      )}
      {...props}
    />
  );
}

export function ToolInput({ input, className }: { input: unknown; className?: string }) {
  if (input === undefined) return null;
  return (
    <div className={cn('space-y-1.5 p-3', className)}>
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Parameters</div>
      <div className="rounded-md bg-muted/50">
        <CodeBlock language="json">{typeof input === 'string' ? input : JSON.stringify(input, null, 2)}</CodeBlock>
      </div>
    </div>
  );
}

export function ToolOutput({
  output,
  errorText,
  className,
}: {
  output?: ReactNode;
  errorText?: string;
  className?: string;
}) {
  if (!output && !errorText) return null;
  const timedOut = isTimeoutError(errorText);
  return (
    <div className={cn('space-y-1.5 p-3', className)}>
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {errorText ? (timedOut ? 'Timed out' : 'Error') : 'Result'}
      </div>
      <div
        className={cn(
          'overflow-x-auto rounded-md text-xs',
          errorText ? (timedOut ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 p-2' : 'bg-destructive/10 text-destructive p-2') : 'text-foreground'
        )}
      >
        {errorText ? <div className="whitespace-pre-wrap">{errorText}</div> : output}
      </div>
    </div>
  );
}
