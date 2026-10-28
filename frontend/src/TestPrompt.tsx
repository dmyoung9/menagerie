import { useEffect, useRef, useState } from 'react';
import { Field, message } from './ui';
import type { Deployment } from './types';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { FieldGroup } from '@/components/ui/field';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { streamCompletion } from './completionStream';

export function TestPrompt({ deployments }: { deployments: Deployment[] }) {
  const available = deployments.filter((d) => d.enabled && d.state === 'READY');
  const [alias, setAlias] = useState(''),
    [prompt, setPrompt] = useState('Say hello in one sentence.'),
    [output, setOutput] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const selected = available.some((d) => d.alias === alias)
    ? alias
    : available[0]?.alias || '';
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setError('');
        setOutput('');
        setBusy(true);
        const current = new AbortController();
        controller.current = current;
        try {
          await streamCompletion(selected, prompt, current.signal, (text) =>
            setOutput((old) => old + text),
          );
        } catch (e) {
          setError(
            current.signal.aborted
              ? 'Request cancelled. Any partial response is kept below.'
              : message(e),
          );
        } finally {
          setBusy(false);
          controller.current = null;
        }
      }}
    >
      <FieldGroup>
        {!available.length && (
          <p>Load an enabled deployment and wait for Ready to test it here.</p>
        )}
        <Field label="Test model">
          <NativeSelect
            disabled={busy || !available.length}
            value={selected}
            onChange={(e) => setAlias(e.target.value)}
          >
            {available.map((d) => (
              <NativeSelectOption key={d.id} value={d.alias}>
                {d.alias}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <Field label="Test prompt">
          <Textarea
            required
            maxLength={4000}
            disabled={busy}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </Field>
        <Button type="submit" disabled={busy || !selected || !prompt.trim()}>
          {busy ? 'Receiving…' : 'Send test prompt'}
        </Button>
        {busy && (
          <Button
            variant="outline"
            type="button"
            onClick={() => controller.current?.abort()}
          >
            Cancel request
          </Button>
        )}
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <pre
          aria-label="Test response"
          aria-live="polite"
          className="whitespace-pre-wrap break-words"
        >
          {output}
        </pre>
        <p className="muted">
          Uses the local gateway. This test is not saved as a conversation.
          Normal gateway request accounting still applies.
        </p>
      </FieldGroup>
    </form>
  );
}
