/**
 * Replaces providers/tools/task-analysis.ts (task_analysis) — 1:1, no vendor
 * rewrite needed. The original never called a vendor SDK directly; it went
 * through `factory.getProviderByModel(...).structure(...)`, i.e. whichever
 * model a DB-configured prompt pointed at. That's exactly what
 * `GatewayCopilotProvider#structured()` is (Phase 1, provider.ts) — so this
 * port is purely mechanical: same schema, same tool contract, just called
 * against the one Gateway provider instead of a factory-selected vendor
 * client.
 *
 * NOTE: the original resolved its system prompt from `PromptService.get('Task
 * Analysis')` (DB-configured, Phase 2 — Prisma prompt table not ported yet).
 * Inlined the same schema/instructions here as a literal default so the tool
 * works today; swap for the real PromptService lookup once Phase 2 lands.
 */
import { z } from 'zod';

import { copilotProvider } from '../provider';
import { ModelOutputType } from '../types';
import { toolError } from './error';
import { createTool } from './utils';

export const TaskAnalysisResultSchema = z.object({
  needsPhases: z.boolean(),
  complexity: z.enum(['simple', 'moderate', 'complex']),
  estimatedSteps: z.number().min(1).max(20),
  todoList: z.array(
    z.object({
      step: z.number(),
      title: z.string(),
      description: z.string(),
      estimatedTime: z.string(),
      requiredTools: z.array(z.string()),
      dependencies: z.array(z.number()),
    })
  ),
  reasoning: z.string(),
  suggestedApproach: z.string(),
});

export type TaskAnalysisResult = z.infer<typeof TaskAnalysisResultSchema>;

const DEFAULT_TOOLS = [
  'browser_use',
  'web_search',
  'web_crawl',
  'python_sandbox',
  'doc_compose',
  'task_analysis',
];

export const createTaskAnalysisTool = () => {
  return createTool(
    { toolName: 'task_analysis' },
    {
      description:
        'Analyze a user task to determine if it needs to be broken down into phases, estimate the number of steps required, create a todo list, and identify which tools might be needed for each step. You should use this tool to confirm whether a task is complex and whether it needs to be broken down whenever you encounter any potentially complex tasks (such as those involving report creation, data analysis, or writing complex code).',
      inputSchema: z.object({
        task: z.string().describe('The user task to analyze and break down'),
        context: z.string().optional().describe('Additional context about the task, user requirements, or constraints'),
        availableTools: z.array(z.string()).optional().describe('List of available tools that could be used for this task'),
      }),
      execute: async ({ task, context, availableTools }: { task: string; context?: string; availableTools?: string[] }) => {
        try {
          if (!task || task.trim().length === 0) {
            return toolError('Invalid Task', 'Task description cannot be empty');
          }

          const result = await copilotProvider.structured(
            { outputType: ModelOutputType.Structured },
            [
              {
                role: 'system',
                content:
                  'You analyze a user task and produce a structured breakdown: whether it needs phases, ' +
                  'its complexity, an estimated step count, and a numbered todo list with per-step tool requirements and dependencies.',
              },
              {
                role: 'user',
                content: JSON.stringify({
                  task: task.trim(),
                  context: context || 'No additional context provided',
                  availableTools: (availableTools || DEFAULT_TOOLS).join(', '),
                  currentDate: new Date().toISOString(),
                }),
              },
            ],
            TaskAnalysisResultSchema
          );

          return result;
        } catch (err: any) {
          return toolError('Task Analysis Failed', err.message);
        }
      },
    }
  );
};
