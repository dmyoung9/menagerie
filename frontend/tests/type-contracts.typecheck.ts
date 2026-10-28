/** Compile-only regression checks: these deliberately invalid calls must stay errors. */
import type {
  EditAction,
  Runtime,
  Deployment,
  EditorState,
  RuntimeDraft,
  ServingDeployment,
} from '../src/types';

function checkContracts(
  edit: EditAction,
  runtime: Runtime,
  deployment: Deployment,
  draft: RuntimeDraft,
  serving: ServingDeployment,
  transport: typeof import('../src/ui').api,
) {
  edit('runtimes', runtime);
  edit('deployments', deployment);
  // @ts-expect-error The raw transport cannot assert an unchecked result type.
  void transport<Runtime>('/api/registry/runtimes');
  // @ts-expect-error A runtime is not a deployment editor source.
  edit('deployments', runtime);
  // @ts-expect-error A profile editor cannot receive a runtime draft.
  const invalid: EditorState = { kind: 'profiles', value: draft };
  void invalid;
  if (serving.multi_model) {
    // @ts-expect-error A serving group has no single model profile snapshot.
    void serving.profile_snapshot;
  } else {
    serving.alias.toUpperCase();
  }
}
void checkContracts;
