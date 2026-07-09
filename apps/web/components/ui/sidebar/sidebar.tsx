'use client';

import { type HTMLAttributes, useCallback, useRef } from 'react';
import { cn } from '@/lib/utils';
import { useSidebarStore } from '@/store/sidebar';

const SIDEBAR_WIDTH_MIN = 200;
const SIDEBAR_WIDTH_MAX = 320;

export type AppSidebarProps = HTMLAttributes<HTMLDivElement>;

export default function AppSidebar({
  children,
  className,
  style,
  ...props
}: AppSidebarProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { width, setWidth, open, setResizing } = useSidebarStore();

  const initailWidthRef = useRef(0);
  const initialClientXRef = useRef(0);
  const prevClientXRef = useRef(0);

  const onDragStart = useCallback(
    (clientX: number) => {
      initailWidthRef.current = containerRef.current?.offsetWidth ?? 0;
      initialClientXRef.current = clientX;
      setResizing(true);
    },
    [setResizing]
  );

  const onDragMove = useCallback((clientX: number) => {
    const delta = clientX - initialClientXRef.current;
    const newWidth = Math.max(
      SIDEBAR_WIDTH_MIN,
      Math.min(SIDEBAR_WIDTH_MAX, initailWidthRef.current + delta)
    );
    prevClientXRef.current = clientX;
    if (containerRef.current) {
      containerRef.current.style.width = `${newWidth}px`;
    }
  }, []);

  const onDragEnd = useCallback(() => {
    const delta = prevClientXRef.current - initialClientXRef.current;
    const newWidth = Math.max(
      SIDEBAR_WIDTH_MIN,
      Math.min(SIDEBAR_WIDTH_MAX, initailWidthRef.current + delta)
    );
    setWidth(newWidth);
    setResizing(false);
  }, [setResizing, setWidth]);

  const onMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!open) return;
      e.preventDefault();
      e.stopPropagation();
      onDragStart(e.clientX);

      const onMouseMove = (e: MouseEvent) => onDragMove(e.clientX);
      const onMouseUp = () => {
        onDragEnd();
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
      };
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    },
    [onDragEnd, onDragMove, onDragStart, open]
  );

  return (
    <div
      ref={containerRef}
      className={cn('flex justify-end transition-all duration-200 ease-in-out', !open && 'transition-none')}
      style={{
        width: open ? `${width}px` : 0,
      }}
    >
      <div
        className={cn('relative shrink-0 flex flex-col', className)}
        style={{
          ...style,
          width: `${width}px`,
        }}
        {...props}
      >
        {children}
        {open && (
          <div
            className="absolute flex cursor-col-resize justify-center right-[-5px] top-0 w-[10px] h-full"
            onMouseDown={onMouseDown}
          >
            <div className="h-full w-[2px] bg-transparent hover:bg-primary opacity-0 hover:opacity-100 transition-opacity" />
          </div>
        )}
      </div>
    </div>
  );
}
