import { Field } from '@/components/workspace';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import type { Artifact, TemplateSelection } from './types';
import {
  effectiveTemplate,
  templateKindLabel,
  templateSourceLabel,
} from './ui';

export interface ChatTemplateSettingsProps {
  /** The model the deployment serves (provides templates + model default). */
  model?: Artifact;
  /** Deployment-level override. `null`/`undefined` means inherit model default. */
  override: TemplateSelection | null | undefined;
  /** Callback fired when the user picks a new override (null = inherit). */
  onChange: (selection: TemplateSelection | null) => void;
  label?: string;
}

const INHERIT = 'inherit-model';

export function ChatTemplateSettings({
  model,
  override,
  onChange,
  label = 'Chat template',
}: ChatTemplateSettingsProps) {
  const templates = model?.templates || [];
  const modelDefault = model?.template_default;
  const effective = effectiveTemplate(override, modelDefault, templates);

  const inheritLabel =
    modelDefault && modelDefault.source !== 'automatic'
      ? `Inherit model default (${templateSourceLabel(modelDefault.source)})`
      : 'Inherit model default (engine default)';

  function pick(value: string) {
    if (value === INHERIT) {
      onChange(null);
      return;
    }
    const t = templates.find((x) => x.id === value);
    if (t) onChange({ source: t.kind, asset_id: t.id });
  }

  const effectiveDetail = effective.asset
    ? ` — ${effective.asset.name}${
        effective.asset.status === 'missing' || effective.asset.error
          ? ` (${effective.asset.error || 'not available'})`
          : ''
      }`
    : ' (engine default, no template file)';

  return (
    <Field
      label={label}
      hint="Deployment override, then model default, then engine default."
    >
      <NativeSelect
        value={
          override && override.source !== 'automatic'
            ? (override.asset_id ?? INHERIT)
            : INHERIT
        }
        onChange={(e) => pick(e.target.value)}
      >
        <NativeSelectOption value={INHERIT}>{inheritLabel}</NativeSelectOption>
        {templates.map((t) => (
          <NativeSelectOption key={t.id} value={t.id}>
            {templateKindLabel(t.kind)} · {t.name}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <p className="mb-4 text-xs text-muted-foreground">
        Effective: {templateSourceLabel(effective.source)}
        {effectiveDetail}
      </p>
    </Field>
  );
}
