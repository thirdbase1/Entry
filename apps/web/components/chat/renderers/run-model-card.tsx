'use client';

/**
 * Dedicated renderer for the `run_model` tool (apps/agent/agent/tools/run_model.ts).
 *
 * Before this existed, run_model had no case in message-renderer.tsx's
 * switch, so it fell through to GenericToolCard's default: a raw
 * `JSON.stringify(part.output)` <pre> block titled "run_model result".
 * Since run_model's output IS `{ answer, error?, stepsUsed? }` and
 * instructions.ts's <model_routing> hard rule tells the orchestrator to
 * return that same `answer` "essentially verbatim" as its own next text
 * part — every single message routed through a non-default model (any
 * Gateway pick, any BYOK model) rendered its answer TWICE: once as an
 * ugly unstyled JSON dump, then again properly formatted right below it.
 * This happened on every turn for the single most-used "pick a model"
 * feature in the whole chat UI, not an edge case.
 *
 * Fix: a small, quiet pill — "Routed to <model>" while running / once
 * done — with no answer text repeated (the model's own next text part
 * already carries it). Errors ARE shown here too (not duplicative in the
 * same way — the model's relayed text is prose, this is the precise
 * failure reason) so a failed route is visible right at the tool-call
 * site, not just buried in the following sentence.
 */
import type { EveDynamicToolPart } from 'eve/react';

interface RunModelInput {
  modelSlug?: string;
  byokModelId?: string;
  task?: string;
}

interface RunModelOutput {
  answer?: string;
  error?: string;
  stepsUsed?: number;
}

function modelLabel(input: RunModelInput | undefined): string {
  if (!input) return 'model';
  if (input.modelSlug) return input.modelSlug;
  if (input.byokModelId) return 'your connected model';
  return 'model';
}

export function RunModelCard({ part }: { part: EveDynamicToolPart }) {
  const input = part.input as RunModelInput | undefined;
  const isRunning = part.state === 'input-streaming' || part.state === 'input-available';
  const label = modelLabel(input);

  if (isRunning) {
    return (
      <div className="h-9 flex items-center gap-2 border rounded-full px-3 w-fit text-xs text-muted-foreground bg-card">
        <span className="w-3 h-3 rounded-full border-2 border-muted-foreground border-t-transparent animate-spin" />
        Routing to {label}…
      </div>
    );
  }

  if (part.state === 'output-error') {
    return (
      <div className="h-9 flex items-center gap-2 border border-destructive/30 rounded-full px-3 w-fit text-xs text-destructive bg-destructive/10">
        Failed to route to {label}: {part.errorText}
      </div>
    );
  }

  const output = part.output as RunModelOutput | undefined;

  // The model's error is already relayed in the following text part per
  // instructions.ts — but surface it here too, precisely, in case the
  // model's prose paraphrases it loosely.
  if (output?.error) {
    return (
      <div className="h-9 flex items-center gap-2 border border-destructive/30 rounded-full px-3 w-fit text-xs text-destructive bg-destructive/10">
        {label}: {output.error}
      </div>
    );
  }

  // Success — no answer text here on purpose (see file doc comment).
  return (
    <div className="h-7 flex items-center gap-1.5 border rounded-full px-2.5 w-fit text-[11px] text-muted-foreground bg-card">
      <span className="w-1.5 h-1.5 rounded-full bg-status-success" />
      Routed to {label}
    </div>
  );
}
