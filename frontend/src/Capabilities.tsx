import { FieldSet, FieldLegend } from '@/components/ui/field';
import type { ReactNode } from 'react';
import { AudioLines, Brain, Image, Type, Video, Wrench } from 'lucide-react';
import { NumberControl } from './NumberControl';
import { Field } from './ui';
import type {
  DiscoveredCapabilities,
  ModelCapabilities,
  ModelCatalog,
  Runtime,
  TemplateSelection,
} from './types';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { reasoningLabel } from './capabilityOptions';
import { ReasoningModes } from './ReasoningModes';
import './capabilities.css';

export function OutputLimit({
  catalog,
  change,
}: {
  catalog: ModelCatalog;
  change: (catalog: ModelCatalog) => void;
}) {
  const model = catalog.model || {};
  return (
    <Field label="Max output tokens">
      <NumberControl
        label="Max output tokens"
        min={1}
        max={1048576}
        sliderMax={32768}
        value={model.limit?.output}
        defaultValue={1024}
        change={(value) => {
          const limit = { ...model.limit };
          if (value !== undefined) limit.output = value;
          else delete limit.output;
          change({ ...catalog, model: { ...model, limit } });
        }}
      />
    </Field>
  );
}

export function Capabilities({
  catalog,
  change,
  hints,
  runtime,
  valid,
  reasoningControls,
  showOutputLimit = true,
  artifactId,
  templateOverride,
}: {
  catalog: ModelCatalog;
  change: (catalog: ModelCatalog) => void;
  hints?: DiscoveredCapabilities;
  runtime?: Partial<Runtime>;
  valid: (key: string, ok: boolean) => void;
  reasoningControls?: ReactNode;
  showOutputLimit?: boolean;
  artifactId?: string;
  templateOverride?: TemplateSelection | null;
}) {
  const model = catalog.model || {};
  const caps = {
    tools: false,
    input: ['text'],
    output: ['text'],
    ...model.capabilities,
  };
  const reasoning =
    caps.reasoning === true ||
    (typeof caps.reasoning === 'object' && !!caps.reasoning.supported);
  const update = (value: Partial<ModelCapabilities>) =>
    change({
      ...catalog,
      model: { ...model, capabilities: { ...caps, ...value } },
    });
  const modalities = [
    { id: 'text', label: 'Text', icon: Type },
    { id: 'image', label: 'Images', icon: Image },
    { id: 'audio', label: 'Audio', icon: AudioLines },
    { id: 'video', label: 'Video', icon: Video },
  ];
  return (
    <section
      className="capabilities-panel"
      aria-label="Capabilities and reasoning"
    >
      {(['input', 'output'] as const).map((direction) => (
        <FieldSet key={direction} className="output-capabilities">
          <FieldLegend>
            {direction === 'input' ? 'Input modalities' : 'Output modalities'}
          </FieldLegend>
          <ToggleGroup
            multiple
            variant="primary"
            className="flex-wrap"
            aria-label={
              direction === 'input' ? 'Input modalities' : 'Output modalities'
            }
            value={caps[direction]}
            onValueChange={(next) => {
              if (!next.length) return;
              valid(`${direction}-formats`, true);
              update({
                [direction]: [
                  ...new Set([
                    ...caps[direction].filter(
                      (id) => !modalities.some((m) => m.id === id),
                    ),
                    ...next,
                  ]),
                ],
              });
            }}
          >
            {modalities.map(({ id, label, icon: Icon }) => (
              <ToggleGroupItem
                key={id}
                value={id}
                disabled={
                  caps[direction].length === 1 && caps[direction].includes(id)
                }
              >
                <Icon />
                {direction === 'input' ? label : reasoningLabel(id)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </FieldSet>
      ))}
      <div className="capability-heading reasoning-heading">
        <h3>Capabilities</h3>
      </div>
      <ToggleGroup
        multiple
        variant="primary"
        className="flex-wrap"
        aria-label="Capabilities"
        value={[
          ...(caps.tools ? ['tools'] : []),
          ...(reasoning ? ['reasoning'] : []),
        ]}
        onValueChange={(next) => {
          if (!next.includes('reasoning')) valid('reasoning-options', true);
          update({
            tools: next.includes('tools'),
            reasoning: {
              ...(typeof caps.reasoning === 'object' ? caps.reasoning : {}),
              supported: next.includes('reasoning'),
            },
          });
        }}
      >
        <ToggleGroupItem value="tools">
          <Wrench />
          Tools
        </ToggleGroupItem>
        <ToggleGroupItem value="reasoning">
          <Brain />
          Reasoning
        </ToggleGroupItem>
      </ToggleGroup>
      {showOutputLimit && <OutputLimit catalog={catalog} change={change} />}
      {reasoning && (
        <ReasoningModes
          catalog={catalog}
          change={change}
          hints={hints}
          runtime={runtime}
          valid={valid}
          reasoningControls={reasoningControls}
          artifactId={artifactId}
          templateOverride={templateOverride}
        />
      )}
    </section>
  );
}
