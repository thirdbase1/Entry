'use client';

/**
 * Ported 1:1 from components/chat/chat-arrow.tsx.
 * Floating "scroll to bottom" arrow with bounce animation when loading.
 */
import { AnimatePresence, motion } from 'framer-motion';
import { forwardRef, useImperativeHandle, useState } from 'react';

import { cn } from '@/lib/utils';

export interface DownArrowRef {
  hide: () => void;
  show: () => void;
}

function ArrowDownBigIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5v14" />
      <path d="m19 12-7 7-7-7" />
    </svg>
  );
}

export const DownArrow = forwardRef<
  DownArrowRef,
  { onClick: () => void; loading: boolean; offset?: number }
>(({ onClick, loading, offset = 24 }, ref) => {
  const [show, setShow] = useState(false);

  useImperativeHandle(ref, () => ({
    hide: () => setShow(false),
    show: () => setShow(true),
  }));

  return (
    <AnimatePresence>
      {show ? (
        <motion.div
          initial={{ opacity: 0, y: 30, scale: 0.8 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 30, scale: 0.8 }}
          transition={{ duration: 0.14 }}
          onClick={onClick}
          style={{ bottom: `${offset}px` }}
          className={cn('absolute left-1/2 -translate-x-1/2 cursor-pointer')}
        >
          <motion.div
            animate={
              loading
                ? {
                    y: [0, 14, 0],
                    boxShadow: [
                      '0px 4px 15px rgba(0,0,0,0.05)',
                      '0px 2px 6px rgba(0,0,0,0.2)',
                      '0px 4px 15px rgba(0,0,0,0.05)',
                    ],
                  }
                : undefined
            }
            transition={{ repeat: Infinity, duration: 2 }}
            className={cn(
              'size-9 rounded-full bg-card border flex items-center justify-center'
            )}
            style={{ boxShadow: '0px 4px 15px rgba(0,0,0,0.05)' }}
          >
            <ArrowDownBigIcon className="text-[22px] text-foreground" />
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
});

DownArrow.displayName = 'DownArrow';
