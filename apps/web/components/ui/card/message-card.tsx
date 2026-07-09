'use client';

/**
 * Ported 1:1 from components/ui/card/message-card.tsx + message-card.css.ts.
 * Styled card wrapper for tool result messages with loading/skeleton states.
 */
import { cn } from '@/lib/utils';

interface MessageCardProps {
  status: 'success' | 'done' | 'loading' | 'loading-placeholder';
  icon?: React.ReactNode;
  title?: React.ReactNode;
  subTitle?: React.ReactNode;
  className?: string;
}

function LoadingSpinner({ size = 20 }: { size?: number }) {
  return (
    <svg
      className="animate-spin"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
    </svg>
  );
}

const MessageSkeleton = () => (
  <>
    <div className="w-[80%] h-3 bg-muted rounded animate-pulse" />
    <div className="w-[60%] h-2 bg-muted rounded animate-pulse mt-2" />
  </>
);

export function MessageCard({
  status,
  icon,
  title,
  subTitle,
  className,
}: MessageCardProps) {
  const isLoading = status === 'loading' || status === 'loading-placeholder';

  return (
    <div
      className={cn(
        'max-w-[400px] p-4 flex items-center rounded-2xl gap-3',
        'bg-muted/30 shadow-sm border border-border',
        className
      )}
    >
      <div className="w-6 h-6 flex items-center justify-center shrink-0">
        {isLoading ? <LoadingSpinner size={20} /> : icon}
      </div>
      <div className="flex-1 overflow-hidden">
        {status === 'loading-placeholder' ? (
          <MessageSkeleton />
        ) : (
          <>
            {title && (
              <div className="font-medium leading-6 overflow-hidden whitespace-nowrap flex justify-end">
                {title}
              </div>
            )}
            {subTitle && (
              <div className="text-xs leading-6 overflow-hidden text-ellipsis whitespace-nowrap text-muted-foreground">
                {subTitle}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
