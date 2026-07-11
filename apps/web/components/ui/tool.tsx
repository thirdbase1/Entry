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
import type { ComponentProps, ReactNode } from 'react';
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

function StatusIcon({ state }: { state: ToolState }) {
  switch (state) {
    case 'input-streaming':
      return <Circle className="size-3" />;
    case 'input-available':
      return <Clock className="size-3 animate-pulse" />;
    case 'output-available':
      return <CheckCircle2 className="size-3 text-green-600" />;
    case 'output-error':
      return <XCircle className="size-3 text-destructive" />;
  }
}

export function ToolStatusBadge({ state }: { state: ToolState }) {
  return (
    <Badge variant={state === 'output-error' ? 'destructive' : 'secondary'} className="rounded-full">
      <StatusIcon state={state} />
      {STATUS_LABEL[state]}
    </Badge>
  );
}

export interface ToolHeaderProps {
  title: ReactNode;
  state: ToolState;
  icon?: ReactNode;
  className?: string;
}

export function ToolHeader({ title, state, icon, className }: ToolHeaderProps) {
  return (
    <CollapsibleTrigger className={cn('group flex w-full items-center justify-between gap-2 p-2.5 text-left', className)}>
      <div className="flex min-w-0 items-center gap-2">
        {icon ?? <Wrench className="size-3.5 shrink-0 text-muted-foreground" />}
        <span className="min-w-0 truncate text-xs font-medium text-foreground">{title}</span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <ToolStatusBadge state={state} />
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
  return (
    <div className={cn('space-y-1.5 p-3', className)}>
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {errorText ? 'Error' : 'Result'}
      </div>
      <div
        className={cn(
          'overflow-x-auto rounded-md text-xs',
          errorText ? 'bg-destructive/10 text-destructive p-2' : 'text-foreground'
        )}
      >
        {errorText ? <div className="whitespace-pre-wrap">{errorText}</div> : output}
      </div>
    </div>
  );
}
