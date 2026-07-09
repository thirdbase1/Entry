'use client';

/**
 * Ported from pages/chats/renderers/todo-list-result.tsx — Kanban-style
 * done/in-progress/todo board.
 *
 * IMPORTANT adaptation: the original's `todo_list`/`mark_todo` custom tools
 * (`result.list: [{id,title,status,description}]`) don't exist under eve —
 * eve ships a durable BUILT-IN `todo` tool instead (see
 * node_modules/eve/dist/src/runtime/framework-tools/todo.js, read directly,
 * not guessed), with a different real output shape:
 * `{ todos: [{content, priority, status}], counts: {...} }`. Status enum is
 * also different (`pending|in_progress|completed|cancelled` vs the
 * original's freer-form strings). Mapped field-for-field: `content` ->
 * `title`, no `description`/`id` (falls back to index), `cancelled` folded
 * into the "Todo" column (closest visual match — the original had no
 * concept of a cancelled state/column).
 */
import type { EveDynamicToolPart } from 'eve/react';
import { cn } from '@/lib/utils';

interface TodoItem {
  content: string;
  priority: 'high' | 'medium' | 'low';
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
}

const COLUMN_LABELS = {
  done: 'Done',
  inProgress: 'In progress',
  todo: 'Todo',
} as const;

type ColumnKey = keyof typeof COLUMN_LABELS;

function columnFor(status: TodoItem['status']): ColumnKey {
  switch (status) {
    case 'completed':
      return 'done';
    case 'in_progress':
      return 'inProgress';
    case 'pending':
    case 'cancelled':
    default:
      return 'todo';
  }
}

function StatusIcon({ status }: { status: TodoItem['status'] }) {
  if (status === 'completed') {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-primary">
        <path d="M20 6L9 17l-5-5" />
      </svg>
    );
  }
  if (status === 'in_progress') {
    return <span className="w-3 h-3 rounded-full border-2 border-primary border-t-transparent animate-spin inline-block" />;
  }
  if (status === 'cancelled') {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted-foreground">
        <path d="M18 6L6 18M6 6l12 12" />
      </svg>
    );
  }
  return <span className="w-3.5 h-3.5 rounded-full border border-muted-foreground inline-block" />;
}

export function TodoListResult({ part }: { part: EveDynamicToolPart }) {
  const output = part.state === 'output-available' ? (part.output as { todos?: TodoItem[]; counts?: Record<string, number> } | undefined) : undefined;
  const isRunning = part.state === 'input-streaming' || part.state === 'input-available';
  const todos = output?.todos ?? [];

  if (isRunning && todos.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card w-full p-3 text-sm text-muted-foreground flex items-center gap-2">
        <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
        Updating task list…
      </div>
    );
  }

  const grouped: Record<ColumnKey, TodoItem[]> = { done: [], inProgress: [], todo: [] };
  for (const item of todos) grouped[columnFor(item.status)].push(item);

  return (
    <div className="w-full overflow-x-auto pb-1">
      <div className="flex md:grid md:grid-cols-3 gap-3 min-w-max">
        {(Object.keys(COLUMN_LABELS) as ColumnKey[]).map(key => (
          <div key={key} className="flex-shrink-0 flex flex-col gap-2 w-64">
            <h3 className="text-xs font-medium text-muted-foreground px-1">
              {COLUMN_LABELS[key]} {grouped[key].length > 0 && <span>({grouped[key].length})</span>}
            </h3>
            {grouped[key].map((item, i) => (
              <div key={i} className="rounded-lg border border-border bg-card px-3 py-2 flex items-center gap-2">
                <StatusIcon status={item.status} />
                <div className={cn('text-sm text-foreground truncate flex-1', item.status === 'completed' && 'line-through text-muted-foreground')}>
                  {item.content}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
