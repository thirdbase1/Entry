'use client';

/**
 * Ported 1:1 from components/chat/aggregated-todo-list.tsx.
 * Collapsible bar above the chat input showing a summary of all todo items
 * extracted from tool results across the conversation.
 *
 * In the original, this pulled from the copilot store's messages and used
 * extractAllTodosFromMessages/groupTodosByStatus utils. In our migration,
 * we scan eve message parts for todo-list tool results and aggregate them.
 */
import { AnimatePresence, motion } from 'framer-motion';
import { useMemo, useState } from 'react';

import { cn } from '@/lib/utils';
import type { EveMessage, EveMessagePart, EveDynamicToolPart } from 'eve/react';

type CardStatus = 'done' | 'inProgress' | 'todo';

interface TodoItem {
  id: string;
  title: string;
  status: string;
}

/** Real shape of eve's built-in `todo` tool output (verified directly
 * against node_modules/eve/dist/src/runtime/framework-tools/todo.js —
 * same source todo-list-result.tsx already reads correctly): `{ todos:
 * [{content, priority, status}], counts }`. No `id`/`title` fields exist
 * at all. */
interface RawTodoItem {
  content: string;
  priority: 'high' | 'medium' | 'low';
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
}

const statusToCardStatus = (status: string): CardStatus => {
  if (status === 'completed' || status === 'done') return 'done';
  if (status === 'in_progress' || status === 'in-progress' || status === 'processing') return 'inProgress';
  return 'todo';
};

function CheckIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function UncheckIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
    </svg>
  );
}

function LoadingIcon({ size = 24 }: { size?: number }) {
  return (
    <svg className="animate-spin" width={size} height={size} viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
    </svg>
  );
}

function ArrowDownSmallIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

const getIcon = (status: CardStatus) => {
  switch (status) {
    case 'done':
      return <CheckIcon />;
    case 'todo':
      return <UncheckIcon />;
    default:
      return <LoadingIcon size={24} />;
  }
};

/**
 * Extract todos from eve message parts carrying `todo` tool results.
 *
 * This used to check for toolName 'todo_list_write'/'todo_list' and read
 * `.result` with `.id`/`.title` fields — NONE of that matches eve's real
 * built-in tool (name is 'todo', output lives on `.output` not `.result`,
 * items only ever have `content`/`priority`/`status`, no `id`/`title` at
 * all). Net effect: this always returned zero todos, so the whole
 * aggregated bar above the chat input never rendered, for any
 * conversation, ever — a totally dead feature.
 *
 * Also important: eve's `todo` tool does a FULL-LIST REPLACE on every
 * call (see todo.js's executeTodoTool — each call's output is the
 * complete current list, not a diff/append). So this must only read the
 * MOST RECENT `todo` call in the conversation, not concatenate every
 * call's output — doing the latter would multiply every item by however
 * many times the model updated the list over the conversation.
 */
function extractAllTodosFromMessages(messages: readonly EveMessage[]): TodoItem[] {
  let latest: EveDynamicToolPart | undefined;
  for (const msg of messages) {
    for (const part of msg.parts as readonly EveMessagePart[]) {
      if (part.type !== 'dynamic-tool') continue;
      const toolPart = part as EveDynamicToolPart;
      const toolName = toolPart.toolMetadata?.eve?.name ?? toolPart.toolName;
      if (toolName !== 'todo') continue;
      if (toolPart.state !== 'output-available') continue;
      latest = toolPart; // messages are in chronological order — last match wins
    }
  }
  if (!latest) return [];
  const output = latest.output as { todos?: RawTodoItem[] } | undefined;
  if (!output?.todos || !Array.isArray(output.todos)) return [];
  return output.todos
    .filter(todo => todo?.content)
    .map((todo, i) => ({ id: `${latest!.toolCallId}-${i}`, title: todo.content, status: todo.status ?? 'pending' }));
}

function groupTodosByStatus(todos: TodoItem[]) {
  const inProgress = todos.filter(t => statusToCardStatus(t.status) === 'inProgress');
  const todo = todos.filter(t => statusToCardStatus(t.status) === 'todo');
  const done = todos.filter(t => statusToCardStatus(t.status) === 'done');
  return { inProgress, todo, done };
}

export function AggregatedTodoList({ messages }: { messages: readonly EveMessage[] }) {
  const aggregatedTodos = useMemo(() => {
    const todos = extractAllTodosFromMessages(messages);
    const grouped = groupTodosByStatus(todos);
    return [...grouped.inProgress, ...grouped.todo, ...grouped.done];
  }, [messages]);

  const [expanded, setExpanded] = useState(false);

  const groupedCounts = useMemo(() => {
    const todos = extractAllTodosFromMessages(messages);
    const grouped = groupTodosByStatus(todos);
    return {
      inProgress: grouped.inProgress.length,
      todo: grouped.todo.length,
      done: grouped.done.length,
    };
  }, [messages]);

  const totalTodos = aggregatedTodos.length;

  if (totalTodos === 0) {
    return null;
  }

  return (
    <motion.div
      layout
      transition={{ duration: 0.2 }}
      className="border border-b-0 rounded-t-2xl bg-muted/30 mx-4 cursor-pointer select-none"
      onClick={() => setExpanded(prev => !prev)}
    >
      <div className="max-w-[800px] mx-auto px-4 py-3 flex items-center justify-between gap-4">
        <div className="text-sm font-medium">
          {totalTodos} Todo Item{totalTodos > 1 ? 's' : ''}
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          {groupedCounts.inProgress > 0 && <span>{groupedCounts.inProgress} In&nbsp;Progress</span>}
          {groupedCounts.todo > 0 && <span>{groupedCounts.todo} Todo</span>}
          {groupedCounts.done > 0 && <span>{groupedCounts.done} Done</span>}
        </div>
        <motion.div
          animate={{ rotate: expanded ? 180 : 0 }}
          transition={{ duration: 0.2 }}
          className="text-xl text-muted-foreground ml-2"
        >
          <ArrowDownSmallIcon />
        </motion.div>
      </div>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="content"
            initial="collapsed"
            animate="open"
            exit="collapsed"
            variants={{ open: { opacity: 1, height: 'auto' }, collapsed: { opacity: 0, height: 0 } }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="max-w-[800px] mx-auto px-4 pb-3 flex flex-col gap-2 max-h-30vh overflow-y-auto">
              {aggregatedTodos.map(todo => (
                <TodoListItem
                  key={todo.id}
                  status={statusToCardStatus(todo.status)}
                  title={todo.title}
                />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

const TodoListItem = ({
  status,
  title,
  subTitle,
}: {
  status: CardStatus;
  title: string;
  subTitle?: string;
}) => {
  const icon = getIcon(status);
  return (
    <div data-status={status} className={cn('h-5 flex items-center gap-3 text-sm')}>
      <div className={cn('shrink-0 text-2xl text-muted-foreground')}>{icon}</div>
      <div className={cn('flex gap-1 text-foreground', status === 'done' && 'line-through text-muted-foreground')}>
        <div className={cn('w-full truncate text-sm')}>{title}</div>
        {subTitle ? <div className={cn('truncate text-xs')}>{subTitle}</div> : null}
      </div>
    </div>
  );
};
