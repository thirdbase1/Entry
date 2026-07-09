'use client';

import { CopyIcon, PageIcon } from '@blocksuite/icons/rc';
import { useState } from 'react';
import { cn } from '@/lib/utils';

import { useOpenDocContext } from '@/contexts/doc-panel-context';

interface DocCardProps {
  content: string;
  title?: string;
  description?: string;
}

export function DocCard({ content, title = 'Document', description }: DocCardProps) {
  const { openDoc } = useOpenDocContext();
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy content:', err);
    }
  };

  const handleClick = () => {
    // For inline-generated docs (from chat), we store the content
    // in sessionStorage and navigate to a viewer page
    const tempId = 'temp-' + Date.now();
    sessionStorage.setItem(`doc:${tempId}`, JSON.stringify({ content, title }));
    openDoc(tempId);
  };

  return (
    <div
      className={cn(
        'rounded-lg border border-border bg-card overflow-hidden cursor-pointer hover:bg-accent transition-colors'
      )}
      onClick={handleClick}
    >
      <div className="p-4 space-y-3">
        <div className="flex items-start gap-3">
          <div className="flex-shrink-0 mt-0.5 h-4 flex items-center">
            <PageIcon className="w-4 h-4 text-muted-foreground" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-foreground">
              {title}
            </div>
            {description && (
              <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                {description}
              </p>
            )}
            {content && (
              <div className="mt-2 p-2 bg-muted rounded text-xs text-muted-foreground max-h-32 overflow-y-auto">
                <div className="whitespace-pre-wrap line-clamp-6">
                  {content.length > 500
                    ? content.substring(0, 500) + '...'
                    : content}
                </div>
              </div>
            )}
            <div className="flex items-center gap-2 mt-2">
              <button
                onClick={handleCopy}
                className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-muted hover:bg-accent text-muted-foreground transition-colors"
              >
                <CopyIcon className="w-3 h-3" />
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
