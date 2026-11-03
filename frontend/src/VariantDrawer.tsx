import { useId, useRef, useState, type RefObject } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { FieldGroup } from '@/components/ui/field';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
  DrawerFooter,
} from '@/components/ui/drawer';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/ui/alert-dialog';
import { useIsMobile } from '@/hooks/use-mobile';
import { useUnsavedChanges } from '@/hooks/use-unsaved-changes';
import { Field } from './ui';
import { NumberControl } from './NumberControl';
import { configuredMode, modeLabel } from './capabilityOptions';
import {
  changeControl,
  controlFor,
  parseMapping,
  templateArgs,
  type Control,
} from './variant-mapping';
import type { JsonObject, ReasoningPreset } from './types';

const descriptions: Record<Control, string> = {
  effort:
    'Send a named effort value through the request body or the model’s chat template. Your runtime must support the selected field and value.',
  budget:
    'Limit reasoning tokens using the request field your runtime supports. These are alternative field names, not two universally different kinds of budget.',
  thinking:
    'Turn thinking on or off through chat_template_kwargs.enable_thinking. Requires a compatible chat template.',
  custom:
    'Combine supported reasoning fields using Request JSON below. Prompt-only variants are also supported.',
};

export function VariantDrawer({
  initial,
  adding,
  apply,
  close,
  returnFocus,
}: {
  initial: ReasoningPreset;
  adding: boolean;
  apply: (mode: ReasoningPreset) => void;
  close: () => void;
  returnFocus: RefObject<HTMLElement | null>;
}) {
  const [mode, setMode] = useState(() => structuredClone(initial));
  const [control, setControl] = useState<Control>(() =>
    controlFor(initial.body),
  );
  const [text, setText] = useState(() => JSON.stringify(initial.body, null, 2));
  const [error, setError] = useState('');
  const [invalidText, setInvalidText] = useState(false);
  const [discard, setDiscard] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const mobile = useIsMobile();
  const dirty =
    JSON.stringify(mode) !== JSON.stringify(initial) ||
    text !== JSON.stringify(initial.body, null, 2);
  const navigationGuard = useUnsavedChanges(dirty);
  const unconfigured = !configuredMode(mode) && mode.id !== 'default';
  const kwargs = templateArgs(mode.body);
  const templateEffort =
    !('reasoning_effort' in mode.body) &&
    typeof kwargs.reasoning_effort === 'string';
  const budgetKey =
    'reasoning_budget' in mode.body ? 'reasoning_budget' : 'thinking_budget';
  const dismiss = () => (dirty ? setDiscard(true) : close());
  function write(body: JsonObject) {
    setMode({ ...mode, body });
    setText(JSON.stringify(body, null, 2));
    setError('');
    setInvalidText(false);
  }
  return (
    <Drawer
      open
      swipeDirection={mobile ? 'down' : 'right'}
      onOpenChange={(open, details) => {
        if (!open) {
          details.cancel();
          dismiss();
        }
      }}
    >
      <DrawerContent initialFocus={nameRef} finalFocus={returnFocus}>
        <DrawerHeader>
          <div className="flex items-center justify-between gap-2">
            <DrawerTitle>
              {adding ? 'Add variant' : `Edit ${modeLabel(initial)}`}
            </DrawerTitle>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Close variant editor"
              onClick={dismiss}
            >
              <X />
            </Button>
          </div>
          <DrawerDescription>
            Apply changes to the builder draft, then save the configuration to
            persist them.
          </DrawerDescription>
        </DrawerHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (error || unconfigured || !modeLabel(mode).trim()) return;
            try {
              parseMapping(text);
            } catch (err) {
              setError((err as Error).message);
              return;
            }
            if (mode.prompt_prefix?.includes('\0')) {
              setError('Prompt prefix cannot contain a null character.');
              return;
            }
            apply({
              ...mode,
              name: modeLabel(mode).trim(),
              enabled:
                configuredMode(mode) || mode.id === 'default'
                  ? mode.enabled
                  : false,
            });
          }}
        >
          <FieldGroup className="variant-drawer-fields min-h-0 flex-1 gap-4 overflow-y-auto overscroll-contain p-5">
            <Field label="Variant name">
              <Input
                ref={nameRef}
                required
                maxLength={80}
                value={mode.name ?? (adding ? '' : modeLabel(mode))}
                onChange={(e) => setMode({ ...mode, name: e.target.value })}
              />
            </Field>
            <Field label="Configure using" hint={descriptions[control]}>
              <ToggleGroup
                variant="outline"
                className="flex-wrap"
                aria-label="Configure using"
                value={[control]}
                onValueChange={(values) => {
                  if (!values.length || invalidText) return;
                  const next = values[0] as Control;
                  write(changeControl(mode.body, control, next, mode.id));
                  setControl(next);
                }}
              >
                {(
                  [
                    ['effort', 'Effort'],
                    ['budget', 'Token budget'],
                    ['thinking', 'Thinking toggle'],
                    ['custom', 'Custom'],
                  ] as const
                ).map(([id, label]) => (
                  <ToggleGroupItem key={id} value={id} disabled={invalidText}>
                    {label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </Field>
            {control === 'effort' && (
              <>
                <Field label="Effort value">
                  <Input
                    required
                    disabled={invalidText}
                    maxLength={128}
                    value={String(
                      (templateEffort
                        ? kwargs.reasoning_effort
                        : mode.body.reasoning_effort) ?? '',
                    )}
                    onChange={(e) =>
                      write(
                        templateEffort
                          ? {
                              ...mode.body,
                              chat_template_kwargs: {
                                ...kwargs,
                                reasoning_effort: e.target.value,
                              },
                            }
                          : { ...mode.body, reasoning_effort: e.target.value },
                      )
                    }
                  />
                </Field>
                <Field
                  label="Send through"
                  hint={
                    templateEffort
                      ? 'Sets chat_template_kwargs.reasoning_effort.'
                      : 'Sets reasoning_effort in the request body.'
                  }
                >
                  <NativeSelect
                    disabled={invalidText}
                    value={templateEffort ? 'template' : 'request'}
                    onChange={(e) => {
                      const body = { ...mode.body };
                      const args = { ...kwargs };
                      const effort = templateEffort
                        ? kwargs.reasoning_effort
                        : body.reasoning_effort;
                      delete body.reasoning_effort;
                      delete args.reasoning_effort;
                      if (e.target.value === 'template')
                        args.reasoning_effort = effort;
                      else body.reasoning_effort = effort;
                      if (Object.keys(args).length)
                        body.chat_template_kwargs = args;
                      else delete body.chat_template_kwargs;
                      write(body);
                    }}
                  >
                    <NativeSelectOption value="request">
                      Request field
                    </NativeSelectOption>
                    <NativeSelectOption value="template">
                      Chat template
                    </NativeSelectOption>
                  </NativeSelect>
                </Field>
              </>
            )}
            {control === 'budget' && (
              <>
                <Field
                  label="Token budget"
                  hint="-1 means unlimited only when supported by the runtime."
                >
                  <NumberControl
                    disabled={invalidText}
                    label="Token budget"
                    min={-1}
                    max={1048576}
                    sliderMax={32768}
                    required
                    value={mode.body[budgetKey] as number | undefined}
                    change={(value) =>
                      write({ ...mode.body, [budgetKey]: value ?? 0 })
                    }
                  />
                </Field>
                <Field
                  label="Request field"
                  hint={`Sends ${budgetKey} in the request body. Check your runtime’s documentation for support.`}
                >
                  <NativeSelect
                    disabled={invalidText}
                    value={budgetKey}
                    onChange={(e) => {
                      const body = { ...mode.body };
                      const budget = body[budgetKey];
                      delete body[budgetKey];
                      write({ ...body, [e.target.value]: budget });
                    }}
                  >
                    <NativeSelectOption value="reasoning_budget">
                      reasoning_budget
                    </NativeSelectOption>
                    <NativeSelectOption value="thinking_budget">
                      thinking_budget
                    </NativeSelectOption>
                  </NativeSelect>
                </Field>
              </>
            )}
            {control === 'thinking' && (
              <Field label="Thinking">
                <NativeSelect
                  disabled={invalidText}
                  value={String(kwargs.enable_thinking)}
                  onChange={(e) =>
                    write({
                      ...mode.body,
                      chat_template_kwargs: {
                        ...kwargs,
                        enable_thinking: e.target.value === 'true',
                      },
                    })
                  }
                >
                  <NativeSelectOption value="true">On</NativeSelectOption>
                  <NativeSelectOption value="false">Off</NativeSelectOption>
                </NativeSelect>
              </Field>
            )}
            <details open={!!initial.prompt_prefix || undefined}>
              <summary>Prompt prefix</summary>
              <Field
                label="Prefix text"
                hint="Prepended to the latest user message. Works with any control, or on its own."
              >
                <Textarea
                  rows={3}
                  maxLength={4096}
                  placeholder="No prompt changes"
                  value={mode.prompt_prefix || ''}
                  onChange={(e) => {
                    setMode({ ...mode, prompt_prefix: e.target.value });
                    if (!invalidText) setError('');
                  }}
                />
              </Field>
            </details>
            <details open={control === 'custom' || !!error || undefined}>
              <summary>Request JSON</summary>
              <Field
                label="Request overrides"
                hint="The complete reasoning override object. Guided controls and JSON edit the same settings, not separate layers."
              >
                <Textarea
                  rows={8}
                  spellCheck={false}
                  value={text}
                  aria-invalid={!!error}
                  aria-describedby={error ? errorId : undefined}
                  onChange={(e) => {
                    setText(e.target.value);
                    try {
                      const body = parseMapping(e.target.value);
                      setMode({ ...mode, body });
                      setControl(controlFor(body));
                      setError('');
                      setInvalidText(false);
                    } catch (err) {
                      setInvalidText(true);
                      setError(
                        err instanceof SyntaxError
                          ? 'Enter a valid JSON object.'
                          : (err as Error).message,
                      );
                    }
                  }}
                />
              </Field>
            </details>
            {(error || unconfigured) && (
              <p role="alert" id={errorId} className="error-text">
                {error || 'Add request settings or a prompt prefix.'}
              </p>
            )}
          </FieldGroup>
          <DrawerFooter>
            <Button type="button" variant="outline" onClick={dismiss}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                !!error ||
                unconfigured ||
                !(mode.name ?? (adding ? '' : modeLabel(mode))).trim()
              }
            >
              Apply changes
            </Button>
          </DrawerFooter>
        </form>
        {navigationGuard}
        <AlertDialog open={discard} onOpenChange={setDiscard}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Discard variant changes?</AlertDialogTitle>
              <AlertDialogDescription>
                Changes in this editor have not been applied to the builder.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep editing</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={close}>
                Discard changes
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DrawerContent>
    </Drawer>
  );
}
