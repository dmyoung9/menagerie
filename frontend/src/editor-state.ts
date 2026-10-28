import type {
  EditorDraftMap,
  EditorKind,
  EditorDraft,
  EditableSource,
  EditableSourceMap,
} from './types';
import { recordValue } from './decode.ts';
import { profileDraft, deploymentDraft, runtimeDraft } from './contracts.ts';

export const defaults: EditorDraftMap = {
  profiles: {
    name: 'New profile',
    artifact_id: '',
    runtime_id: '',
    config: {
      'ctx-size': 8192,
      parallel: 1,
      'gpu-layers': 'all',
      'cache-type-k': 'q8_0',
      'cache-type-v': 'q8_0',
      'flash-attn': 'on',
    },
    raw_args: [],
    catalog: {},
  },
  deployments: {
    name: 'New deployment',
    profile_id: '',
    alias: 'local-model',
    port: 8120,
    residency: 'on-demand',
    priority: 50,
    idle_timeout: 300,
    reservation_mib: 0,
    allow_eviction: false,
    allow_uncertain: false,
    enabled: true,
    gpu: 0,
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
  profiles: [
    'id',
    'name',
    'artifact_id',
    'runtime_id',
    'config',
    'raw_args',
    'catalog',
  ],
  deployments: ['id', ...Object.keys(defaults.deployments)],
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
  if (kind === 'profiles') {
    const value = profileDraft(input);
    if (clone)
      value.catalog.catalog_id =
        (value.catalog.catalog_id || 'model') +
        '-copy-' +
        Date.now().toString(36);
    return value;
  }
  if (kind === 'runtimes') return runtimeDraft(input);
  const value = deploymentDraft(input);
  if (source?.profile_snapshot) {
    const snapshot = recordValue(source.profile_snapshot);
    const configuration = profileDraft(
      Object.fromEntries(
        allowed.profiles
          .filter((key) => snapshot[key] !== undefined)
          .map((key) => [key, snapshot[key]]),
      ),
    );
    delete configuration.id;
    value.configuration = configuration;
    delete value.profile_id;
  }
  if (clone) value.alias += '-copy';
  return value;
}
