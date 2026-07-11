'use client';

/**
 * REWRITTEN (2026-07-11) alongside the browser_use tool-impl rewrite —
 * the tool now returns a clean, self-consistent shape:
 *   { status: 'finished'|'failed', steps: [{description, screenshotUrl}],
 *     screenshotUrl (last step's, for convenience), markdown }
 * `screenshotUrl` values are real, publicly-fetchable Vercel Blob URLs
 * (uploaded by the tool itself after every action) — not local sandbox
 * paths and not base64 blobs, so a plain <img src> just works, and they
 * keep working after the turn/session ends (unlike the old
 * sessionStorage-only doc preview bug fixed the same day, see
 * make-it-real-result.tsx's comment).
 *
 * Old browser-use.com-shaped output (currentStatus/stepsInfo/finalGif) is
 * still parsed as a fallback for any already-in-flight/historical
 * messages that predate this rewrite, so old chat history doesn't
 * suddenly render as empty.
 */
import type { EveDynamicToolPart } from 'eve/react';
import { useMemo, useState } from 'react';
import { EmbedWebIcon, EmptyIcon, SingleSelectCheckSolidIcon } from '@blocksuite/icons/rc';
import { MarkdownText } from '@/components/ui/markdown';
import { GenericToolResult } from './generic-tool-result';

interface Step {
  description: string;
  screenshotUrl: string | null;
}

interface ParsedBrowserResult {
  status: string;
  currentScreenshot: string | null;
  markdown: string | null;
  steps: Step[];
}

function parseBrowserOutput(raw: unknown): ParsedBrowserResult {
  const empty: ParsedBrowserResult = { status: 'finished', currentScreenshot: null, markdown: null, steps: [] };
  if (!raw || typeof raw !== 'object') return empty;
  const obj = raw as Record<string, unknown>;

  // New shape (current tool-impl).
  if (Array.isArray(obj.steps) && obj.steps.every(s => s && typeof s === 'object' && 'description' in (s as object))) {
    const steps = (obj.steps as Array<{ description?: string; screenshotUrl?: string | null }>).map(s => ({
      description: s.description ?? '',
      screenshotUrl: s.screenshotUrl ?? null,
    }));
    return {
      status: String(obj.status ?? 'finished'),
      currentScreenshot: (obj.screenshotUrl as string | null | undefined) ?? steps[steps.length - 1]?.screenshotUrl ?? null,
      markdown: (obj.markdown as string | null | undefined) ?? null,
      steps,
    };
  }

  // Legacy browser-use.com-style shape (old stepsInfo/finalGif fields),
  // kept purely so historical messages sent before this rewrite still
  // render something reasonable.
  const legacySteps = (obj.stepsInfo as Array<Record<string, unknown>> | undefined) ?? [];
  return {
    status: String(obj.currentStatus ?? obj.status ?? 'finished'),
    currentScreenshot: (obj.currentScreenshot ?? obj.screenshot ?? obj.finalGif ?? null) as string | null,
    markdown: (obj.finalMarkdown ?? obj.markdown ?? obj.summary ?? null) as string | null,
    steps: legacySteps.map(item => ({
      description: String(item.next_goal ?? item.goal ?? item.url ?? ''),
      screenshotUrl: null,
    })),
  };
}

const completedIcon = <SingleSelectCheckSolidIcon fontSize={20} />;
const errorIcon = <EmptyIcon fontSize={20} color="#ED3F3F" />;

function LoadingIcon() {
  return <span className="inline-block w-5 h-5 rounded-full border-2 border-muted-foreground border-t-transparent animate-spin" />;
}

export function BrowserUseResult({ part }: { part: EveDynamicToolPart; isStreaming?: boolean }) {
  const isRunning = part.state === 'input-streaming' || part.state === 'input-available';
  const output = part.state === 'output-available' ? part.output : undefined;
  const parsed = useMemo(() => parseBrowserOutput(output), [output]);
  const status = isRunning ? 'running' : parsed.status;
  const isFinished = status === 'finished' || status === 'stopped' || status === 'failed' || status === 'paused';
  const isFailed = status === 'failed' || status === 'stopped';

  // Which step's screenshot is shown big at the top — defaults to the
  // most recent one, but any thumbnail in the strip below can be clicked
  // to preview an earlier step instead (see thumbnail strip below).
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const screenshotSteps = useMemo(() => parsed.steps.filter(s => s.screenshotUrl), [parsed.steps]);
  const activeShot =
    selectedIndex !== null && screenshotSteps[selectedIndex]
      ? screenshotSteps[selectedIndex].screenshotUrl
      : parsed.currentScreenshot ?? (screenshotSteps.length ? screenshotSteps[screenshotSteps.length - 1].screenshotUrl : null);

  if (part.state === 'output-error') {
    return (
      <GenericToolResult icon={<EmbedWebIcon />} title="The browser task failed." status="output-error">
        <div className="p-3 text-sm text-destructive">{part.errorText}</div>
      </GenericToolResult>
    );
  }

  return (
    <GenericToolResult
      icon={<EmbedWebIcon />}
      title={
        isRunning ? (
          <span className="text-sm text-muted-foreground">The browser task is running. Below are the steps and results.</span>
        ) : isFailed ? (
          <span className="text-sm text-muted-foreground">The browser task did not complete successfully.</span>
        ) : (
          <span className="text-sm text-muted-foreground">The browser task has been completed. Below are the steps and results.</span>
        )
      }
    >
      <div className="max-h-150 overflow-y-auto">
        {activeShot && (
          <div className="p-4 not-prose space-y-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={activeShot}
              alt="Browser screenshot"
              className="w-full max-h-96 object-contain rounded-lg border bg-muted/30"
            />
            {screenshotSteps.length > 1 && (
              <div className="flex gap-2 overflow-x-auto pb-1">
                {screenshotSteps.map((s, idx) => (
                  <button
                    key={idx}
                    onClick={() => setSelectedIndex(idx)}
                    className={`shrink-0 w-16 h-12 rounded border overflow-hidden ${
                      (selectedIndex ?? screenshotSteps.length - 1) === idx ? 'border-primary ring-1 ring-primary' : 'border-border'
                    }`}
                    title={s.description}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={s.screenshotUrl!} alt={s.description} className="w-full h-full object-cover" />
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {isRunning && !activeShot && (
          <div className="p-6 flex items-center justify-center">
            <LoadingIcon />
          </div>
        )}

        {parsed.steps.length > 0 && (
          <div className="p-3 space-y-3">
            <div className="space-y-2">
              {parsed.steps.map((step, index) => {
                const isLastStep = index === parsed.steps.length - 1;
                let icon = completedIcon;
                if (isLastStep) {
                  if (status === 'running' || status === 'created') icon = <LoadingIcon />;
                  else if (isFailed) icon = errorIcon;
                  else icon = completedIcon;
                }
                return (
                  <button
                    key={index}
                    onClick={() => {
                      const shotIdx = screenshotSteps.findIndex(s => s === step);
                      if (shotIdx >= 0) setSelectedIndex(shotIdx);
                    }}
                    className="w-full text-left p-1 rounded hover:bg-accent/50 transition-colors"
                  >
                    <div className="flex items-start gap-3">
                      <div className="flex-shrink-0 mt-0.5">{icon}</div>
                      <div className="text-sm text-foreground">{step.description}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {parsed.markdown && (
          <div className="p-8">
            <div className="text-sm">
              <MarkdownText text={parsed.markdown} className="prose prose-sm max-w-none" />
            </div>
          </div>
        )}

        {parsed.steps.length === 0 && !parsed.markdown && !activeShot && !isRunning && (
          <div className="p-3 text-sm text-muted-foreground text-center">No detailed content available.</div>
        )}
      </div>
    </GenericToolResult>
  );
}
