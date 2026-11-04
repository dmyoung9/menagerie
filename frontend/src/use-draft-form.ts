import {
  createContext,
  useCallback,
  useContext,
  useState,
  type SetStateAction,
} from 'react';
import { useForm, useStore } from '@tanstack/react-form';
import {
  commitFlagInputs,
  flagInputs,
  reconcileInputs,
  type FormDraft,
} from './draft-form';

function useInternalForm(
  initial: FormDraft,
  save: (draft: FormDraft) => void | Promise<void>,
) {
  return useForm({
    // Keep the recursive JSON draft opaque to TanStack's DeepKeys type expansion.
    // Editor adapters own its shape; the editor-kind generic remains checked below.
    defaultValues: {
      draft: initial as unknown,
      inputs: flagInputs(initial),
    },
    onSubmit: async ({ value }) =>
      save(commitFlagInputs(value.draft as FormDraft, value.inputs)),
  });
}
type DraftForm = ReturnType<typeof useInternalForm>;
const DraftFormContext = createContext<DraftForm | null>(null);
export const DraftFormProvider = DraftFormContext.Provider;
export function useSharedDraftForm() {
  const form = useContext(DraftFormContext);
  if (!form) throw new Error('Runtime flags require the editor draft form.');
  return form;
}

/** One draft owner for ordinary controls, JSON edits and transient numeric text. */
export function useDraftForm<T extends FormDraft>(
  initial: T,
  save: (draft: T) => void | Promise<void>,
) {
  const [baseline] = useState(initial);
  // The shared context erases only the editor kind; callers retain their draft type.
  const form = useInternalForm(baseline, (draft) => save(draft as T));
  const state = useStore(form.store, (state) => state.values);
  const value = state.draft as T;
  const expectedInputs = flagInputs(value);
  const changed =
    JSON.stringify(value) !== JSON.stringify(baseline) ||
    Object.entries(state.inputs).some(
      ([key, text]) =>
        expectedInputs[key] !== undefined && text !== expectedInputs[key],
    );
  const setValue = useCallback(
    (update: SetStateAction<T>) => {
      const previous = form.getFieldValue('draft') as T;
      const next = typeof update === 'function' ? update(previous) : update;
      const oldInputs = flagInputs(previous);
      const nextInputs = flagInputs(next);
      const inputs = form.getFieldValue('inputs');
      const membersChanged =
        'members' in previous &&
        'members' in next &&
        previous.members.map((m) => m.id ?? m.port).join(',') !==
          next.members.map((m) => m.id ?? m.port).join(',');
      for (const key of Object.keys(oldInputs))
        if (!(key in nextInputs) || membersChanged)
          form.deleteField(`inputs.${key}`);
      form.setFieldValue('inputs', reconcileInputs(previous, next, inputs));
      form.setFieldValue('draft', next);
    },
    [form],
  );
  return { form, value, setValue, changed, reset: () => form.reset() };
}
