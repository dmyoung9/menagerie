import { FieldSet, FieldLegend } from '@/components/ui/field';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { Field } from './ui';
import { RuntimeSettings } from './FormControls';
import {
  companionOptions,
  hasEmbeddedMtp,
  selectMtp,
} from './companion-options';
import type { Artifact, ProfileDraft, RuntimeField } from './types';

export function ModelCompanions({
  model,
  models,
  value,
  schema,
  change,
}: {
  model?: Artifact;
  models: Artifact[];
  value: ProfileDraft;
  schema: Record<string, RuntimeField>;
  change: (value: ProfileDraft) => void;
}) {
  const { projectors, heads } = companionOptions(model, models);
  const config = value.config;
  const projector = typeof config.mmproj === 'string' ? config.mmproj : '';
  const path = String(
    config['spec-draft-model'] || config['model-draft'] || '',
  );
  const type = config['spec-type'];
  const head =
    type === 'none'
      ? ''
      : path || (type === 'draft-mtp' ? 'embedded' : type ? 'configured' : '');
  const embedded = hasEmbeddedMtp(model);
  const draftKey = schema['spec-draft-model']
    ? 'spec-draft-model'
    : 'model-draft';
  return (
    <>
      {schema.mmproj && (
        <FieldSet className="model-settings-group">
          <FieldLegend>Multimodal</FieldLegend>
          <Field label="Projector">
            <NativeSelect
              value={projector}
              onChange={(e) => {
                const next = { ...config };
                if (e.target.value) next.mmproj = e.target.value;
                else delete next.mmproj;
                change({ ...value, config: next });
              }}
            >
              <NativeSelectOption value="">None</NativeSelectOption>
              {projector && !projectors.some((p) => p.path === projector) && (
                <NativeSelectOption value={projector}>
                  Configured projector (not in matching inventory)
                </NativeSelectOption>
              )}
              {projectors.map((p) => (
                <NativeSelectOption key={p.path} value={p.path}>
                  {p.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
        </FieldSet>
      )}
      {schema['spec-type'] && (
        <FieldSet className="model-settings-group">
          <FieldLegend>MTP</FieldLegend>
          <Field label="MTP head">
            <NativeSelect
              value={head}
              onChange={(e) =>
                change({
                  ...value,
                  config: selectMtp(config, e.target.value, draftKey),
                })
              }
            >
              <NativeSelectOption value="">None</NativeSelectOption>
              {embedded && (
                <NativeSelectOption value="embedded">
                  Embedded
                </NativeSelectOption>
              )}
              {head === 'embedded' && !embedded && (
                <NativeSelectOption value="embedded" disabled>
                  Configured embedded head (metadata unavailable)
                </NativeSelectOption>
              )}
              {head === 'configured' && (
                <NativeSelectOption value="configured" disabled>
                  Configured speculative decoding
                </NativeSelectOption>
              )}
              {path && !heads.some((h) => h.path === path) && (
                <NativeSelectOption value={path}>
                  Configured head (not in matching inventory)
                </NativeSelectOption>
              )}
              {(schema['spec-draft-model'] || schema['model-draft']) &&
                heads.map((h) => (
                  <NativeSelectOption key={h.path} value={h.path}>
                    {h.name}
                  </NativeSelectOption>
                ))}
            </NativeSelect>
          </Field>
          <details>
            <summary>Advanced MTP tuning</summary>
            <RuntimeSettings
              section="mtp"
              schema={schema}
              value={config}
              disabled={!head}
              change={(config) => change({ ...value, config })}
            />
          </details>
        </FieldSet>
      )}
    </>
  );
}
