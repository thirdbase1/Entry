/**
 * Port of providers/tools/utils.ts#createTool, now WITH TokenTracker wired
 * in for real (previously deferred pending Phase 2's Prisma/session infra,
 * which now exists in packages/db + token-tracker.ts). Matches the
 * original's push/pop-tool-name + per-step usage recording pattern exactly.
 *
 * NOTE: after upgrading @ai-sdk/provider-utils (pulled in via the
 * ai@7.0.16 / @ai-sdk/gateway@4.0.12 bump), `tool()` gained a third
 * `CONTEXT extends Context` generic with overloads keyed on how many type
 * args are passed explicitly. Passing exactly 2 explicit type args
 * (`tool<INPUT, OUTPUT>(...)`) now matches the *2-arg* overload
 * `tool<INPUT, CONTEXT>(tool: Tool<INPUT, never, CONTEXT>)` instead of the
 * intended 3-arg one — i.e. TS treats our OUTPUT as CONTEXT and requires it
 * to satisfy `Record<string, unknown>`, which most tool OUTPUT shapes don't.
 * Fixed by NOT specifying explicit generics at all and letting inference
 * work from the object literal — confirmed via the actual installed
 * @ai-sdk/provider-utils/dist/index.d.ts overload list, not guessed.
 */
import type { Tool, ToolExecutionOptions } from '@ai-sdk/provider-utils';

import { TokenTracker, type TokenUsageTracker } from '../token-tracker';

export interface ToolWrapperOptions {
  toolName: string;
  tracker?: TokenUsageTracker;
}

export function createTool<INPUT = any, OUTPUT = any>(
  options: ToolWrapperOptions,
  toolDefinition: Tool<INPUT, OUTPUT>
): Tool<INPUT, OUTPUT> {
  const { toolName, tracker = TokenTracker.getCurrentTracker() } = options;

  // NOTE: skip the `tool()` helper entirely here — confirmed (reading the
  // actual shipped .js, not just .d.ts) that at runtime it's a pure identity
  // function (`function tool(t) { return t; }`), used only for type
  // inference on literal call sites. With INPUT/OUTPUT as open generic type
  // params (not literals) TS can't select the right one of its 5 overloads,
  // so we build the object directly and cast — behaviorally identical.
  return ({
    ...toolDefinition,
    execute: async (args: INPUT, context: ToolExecutionOptions<any>) => {
      const startTime = Date.now();
      if (tracker) tracker.pushTool(toolName);

      try {
        const result = tracker
          ? await TokenTracker.runWith(tracker, async () => toolDefinition.execute?.(args, context))
          : await toolDefinition.execute?.(args, context);

        if (tracker) {
          const step = tracker.getStepName();
          tracker.recordUsage(step, toolName, Date.now() - startTime);
        }
        return result;
      } finally {
        if (tracker) tracker.popTool();
      }
    },
  }) as Tool<INPUT, OUTPUT>;
}
