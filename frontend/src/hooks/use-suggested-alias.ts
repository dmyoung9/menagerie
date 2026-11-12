import { useEffect, useState } from 'react';

import {
  fetchSuggestedAlias,
  localAliasFallback,
  type AliasSuggestion,
  type IdentifierMode,
} from '../alias-suggestion';
import { message } from '../ui';

export type SuggestedAlias = {
  alias: string;
  base: string;
  mode: IdentifierMode;
  busy: boolean;
  error: string | undefined;
};

/**
 * Debounced, server-driven suggestion of a model's API identifier from its
 * display name. Re-fetches whenever the name changes; stale responses are
 * discarded so the preview always reflects the latest typed name.
 */
export function useSuggestedAlias(
  name: string,
  enabled = true,
): SuggestedAlias {
  const [state, setState] = useState<AliasSuggestion | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!enabled) {
      setBusy(false);
      return;
    }
    let cancelled = false;
    setBusy(true);
    const timer = setTimeout(() => {
      void fetchSuggestedAlias(name).then(
        (suggestion) => {
          if (!cancelled) {
            setState(suggestion);
            setBusy(false);
          }
        },
        (e) => {
          if (!cancelled) {
            setState({
              alias: localAliasFallback(name),
              base: localAliasFallback(name),
              mode: 'generated',
            });
            setError(message(e));
            setBusy(false);
          }
        },
      );
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [name, enabled]);

  return {
    alias: state?.alias ?? (name ? localAliasFallback(name) : ''),
    base: state?.base ?? '',
    mode: state?.mode ?? 'generated',
    busy,
    error,
  };
}
