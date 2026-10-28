import { useEffect, useRef, useState } from 'react';
import { Textarea } from '@/components/ui/textarea';
import type { Decoder } from './decode';

const pretty = (value: unknown) => JSON.stringify(value, null, 2);

export function Json({ value }: { value: unknown }) {
  return <pre>{pretty(value)}</pre>;
}

export function JsonEdit<T>({
  label,
  value,
  onChange,
  onValid,
  decode,
}: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  onValid?: (valid: boolean) => void;
  decode: Decoder<T>;
}) {
  const [text, setText] = useState(pretty(value));
  const [error, setError] = useState('');
  const serialized = pretty(value);
  const lastEdited = useRef(serialized);
  useEffect(() => {
    if (serialized !== lastEdited.current) {
      // Update the guard before notifying a parent that might rerender us.
      lastEdited.current = serialized;
      setText(serialized);
      setError('');
      onValid?.(true);
    }
  }, [serialized, onValid]);
  return (
    <details>
      <summary>{label}</summary>
      <Textarea
        aria-label={label}
        aria-invalid={!!error}
        rows={8}
        value={text}
        spellCheck={false}
        onChange={(event) => {
          setText(event.target.value);
          try {
            const parsed: unknown = JSON.parse(event.target.value);
            const next = decode(parsed, label);
            lastEdited.current = pretty(next);
            onChange(next);
            setError('');
            onValid?.(true);
          } catch (error) {
            setError(
              error instanceof SyntaxError
                ? 'Enter valid JSON before saving.'
                : error instanceof Error
                  ? error.message
                  : 'Enter a valid value before saving.',
            );
            onValid?.(false);
          }
        }}
      />
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </details>
  );
}
