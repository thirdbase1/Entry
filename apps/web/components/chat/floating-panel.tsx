'use client';

/**
 * Shared portal-based floating panel for the chat input's popovers (model
 * picker, tools menu, attach-context menu).
 *
 * Why this exists: those three menus used to be plain `absolute bottom-full`
 * divs nested inside the chat input bar's rounded container — which has
 * `overflow-hidden` (needed to clip the textarea/buttons to the rounded
 * corners). Because CSS overflow clips ANY descendant that visually
 * extends past the container's box, not just ones with `overflow-x/y`
 * scrolling, those dropdowns got sliced off by that ancestor and rendered
 * as a squashed, overlapping mess instead of a clean list — "it looks
 * like many models are under [each other]".
 *
 * Fix: render the panel through a React portal straight into
 * `document.body`, positioned with `position: fixed` computed from the
 * trigger's own bounding rect. That escapes the ancestor's clipping
 * entirely, same trick Radix/Popper use under the hood.
 */
import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface FloatingPanelProps {
  open: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  align?: 'left' | 'right';
  gap?: number;
  children: React.ReactNode;
}

export function FloatingPanel({ open, onClose, anchorRef, align = 'left', gap = 8, children }: FloatingPanelProps) {
  const [pos, setPos] = useState<{ left?: number; right?: number; bottom: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }

    const reposition = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const bottom = window.innerHeight - rect.top + gap;
      if (align === 'right') {
        setPos({ right: window.innerWidth - rect.right, bottom });
      } else {
        setPos({ left: rect.left, bottom });
      }
    };

    reposition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open, align, gap, anchorRef]);

  useLayoutEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose();
    };
    const onEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onClickOutside);
    document.addEventListener('keydown', onEscape);
    return () => {
      document.removeEventListener('mousedown', onClickOutside);
      document.removeEventListener('keydown', onEscape);
    };
  }, [open, onClose, anchorRef]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={panelRef}
      style={{
        position: 'fixed',
        left: pos?.left,
        right: pos?.right,
        bottom: pos?.bottom ?? 0,
        // Stay invisible for the one frame before we've measured the
        // anchor — avoids a flash at (0,0) before reposition() runs.
        visibility: pos ? 'visible' : 'hidden',
      }}
      className="z-50"
    >
      {children}
    </div>,
    document.body
  );
}
