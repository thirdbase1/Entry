'use client';

/**
 * Ported 1:1 from pages/chats/renderers/code-artifact-result.tsx +
 * code-artifact-result.css.ts. Restored: the real GenericToolResult shell
 * with the Code/Preview segmented toggle (only visible while expanded,
 * matching the original's `collapsed ? null : <RadioGroup/>` via
 * `onCollapseChange`), download-as-.html and copy-to-clipboard icon
 * buttons in the header actions slot, and the live HTML preview via the
 * already-ported `HtmlPreviewer` sandboxed iframe. Both Code and Preview
 * views are kept mounted (Code view just toggles opacity/pointer-events)
 * exactly like the original, so switching tabs doesn't remount the iframe.
 *
 * Adapted field names: eve's code_artifact tool (apps/agent/agent/tools/
 * code_artifact.ts) returns `{title, html, size}` directly on
 * `output-available` — no separate `previewUrl`, so the previewer is fed
 * the raw `html` string via `srcDoc` (same as the original, which also
 * used the raw HTML string, not a hosted URL).
 *
 * NOTE: no syntax highlighter is installed anywhere in this ported app
 * (verified — a systemic gap, see python-code-result.tsx's note), so the
 * Code view still renders plain monospace text instead of the original's
 * shiki-highlighted HTML.
 */
import type { EveDynamicToolPart } from 'eve/react';
import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { CopyIcon, DownloadIcon, FileIconHtmlIcon } from '@blocksuite/icons/rc';
import HtmlPreviewer from '@/components/html-previewer';
import { cn } from '@/lib/utils';
import { GenericToolResult } from './generic-tool-result';
import { GenericToolCalling } from './generic-tool-calling';

function downloadRaw(content: string, mime: string, filename: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function IconButton({ icon, onClick }: { icon: React.ReactNode; onClick: (e: React.MouseEvent) => void }) {
  return (
    <button
      onClick={onClick}
      className="size-6 shrink-0 flex items-center justify-center rounded hover:bg-accent transition-colors text-muted-foreground"
    >
      {icon}
    </button>
  );
}

export function CodeArtifactResult({ part }: { part: EveDynamicToolPart }) {
  const [view, setView] = useState<'Code' | 'Preview'>('Code');
  const [collapsed, setCollapsed] = useState(true);
  const input = part.input as { title?: string; userPrompt?: string } | undefined;
  const output =
    part.state === 'output-available'
      ? (part.output as { title?: string; html?: string; truncated?: boolean; note?: string } | undefined)
      : undefined;
  const isRunning = part.state === 'input-streaming' || part.state === 'input-available';

  const title = output?.title ?? input?.title ?? 'Code Artifact';
  const html = output?.html ?? '';
  const truncated = output?.truncated ?? false;

  if (isRunning || !html) {
    return <GenericToolCalling icon={<FileIconHtmlIcon />} title={`Calling code_artifact …`} />;
  }

  if (part.state === 'output-error') {
    return (
      <GenericToolResult title={title} icon={<FileIconHtmlIcon />} status="output-error">
        <div className="p-3 text-sm text-destructive">{part.errorText}</div>
      </GenericToolResult>
    );
  }

  return (
    <GenericToolResult
      title={title}
      icon={<FileIconHtmlIcon />}
      onCollapseChange={setCollapsed}
      actions={
        <AnimatePresence>
          {collapsed ? null : (
            <motion.div
              key="view-toggle"
              initial={{ opacity: 0, x: 20, scale: 0.95 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 20, scale: 0.95 }}
              transition={{ duration: 0.2 }}
              className="flex items-center gap-0.5 mr-2 rounded-md bg-muted p-0.5"
            >
              {(['Code', 'Preview'] as const).map(option => (
                <button
                  key={option}
                  onClick={e => {
                    e.stopPropagation();
                    setView(option);
                  }}
                  className={cn(
                    'text-xs px-2 py-1 rounded transition-colors',
                    view === option ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'
                  )}
                >
                  {option}
                </button>
              ))}
            </motion.div>
          )}
          <IconButton
            icon={<DownloadIcon />}
            onClick={e => {
              e.stopPropagation();
              downloadRaw(html, 'text/html', `${title}.html`);
            }}
          />
          <IconButton
            icon={<CopyIcon />}
            onClick={e => {
              e.stopPropagation();
              navigator.clipboard.writeText(html);
            }}
          />
        </AnimatePresence>
      }
    >
      {truncated && (
        <div className="mx-4 mt-3 flex items-start gap-1.5 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-700 dark:text-amber-400">
          <span className="shrink-0">⚠️</span>
          <span>{output?.note ?? 'Output was cut off by the token limit before finishing — this HTML is likely incomplete/broken.'}</span>
        </div>
      )}
      <div className={cn('relative', view === 'Preview' && 'h-150')}>
        <HtmlPreviewer
          code={html}
          className={cn('size-full min-h-150 absolute', view === 'Code' ? 'opacity-0 pointer-events-none' : '')}
        />
        {view === 'Code' ? (
          <pre className="not-prose max-h-150 overflow-y-auto relative z-1 p-4 text-xs font-mono bg-muted text-foreground whitespace-pre-wrap">
            {html}
          </pre>
        ) : null}
      </div>
    </GenericToolResult>
  );
}
