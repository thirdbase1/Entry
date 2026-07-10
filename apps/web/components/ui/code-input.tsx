/**
 * Replaces `react-verification-code-input` (used by the original's
 * sign-in "magic" step for 6-digit OTP entry). That package's peer deps
 * cap at React 17 (confirmed via `npm view react-verification-code-input
 * peerDependencies`) — genuinely incompatible with this app's React 19,
 * not just a version-warning risk (old class-component patterns like
 * findDOMNode were removed in React 18+). Rebuilt as a small equivalent:
 * same visual contract (N boxed single-char inputs, configurable
 * width/height), same behavior (auto-advance on digit entry, backspace
 * moves to the previous box, paste fills all boxes), same onChange(string)
 * callback shape as the original's `onChange` prop.
 *
 * Also handles the case where a single box receives multiple characters
 * at once (autofill suggestions, password managers, and some mobile
 * keyboards insert the full code into whichever box is focused instead
 * of firing a real clipboard "paste" event) — those keystrokes land as a
 * multi-character native `input` event, not a `paste` event, so the
 * dedicated onPaste handler alone doesn't catch them.
 */
'use client';
import { useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';

export interface CodeInputProps {
  length?: number;
  value: string;
  onChange: (value: string) => void;
  fieldWidth?: number;
  fieldHeight?: number;
  autoFocus?: boolean;
  className?: string;
}

export function CodeInput({ length = 6, value, onChange, fieldWidth = 43, fieldHeight = 43, autoFocus, className }: CodeInputProps) {
  const digits = Array.from({ length }, (_, i) => value[i] ?? '');
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const [focusIndex, setFocusIndex] = useState(0);

  const setDigit = (index: number, digit: string) => {
    const next = digits.slice();
    next[index] = digit;
    onChange(next.join('').slice(0, length));
  };

  const fillFrom = (index: number, sequence: string) => {
    const next = digits.slice();
    for (let i = 0; i < sequence.length && index + i < length; i++) {
      next[index + i] = sequence[i];
    }
    onChange(next.join('').slice(0, length));
    const lastFilled = Math.min(index + sequence.length, length) - 1;
    refs.current[Math.min(lastFilled + 1, length - 1)]?.focus();
  };

  const handleChange = (index: number, raw: string) => {
    const cleaned = raw.replace(/\D/g, '');
    if (cleaned.length > 1) {
      // Multiple digits landed in one box at once (autofill, password
      // manager, or fast automated typing outrunning the auto-advance
      // focus change) — distribute them across the remaining boxes
      // instead of silently dropping all but the last character.
      fillFrom(index, cleaned.slice(0, length - index));
      return;
    }
    const digit = cleaned.slice(-1);
    setDigit(index, digit);
    if (digit && index < length - 1) {
      refs.current[index + 1]?.focus();
    }
  };

  const handleKeyDown = (index: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !digits[index] && index > 0) {
      refs.current[index - 1]?.focus();
    }
  };

  const handlePaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, length);
    if (!pasted) return;
    e.preventDefault();
    fillFrom(0, pasted);
  };

  return (
    <div className={className} style={{ display: 'flex', gap: 8 }}>
      {digits.map((digit, i) => (
        <input
          key={i}
          ref={el => {
            refs.current[i] = el;
          }}
          value={digit}
          onChange={e => handleChange(i, e.target.value)}
          onKeyDown={e => handleKeyDown(i, e)}
          onPaste={handlePaste}
          onFocus={() => setFocusIndex(i)}
          autoFocus={autoFocus && i === 0}
          inputMode="numeric"
          maxLength={length}
          style={{
            width: fieldWidth,
            height: fieldHeight,
            textAlign: 'center',
            fontSize: 18,
            borderRadius: 8,
            border: `1px solid ${focusIndex === i ? '#000' : 'var(--affine-v2-layer-insideBorder-border)'}`,
            outline: 'none',
            fontFamily: 'inherit',
          }}
        />
      ))}
    </div>
  );
}
