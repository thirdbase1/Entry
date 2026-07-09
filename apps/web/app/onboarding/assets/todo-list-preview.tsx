'use client';

import { useCallback, useEffect, useState } from 'react';
import type { EveDynamicToolPart } from 'eve/react';
import { TodoListResult } from '@/components/chat/renderers/todo-list-result';

/**
 * Ported 1:1 from packages/frontend/app/src/pages/onboarding/assets/todo-list-preview.tsx
 * Animated mock todo list that cycles through statuses every 2 seconds.
 *
 * Adaptation: the original fed mock data in its own tool shape
 * ({ list: [{id, title, status: 'done'|'in-progress'|'todo'}] }) to its
 * TodoListResult. Our TodoListResult takes an EveDynamicToolPart with eve's
 * built-in todo tool shape ({ todos: [{content, priority, status:
 * 'pending'|'in_progress'|'completed'|'cancelled'}], counts }). Same mock
 * concept (Japanese study plan tasks progressing through states on a timer),
 * mapped to our real data shape — the visual result is identical: a
 * Kanban-style board with items moving through columns over time.
 */

const mockTodos = [
  { content: 'Grammar chapter', priority: 'medium' as const, status: 'completed' as const },
  { content: 'Learn 10 new words', priority: 'medium' as const, status: 'completed' as const },
  { content: 'Oral practice', priority: 'medium' as const, status: 'completed' as const },
  { content: 'Science chapter', priority: 'medium' as const, status: 'completed' as const },
  { content: 'Search for videos in Japanese', priority: 'low' as const, status: 'in_progress' as const },
  { content: 'Review one grammar point', priority: 'low' as const, status: 'in_progress' as const },
  { content: 'Listen to 5 mins of Japanese', priority: 'low' as const, status: 'in_progress' as const },
  { content: 'Take a short quiz', priority: 'high' as const, status: 'pending' as const },
  { content: 'Review the grammar', priority: 'medium' as const, status: 'pending' as const },
  { content: 'Review the words', priority: 'medium' as const, status: 'pending' as const },
];

function makePart(todos: typeof mockTodos): EveDynamicToolPart {
  const counts = todos.reduce(
    (acc, t) => ({ ...acc, [t.status]: (acc[t.status] ?? 0) + 1 }),
    {} as Record<string, number>
  );
  return {
    type: 'tool-definition/dynamic',
    toolName: 'todo',
    state: 'output-available',
    output: { todos, counts },
  } as unknown as EveDynamicToolPart;
}

export function TodoListPreview() {
  const [todos, setTodos] = useState(mockTodos);

  const updateTodos = useCallback(() => {
    setTodos(prev => {
      const notFinished = prev.filter(t => t.status !== 'completed');
      if (notFinished.length === 0) return mockTodos;

      const randomIndex = Math.floor(Math.random() * notFinished.length);
      const randomTodo = notFinished[randomIndex];

      return prev.map(t =>
        t === randomTodo
          ? ({ ...t, status: t.status === 'pending' ? 'in_progress' : 'completed' } as typeof t)
          : t
      );
    });
  }, []);

  useEffect(() => {
    const interval = setInterval(updateTodos, 2000);
    return () => clearInterval(interval);
  }, [updateTodos]);

  return (
    <div className="w-[500px] max-w-screen h-[340px] relative">
      <TodoListResult part={makePart(todos)} />
    </div>
  );
}
