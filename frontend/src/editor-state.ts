import type {
  EditorDraftMap,
  EditorKind,
  EditorDraft,
  EditableSource,
  EditableSourceMap,
} from './types';
import { recordValue } from './decode.ts';
import { deploymentDraft, runtimeDraft } from './contracts.ts';
import { defaultReasoningOptions } from './capabilityOptions.ts';

export const defaults: EditorDraftMap = {
  deployments: {
    identifier_mode: 'generated',
    runtime_assignment: 'dedicated',
    name: 'New deployment',
    artifact_id: '',
    runtime_id: '',
    config: {},
    raw_args: [],
    catalog: {
      model: { capabilities: { reasoning: false } },
      reasoning: { presets: defaultReasoningOptions() },
    },
    alias: 'local-model',
    port: 8120,
    residency: 'on-demand',
    priority: 50,
    idle_timeout: 300,
    allow_eviction: false,
    enabled: true,
    gpu: null,
    queue_timeout: 300,
  },
  runtimes: {
    name: 'Runtime',
    engine: 'llama.cpp',
    execution_kind: 'native',
    executable: '',
    env: {},
    command_template: [],
    trust: false,
  },
};

const allowed: Record<string, string[]> = {
  deployments: [
    'id',
    ...Object.keys(defaults.deployments),
    'template_override',
  ],
  runtimes: [
    'id',
    ...Object.keys(defaults.runtimes),
    'version',
    'commit',
    'fork_url',
    'formats',
  ],
};

export function editable<K extends EditorKind>(
  kind: K,
  row?: EditableSourceMap[K],
  clone?: boolean,
): EditorDraftMap[K];
export function editable(
  kind: EditorKind,
  row?: EditableSource,
  clone = false,
): EditorDraft {
  const source = row ? recordValue(row) : undefined;
  const selected = source
    ? Object.fromEntries(
        allowed[kind]
          .filter((key) => source[key] !== undefined)
          .map((key) => [key, source[key]]),
      )
    : {};
  const input = structuredClone({ ...defaults[kind], ...selected });
  if (clone) {
    delete input.id;
    input.name += ' (copy)';
  }
  if (kind === 'runtimes') return runtimeDraft(input);
  const value = deploymentDraft(input);
  if (clone) value.alias += '-copy';
  return value;
}
