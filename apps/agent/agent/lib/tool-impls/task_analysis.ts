import { generateObject } from 'ai';
import { z } from 'zod';
import { model } from '../gateway.js';

const TaskAnalysisResultSchema = z.object({
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

const DEFAULT_TOOLS = ['browser_use', 'web_search', 'web_fetch', 'bash', 'doc_compose', 'task_analysis'];

export const taskAnalysis = {
  description:
    'Analyze a user task to determine if it needs to be broken down into phases, estimate the ' +
    'number of steps required, create a todo list, and identify which tools might be needed for ' +
    'each step. Use this whenever you encounter a potentially complex task (report creation, data ' +
    'analysis, non-trivial code) to confirm whether it needs breaking down.',
  inputSchema: z.object({
    task: z.string().min(1, 'Task description cannot be empty'),
    context: z.string().optional(),
    availableTools: z.array(z.string()).optional(),
  }),
  outputSchema: TaskAnalysisResultSchema,
  async execute({ task, context, availableTools }: { task: string; context?: string; availableTools?: string[] }) {
    const { object } = await generateObject({
      model: await model(),
      schema: TaskAnalysisResultSchema,
      messages: [
        {
          role: 'system',
          content:
            'You analyze a user task and produce a structured breakdown: whether it needs phases, ' +
            'its complexity, an estimated step count, and a numbered todo list with per-step tool ' +
            'requirements and dependencies.',
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
    });
    return object;
  },
};
