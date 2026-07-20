import { generateObject } from 'ai';
import { z } from 'zod';
import { model } from '../gateway.js';
import type { ToolExecCtx } from './types.js';
import { safeExecute } from './safe-execute.js';
import { withTimeoutSignal } from './with-timeout-signal.js';
import { DEFAULT_TOOL_TIMEOUT_MS } from './with-agent-timeout.js';

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

const DEFAULT_TOOLS = ['browser_use', 'web_search', 'web_fetch', 'bash', 'task_analysis'];

// BUMPED 75s -> 600s/10min default, model-overridable (2026-07-20,
// "bump the limit of everything up to 10 minutes by default" -- moving
// off Vercel serverless onto the standalone worker removes the outer
// 300s maxDuration this used to leave headroom under). `timeout_seconds`
// on the input below lets the model ask for more/less per call.
const TIMEOUT_MS = DEFAULT_TOOL_TIMEOUT_MS;

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
    timeout_seconds: z.number().int().positive().max(3600).optional()
      .describe('Optional override for how long this analysis may run, in seconds. Defaults to 600s (10 min) if omitted.'),
  }),
  outputSchema: TaskAnalysisResultSchema,
  async execute({ task, context, availableTools, timeout_seconds }: { task: string; context?: string; availableTools?: string[]; timeout_seconds?: number }, ctx?: ToolExecCtx) {
    const effectiveTimeoutMs = typeof timeout_seconds === 'number' && timeout_seconds > 0 ? timeout_seconds * 1000 : TIMEOUT_MS;
    // Added 2026-07-16 (same fix as code_artifact.ts / python_coding.ts):
    // bounds worst-case latency for this call itself, so a slow/hung
    // upstream model fails fast and visibly instead of riding along until
    // the outer request's own maxDuration silently kills the whole turn.
    const t = withTimeoutSignal(ctx?.abortSignal, effectiveTimeoutMs, 'task_analysis');
    try {
      const { object } = await generateObject({
        model: await model(undefined, ctx?.byokModel),
        abortSignal: t.signal,
        schema: TaskAnalysisResultSchema,
        // Top-level `system`, NOT a `role: 'system'` entry in `messages` --
        // the latter is passed straight through to whatever the resolved
        // model's provider adapter is with no translation, and Responses-
        // API-style models (some Gateway + most BYOK OpenAI-family/o-series/
        // gpt-5 picks) reject a system role inside the messages/input array
        // outright ("System messages are not allowed in the prompt or
        // messages fields. Use the instructions option instead."). The AI
        // SDK's own `system` param is what actually gets translated per-
        // provider (e.g. into Responses API's `instructions` field) --
        // confirmed root cause of task_analysis/python_coding failing on
        // BYOK/direct-chat while eve's own root agent (different model
        // resolution path) never hit it.
        system:
          'You analyze a user task and produce a structured breakdown: whether it needs phases, ' +
          'its complexity, an estimated step count, and a numbered todo list with per-step tool ' +
          'requirements and dependencies.',
        messages: [
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
    } catch (err) {
      throw t.rethrow(err);
    } finally {
      t.clear();
    }
  },
};

taskAnalysis.execute = safeExecute('task_analysis', taskAnalysis.execute) as typeof taskAnalysis.execute;
