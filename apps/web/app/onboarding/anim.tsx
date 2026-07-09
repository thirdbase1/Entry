'use client';

import { AnimatePresence, motion, type HTMLMotionProps } from 'framer-motion';
import type { ReactNode } from 'react';

/** Ported near-verbatim from pages/onboarding/enter-anim.tsx. */
export function EnterAnim({
  items,
  duration = 0.4,
  gap = 0.13,
  onAnimationEnd,
}: {
  items: ReactNode[];
  duration?: number;
  gap?: number;
  onAnimationEnd?: () => void;
}) {
  return (
    <>
      {items.map((child, index) => (
        <motion.div
          key={index}
          initial={{ y: -10, opacity: 0, filter: 'blur(10px)' }}
          animate={{ y: 0, opacity: 1, scale: 1, filter: 'blur(0px)' }}
          transition={{ duration, delay: index * gap }}
          onAnimationComplete={() => {
            if (index === items.length - 1) onAnimationEnd?.();
          }}
        >
          {child}
        </motion.div>
      ))}
    </>
  );
}

/** Ported near-verbatim from pages/onboarding/leave-anim.tsx. */
export function LeaveAnim({
  show,
  onAnimationEnd,
  children,
  ...props
}: HTMLMotionProps<'div'> & { show?: boolean; onAnimationEnd?: () => void }) {
  return (
    <AnimatePresence>
      {show ? (
        <motion.div
          initial={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.9, filter: 'blur(20px)' }}
          transition={{ duration: 0.3 }}
          onAnimationComplete={() => onAnimationEnd?.()}
          {...props}
        >
          {children}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
