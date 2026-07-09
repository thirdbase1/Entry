/**
 * Ported verbatim from packages/frontend/component/src/hooks/focus-and-select.ts.
 */
'use client';
import { useLayoutEffect, useRef } from 'react';

export function useAutoFocus<T extends HTMLElement = HTMLElement>(autoFocus?: boolean) {
  const ref = useRef<T | null>(null);
  useLayoutEffect(() => {
    if (ref.current && autoFocus) {
      setTimeout(() => ref.current?.focus(), 0);
    }
  }, [autoFocus]);
  return ref;
}

export function useAutoSelect<T extends HTMLInputElement = HTMLInputElement>(autoSelect?: boolean) {
  const ref = useRef<T | null>(null);
  useLayoutEffect(() => {
    if (ref.current && autoSelect) {
      setTimeout(() => ref.current?.select(), 0);
    }
  }, [autoSelect, ref]);
  return ref;
}
