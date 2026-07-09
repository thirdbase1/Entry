'use client';

/**
 * Ported 1:1 from components/html-previewer.tsx.
 * Renders HTML in a sandboxed iframe.
 */
import { cn } from '@/lib/utils';

export default function HtmlPreviewer({
  code,
  className,
}: {
  code: string;
  className?: string;
}) {
  return (
    <div className={cn(className)}>
      <iframe
        srcDoc={code}
        sandbox="allow-scripts"
        style={{
          width: '100%',
          height: '100%',
          border: 'none',
          background: 'transparent',
        }}
      />
    </div>
  );
}
