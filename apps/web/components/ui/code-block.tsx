'use client';

/**
 * Ported 1:1 from components/ui/code-block.tsx.
 * Expandable code block with copy button and syntax highlighting.
 * Uses a simple <pre> fallback for highlighting (the original used
 * use-highlighted-code from @afk/component; we use a lightweight
 * inline approach compatible with our stack).
 */
import { useEffect, useRef, useState } from 'react';

function CopyIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </svg>
  );
}

function ExpandOpenIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 3h6v6" /><path d="M9 21H3v-6" /><path d="M21 3l-7 7" /><path d="M3 21l7-7" />
    </svg>
  );
}

function ExpandCloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 3v4a1 1 0 0 1-1 1H3" /><path d="M21 8h-4a1 1 0 0 1-1-1V3" /><path d="M16 21v-4a1 1 0 0 1 1-1h4" /><path d="M3 16h4a1 1 0 0 1 1 1v4" />
    </svg>
  );
}

export function CodeBlock({
  children,
  language,
}: {
  children: React.ReactNode;
  language: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [hitMaxHeight, setHitMaxHeight] = useState(false);
  const [copied, setCopied] = useState(false);
  const codeBlockRef = useRef<HTMLDivElement>(null);

  const codeText = typeof children === 'string' ? children : '';

  useEffect(() => {
    if (!codeBlockRef.current) return;
    const observer = new ResizeObserver(() => {
      if (!codeBlockRef.current) return;
      const height = codeBlockRef.current.scrollHeight;
      setHitMaxHeight(height > 400);
    });
    observer.observe(codeBlockRef.current);
    return () => observer.disconnect();
  }, []);

  const handleCopy = () => {
    navigator.clipboard.writeText(codeText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="custom-code-block w-full rounded-xl border not-prose overflow-hidden">
      <header className="flex items-center justify-between border-b h-12 px-4 bg-muted/50">
        <div className="text-sm text-muted-foreground">{language}</div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleCopy}
            className="p-1.5 rounded hover:bg-accent transition-colors text-muted-foreground"
            title="Copy"
          >
            {copied ? <span className="text-xs">✓</span> : <CopyIcon />}
          </button>
          {hitMaxHeight ? (
            <button
              onClick={() => setExpanded(!expanded)}
              className="p-1.5 rounded hover:bg-accent transition-colors text-muted-foreground"
              title={expanded ? 'Collapse' : 'Expand'}
            >
              {expanded ? <ExpandCloseIcon /> : <ExpandOpenIcon />}
            </button>
          ) : null}
        </div>
      </header>
      <div
        ref={codeBlockRef}
        className="p-4 text-[13px] overflow-auto bg-card text-card-foreground"
        style={{
          maxHeight: expanded ? 'none' : '400px',
        }}
      >
        <pre className="font-mono whitespace-pre-wrap break-words">{codeText}</pre>
      </div>
    </div>
  );
}
