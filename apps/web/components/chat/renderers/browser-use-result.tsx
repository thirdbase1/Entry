'use client';

/**
 * Ported 1:1 from pages/chats/renderers/browser-use-result.tsx. Restored
 * the real shell (GenericToolResult, EmbedWebIcon, the exact two-state
 * title copy), the numbered step list with per-step status icon
 * (completed checkmark / spinning loader on the last step while running /
 * red error icon on failure), the screenshot/gif preview, and the final
 * markdown block.
 *
 * The underlying tool changed under eve (apps/agent/agent/tools/browser_use.ts
 * shells out to `agent-browser ... --json` and returns `{ result: <stdout> }`
 * instead of the original browser-use.com SDK's structured
 * `{currentStatus, stepsInfo, finalGif, finalMarkdown}` object). `result` is
 * parsed defensively for either shape (JSON object/array, or a bare
 * markdown/text string) so the same visual treatment applies regardless of
 * the exact field names agent-browser's CLI emits.
 */
import type { EveDynamicToolPart } from 'eve/react';
import { useMemo, useState } from 'react';
import { EmbedWebIcon, EmptyIcon, SingleSelectCheckSolidIcon } from '@blocksuite/icons/rc';
import { MarkdownText } from '@/components/ui/markdown';
import { GenericToolResult } from './generic-tool-result';

interface Step {
  next_goal?: string;
  goal?: string;
  url?: string;
}

interface ParsedBrowserResult {
  status: string;
  screenshot: string | null;
  gif: string | null;
  markdown: string | null;
  steps: Step[];
}

function parseBrowserOutput(raw: unknown): ParsedBrowserResult {
  const empty: ParsedBrowserResult = { status: 'finished', screenshot: null, gif: null, markdown: null, steps: [] };
  if (!raw) return empty;

  let value: unknown = raw;
  if (typeof raw === 'object' && raw !== null && 'result' in (raw as Record<string, unknown>)) {
    value = (raw as { result: unknown }).result;
  }
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      // Not JSON — treat the whole string as the final markdown summary.
      return { ...empty, markdown: value as string };
    }
  }

  if (Array.isArray(value)) {
    const last = value[value.length - 1] ?? {};
    return {
      status: last.currentStatus ?? last.status ?? 'finished',
      screenshot: last.currentScreenshot ?? last.screenshot ?? null,
      gif: last.finalGif ?? last.gif ?? null,
      markdown: last.finalMarkdown ?? last.markdown ?? last.summary ?? null,
      steps: value.map((item: Record<string, unknown>) => item.step ?? item).filter(Boolean),
    };
  }

  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return {
      status: String(obj.currentStatus ?? obj.status ?? 'finished'),
      screenshot: (obj.currentScreenshot ?? obj.screenshot ?? null) as string | null,
      gif: (obj.finalGif ?? obj.gif ?? null) as string | null,
      markdown: (obj.finalMarkdown ?? obj.markdown ?? obj.summary ?? null) as string | null,
      steps: (obj.stepsInfo ?? obj.steps ?? []) as Step[],
    };
  }

  return empty;
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
  const currentImage = parsed.gif || parsed.screenshot || null;
  const status = isRunning ? 'running' : parsed.status;
  const isFinished = status === 'finished' || status === 'stopped' || status === 'failed' || status === 'paused';

  if (part.state === 'output-error') {
    return (
      <GenericToolResult icon={<EmbedWebIcon />} title="The browser task failed.">
        <div className="p-3 text-sm text-destructive">{part.errorText}</div>
      </GenericToolResult>
    );
  }

  return (
    <GenericToolResult
      icon={<EmbedWebIcon />}
      title={
        isFinished ? (
          <span className="text-sm text-muted-foreground">
            The browser task has been completed. Below are the steps and results.
          </span>
        ) : (
          <span className="text-sm text-muted-foreground">
            The browser task is running. Below are the steps and results.
          </span>
        )
      }
    >
      <div className="max-h-150 overflow-y-auto">
        {currentImage && (
          <div className="p-4 not-prose">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={currentImage} alt="Browser screenshot" className="w-full max-h-96 object-contain rounded-lg border" />
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
                  else if (status === 'stopped' || status === 'failed' || status === 'paused') icon = errorIcon;
                  else icon = completedIcon;
                }
                return (
                  <div key={index} className="p-1">
                    <div className="flex items-start gap-3">
                      <div className="flex-shrink-0 mt-0.5">{icon}</div>
                      <div className="text-sm text-foreground">{step.next_goal ?? step.goal ?? step.url ?? ''}</div>
                    </div>
                  </div>
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

        {parsed.steps.length === 0 && !parsed.markdown && !currentImage && (
          <div className="p-3 text-sm text-muted-foreground text-center">No detailed content available.</div>
        )}
      </div>
    </GenericToolResult>
  );
}
