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
 *
 * Verified 1:1 against the real original
 * (pages/chats/renderers/todo-list-result.tsx + .css.ts) this pass:
 * - LayoutGroup + motion.div layout spring animation when cards move
 *   between columns (was missing — cards used to just snap)
 * - Left/right scroll fade-mask on horizontal overflow (was missing)
 * - Card: rounded-2xl + shadow-view (was rounded-lg, no shadow)
 * - Done-icon color is icon/primary (#7a7a7a neutral gray in the real
 *   theme token — verified from @toeverything/theme, NOT the app's blue
 *   "primary" brand token, a naming collision that had crept in)
 * - Done card title already correctly gets line-through (kept)
 */
import { useMemo } from 'react';
import { LayoutGroup, motion } from 'framer-motion';
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

// Icon colors ported exactly from todo-list-result.css.ts:
// done -> icon/primary (#7a7a7a), todo -> icon/secondary (a lighter gray).
// Neither is the app's blue brand "primary" token — that was the bug.
function StatusIcon({ status }: { status: TodoItem['status'] }) {
  if (status === 'completed') {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-icon-primary">
        <path d="M20 6L9 17l-5-5" />
      </svg>
    );
  }
  if (status === 'in_progress') {
    return <span className="w-4 h-4 rounded-full border-2 border-icon-primary border-t-transparent animate-spin inline-block" />;
  }
  if (status === 'cancelled') {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-icon-secondary">
        <path d="M18 6L6 18M6 6l12 12" />
      </svg>
    );
  }
  return <span className="w-3.5 h-3.5 rounded-full border border-icon-secondary inline-block" />;
}

export function TodoListResult({ part }: { part: EveDynamicToolPart }) {
  const output = part.state === 'output-available' ? (part.output as { todos?: TodoItem[]; counts?: Record<string, number> } | undefined) : undefined;
  const isRunning = part.state === 'input-streaming' || part.state === 'input-available';
  const todos = output?.todos ?? [];

  const grouped = useMemo(() => {
    const g: Record<ColumnKey, (TodoItem & { _key: string })[]> = { done: [], inProgress: [], todo: [] };
    todos.forEach((item, i) => {
      // Stable key from content so layout animation can track a card across
      // columns as its status changes, matching the original's item.id-keyed
      // motion.div layoutId behavior.
      g[columnFor(item.status)].push({ ...item, _key: `${item.content}-${i}` });
    });
    return g;
  }, [todos]);

  if (isRunning && todos.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card w-full p-3 text-sm text-muted-foreground flex items-center gap-2">
        <span className="w-2 h-2 rounded-full bg-icon-primary animate-pulse" />
        Updating task list…
      </div>
    );
  }

  return (
    <LayoutGroup>
      {/* Horizontal scroll wrapper with left/right fade-mask, ported from
          todo-list-preview.css.ts's `scrollMask` (::before/::after gradients). */}
      <div className="relative w-full">
        <div
          className="pointer-events-none absolute inset-0 z-10"
          style={{
            background:
              'linear-gradient(to right, var(--color-card), transparent 50px), linear-gradient(to left, var(--color-card), transparent 50px)',
          }}
        />
        <div className="w-full overflow-x-auto pb-1">
          <div className="flex md:grid md:grid-cols-3 gap-3 min-w-max">
            {(Object.keys(COLUMN_LABELS) as ColumnKey[]).map(key => (
              <div key={key} className="flex-shrink-0 flex flex-col gap-2 w-64">
                <h3 className="text-xs font-medium text-muted-foreground px-1">
                  {COLUMN_LABELS[key]} {grouped[key].length > 0 && <span>({grouped[key].length})</span>}
                </h3>
                {grouped[key].map(item => (
                  <motion.div
                    key={item._key}
                    layout
                    layoutId={item._key}
                    transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                    className={cn(
                      'rounded-2xl border shadow-view bg-card px-4 py-2 flex items-center gap-3 h-[62px]'
                    )}
                  >
                    <div className="size-6 shrink-0 flex items-center justify-center">
                      <StatusIcon status={item.status} />
                    </div>
                    <div
                      className={cn(
                        'text-sm text-foreground truncate flex-1 font-medium',
                        item.status === 'completed' && 'line-through text-muted-foreground'
                      )}
                    >
                      {item.content}
                    </div>
                  </motion.div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </LayoutGroup>
  );
}
