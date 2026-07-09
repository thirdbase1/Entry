/**
 * Ported verbatim (behavior-for-behavior) from
 * packages/frontend/component/src/ui/input/row-input.tsx — a plain input
 * with composition-safe Enter handling, optional debounce, autofocus and
 * autoselect. No visual styling of its own (caller passes `className`),
 * so this ports with zero design-system dependency.
 */
'use client';
import type { ChangeEvent, CompositionEvent, ForwardedRef, InputHTMLAttributes, KeyboardEvent, KeyboardEventHandler } from 'react';
import { forwardRef, useCallback, useEffect, useState } from 'react';

import { useAutoFocus, useAutoSelect } from '@/lib/hooks';

export type RowInputProps = {
  disabled?: boolean;
  onChange?: (value: string) => void;
  onBlur?: (ev: FocusEvent & { currentTarget: HTMLInputElement }) => void;
  onKeyDown?: KeyboardEventHandler<HTMLInputElement>;
  autoSelect?: boolean;
  onEnter?: (value: string) => void;
  debounce?: number;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'size' | 'onBlur'>;

function useDebounceCallback<T extends (...args: any[]) => void>(fn: T, delay?: number): T {
  const [timer, setTimer] = useState<ReturnType<typeof setTimeout> | null>(null);
  return useCallback(
    (...args: Parameters<T>) => {
      if (!delay) return fn(...args);
      if (timer) clearTimeout(timer);
      setTimer(setTimeout(() => fn(...args), delay));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fn, delay, timer]
  ) as T;
}

export const RowInput = forwardRef<HTMLInputElement, RowInputProps>(function RowInput(
  { disabled, onChange: propsOnChange, className, onEnter, onKeyDown, onBlur, autoFocus, autoSelect, debounce, ...otherProps }: RowInputProps,
  upstreamRef: ForwardedRef<HTMLInputElement>
) {
  const [composing, setComposing] = useState(false);
  const focusRef = useAutoFocus<HTMLInputElement>(autoFocus);
  const selectRef = useAutoSelect<HTMLInputElement>(autoSelect);

  const inputRef = useCallback(
    (el: HTMLInputElement | null) => {
      focusRef.current = el;
      selectRef.current = el;
      if (upstreamRef) {
        if (typeof upstreamRef === 'function') upstreamRef(el);
        else upstreamRef.current = el;
      }
    },
    [focusRef, selectRef, upstreamRef]
  );

  useEffect(() => {
    if (!onBlur) return;
    const el = selectRef.current;
    el?.addEventListener('blur', onBlur as any);
    return () => el?.removeEventListener('blur', onBlur as any);
  }, [onBlur, selectRef]);

  const handleChange = useCallback((e: ChangeEvent<HTMLInputElement>) => propsOnChange?.(e.target.value), [propsOnChange]);
  const debounceHandleChange = useDebounceCallback(handleChange, debounce);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      onKeyDown?.(e);
      if (e.key !== 'Enter' || composing) return;
      onEnter?.(e.currentTarget.value);
    },
    [onKeyDown, composing, onEnter]
  );

  return (
    <input
      className={className}
      ref={inputRef}
      disabled={disabled}
      onChange={debounce ? debounceHandleChange : handleChange}
      onKeyDown={handleKeyDown}
      onCompositionStart={() => setComposing(true)}
      onCompositionEnd={() => setComposing(false)}
      {...otherProps}
    />
  );
});
