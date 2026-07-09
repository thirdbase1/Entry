'use client';

import type { EveDynamicToolPart } from 'eve/react';

export function TaskAnalysisCard({ part }: { part: EveDynamicToolPart }) {
  const output = part.state === 'output-available' ? (part.output as { plan?: string[]; summary?: string } | undefined) : undefined;
  const isRunning = part.state === 'input-streaming' || part.state === 'input-available';

  return (
    <div className="rounded-lg border border-border bg-card w-full p-3">
      <div className="flex items-center gap-2 text-sm font-medium text-foreground mb-2">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted-foreground">
          <path d="M9 11l3 3L22 4" />
          <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
        </svg>
        {isRunning ? 'Analyzing task…' : 'Task Analysis'}
      </div>
      {output?.summary && <p className="text-sm text-muted-foreground mb-2">{output.summary}</p>}
      {output?.plan && output.plan.length > 0 && (
        <ul className="space-y-1">
          {output.plan.map((step, i) => (
            <li key={i} className="text-sm text-foreground flex gap-2">
              <span className="text-muted-foreground">{i + 1}.</span>
              {step}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
