import type { Page } from '@playwright/test';
import { test as base, expect } from './network';
import type {
  Deployment,
  DeploymentSet,
  ServingDeployment,
  Profile,
  Registry,
  HostSnapshot,
  GpuSnapshot,
} from '../../src/types';
import * as contracts from '../../src/contracts';

export type Fixture = {
  registry: Required<
    Pick<Registry, 'models' | 'runtimes' | 'profiles' | 'deployments' | 'jobs'>
  >;
  host: HostSnapshot & { ts: number; gpus: GpuSnapshot[] };
  writes: { path: string; body: unknown }[];
  sets: DeploymentSet[];
  unexpected: string[];
  errors: string[];
  failSave: boolean;
  holdSave: boolean;
  releaseSave: () => void;
  conflictSave: boolean;
  jobCounter: number;
};

export async function openAdvanced(page: Page) {
  const summary = page
    .locator('[data-settings-section="memory"] summary')
    .filter({ visible: true });
  await expect(summary).toBeVisible();
  if (
    !(await summary
      .locator('..')
      .evaluate((element) => (element as HTMLDetailsElement).open))
  )
    await summary.click();
}

export async function openIdentity(page: Page) {
  const summary = page.locator('[data-settings-section="identity"] summary');
  await expect(summary).toBeVisible();
  if (
    !(await summary
      .locator('..')
      .evaluate((element) => (element as HTMLDetailsElement).open))
  )
    await summary.click();
}

export async function openCard(page: Page, name: string) {
  const summary = page
    .locator(
      `[data-settings-section="${name}"] > [data-slot="card"] > details > summary, [data-settings-section="${name}"] [data-card-advanced] > summary`,
    )
    .filter({ visible: true });
  await expect(summary).toBeVisible();
  if (
    !(await summary
      .locator('..')
      .evaluate((element) => (element as HTMLDetailsElement).open))
  )
    await summary.click();
}

export const test = base.extend<{ fixture: Fixture }>({
  fixture: [
    async ({ page }, use) => {
      const profile: Profile = {
        id: 'fixture-profile',
        revision: 1,
        name: 'Example settings',
        artifact_id: 'model',
        runtime_id: 'engine',
        config: { 'ctx-size': 8192, parallel: 1, 'gpu-layers': 'all' },
        raw_args: [],
        catalog: {},
      };
      const deployment = (
        id: string,
        state: string,
        enabled = true,
      ): Deployment => ({
        id,
        name: `Example ${id}`,
        alias: id,
        revision: 1,
        state,
        enabled,
        residency: 'on-demand',
        priority: 50,
        idle_timeout: 300,
        queue_timeout: 300,
        gpu: 0,
        port: id === 'ready' ? 8120 : 8121,
        allow_eviction: false,
        profile_snapshot: profile,
        lifecycle: { serving: enabled },
      });
      const fixture: Fixture = {
        registry: {
          models: [
            {
              id: 'model',
              revision: 1,
              name: 'Example 27B with a deliberately long model name for responsive verification',
              format: 'gguf',
              size_bytes: 8 * 1024 ** 3,
              architecture: 'example',
              source: 'local',
              local_path: '/models/example.gguf',
              discovered_capabilities: {
                tools: true,
                input: ['text', 'image'],
                reasoning: { supported: true },
              },
            },
          ],
          runtimes: [
            {
              id: 'engine',
              revision: 1,
              name: 'Example engine',
              engine: 'llama.cpp',
              execution_kind: 'native',
              capabilities: {
                formats: ['gguf'],
                schema: {
                  'ctx-size': {
                    type: 'integer',
                    min: 512,
                    max: 131072,
                    default: 8192,
                  },
                  parallel: { type: 'integer', min: 1, max: 8, default: 1 },
                  threads: {
                    type: 'integer',
                    min: 1,
                    max: 128,
                    default: 8,
                    engine_default: 8,
                  },
                  'gpu-layers': { type: 'string', default: 'all' },
                },
              },
            },
          ],
          profiles: [],
          deployments: [
            deployment('ready', 'READY'),
            deployment('idle', 'STOPPED'),
            deployment('inactive', 'STOPPED', false),
          ],
          jobs: [],
        },
        host: {
          ts: Date.now() / 1000,
          cpu_count: 8,
          cpu_percent: 12,
          gpus: [
            {
              index: 0,
              name: 'Fixture GPU',
              used_mib: 4096,
              free_mib: 12288,
              total_mib: 16384,
              utilization: 18,
            },
          ],
          ram_total_mib: 32768,
          ram_available_mib: 24000,
          deployments: { ready: { gpu_mib: 3072 } },
          processes: [],
        },
        writes: [],
        sets: [],
        unexpected: [],
        errors: [],
        failSave: false,
        holdSave: false,
        releaseSave: () => {},
        conflictSave: false,
        jobCounter: 0,
      };
      page.on('pageerror', (error) => fixture.errors.push(String(error)));
      const serving = (): ServingDeployment[] => {
        const owned = new Set(
          fixture.sets.flatMap((group) => group.member_ids),
        );
        return [
          ...fixture.sets.map((group) => ({
            ...group,
            members: fixture.registry.deployments.filter((member) =>
              group.member_ids.includes(member.id),
            ),
          })),
          ...fixture.registry.deployments
            .filter((member) => !owned.has(member.id))
            .map((member) => ({
              ...member,
              multi_model: false as const,
              member_ids: [member.id],
              members: [member],
            })),
        ];
      };
      page.on('console', (message) => {
        if (
          message.type() === 'error' &&
          !message.text().startsWith('Failed to load resource:')
        )
          fixture.errors.push(message.text());
      });
      await page.route('**/api/**', async (route) => {
        const request = route.request(),
          url = new URL(request.url()),
          path = url.pathname;
        const body: unknown =
          request.method() === 'POST' ? request.postDataJSON() : null;
        const send = (value: unknown, status = 200) =>
          route.fulfill({
            status,
            contentType: 'application/json',
            body: JSON.stringify(value),
          });
        if (body) {
          expect(request.headers()['x-menagerie-token']).toBe('fixture-token');
          fixture.writes.push({ path: path + url.search, body });
        }
        const b = body as { repo?: string; filename?: string };
        if (path === '/api/status')
          return send({
            csrf_token: 'fixture-token',
            version: '2.0.0',
            queue: 0,
            gateway: '/v1',
            gateway_url: 'http://127.0.0.1:8001/v1',
            state_path: '/fixtures',
            host: fixture.host,
            settings: {
              gpu_headroom_mib: 2048,
              ram_headroom_mib: 4096,
              temperature_limit: 85,
              sample_seconds: 2,
              retention_days: 7,
              summary_days: 90,
              history_quota_mib: 512,
              max_queue: 32,
              expose_on_demand: true,
            },
            deployments: fixture.registry.deployments,
            serving_deployments: serving(),
          });
        if (path.startsWith('/api/registry/'))
          return send(
            Object.entries(fixture.registry).find(
              ([key]) => key === path.split('/').at(-1),
            )?.[1] || [],
          );
        if (path === '/api/integration/opencode')
          return send({ endpoint: 'http://127.0.0.1:8001/v1' });
        if (path === '/api/events/stream')
          return route.fulfill({
            contentType: 'text/event-stream',
            body: `event: operation\ndata: ${JSON.stringify({ seq: 1, ts: fixture.host.ts, kind: 'state', deployment_id: 'idle', data: { to: 'STOPPED', reason: 'Idle unload' } })}\n\nevent: telemetry\ndata: ${JSON.stringify(fixture.host)}\n\n`,
          });
        if (path === '/api/history/metrics')
          return send([
            { ...fixture.host, ts: fixture.host.ts - 60 },
            fixture.host,
          ]);
        if (path.endsWith('/performance')) return send([]);
        if (path === '/api/settings' && body) return send(body);
        if (path === '/api/history/sessions')
          return send([
            {
              id: 'session',
              started_at: fixture.host.ts,
              deployment_snapshot: fixture.registry.deployments[0],
              outcome: 'Complete',
              peak_gpu_mib: 3072,
            },
          ]);
        if (path.startsWith('/api/history/')) return send([]);
        if (path.endsWith('/engine-recommendation'))
          return send({ engine: 'llama.cpp', reason: 'GGUF engine' });
        if (path === '/api/engines/releases') return send({ engines: [] });
        if (path.startsWith('/api/runtimes/') && path.endsWith('/capabilities'))
          return send(
            fixture.registry.runtimes.find((r) => r.id === path.split('/')[3])
              ?.capabilities || {},
          );
        if (path.endsWith('/logs'))
          return send({ text: 'Runtime ready\nNo requests in flight' });
        if (path === '/api/capabilities/preview')
          return send({
            model: { reasoning: { status: 'unknown', evidence: [] } },
            effective: { reasoning: { status: 'unknown', evidence: [] } },
            warnings: [],
            recommendations: [],
          });
        if (path === '/api/resources/preview') {
          const input = contracts.resourcePreviewRequest(body);
          const members = input.members.map((m, i: number) => {
            return {
              key: String(i),
              name: m.name,
              gpu: m.gpu,
              estimate: {
                peak_mib: 4096,
                ram_mib: 0,
                file_size_bytes: 2048 * 1048576,
                kv_mib: 2048,
                profile_hash: 'fixture-config',
                components: {
                  Weights: 2048,
                  'KV cache': 2048,
                },
                basis: 'derived',
                sample_count: 0,
                provenance: 'Fixture estimate',
              },
              recommendation: {
                context_key: 'ctx-size',
                context_recommended_max: 32768,
                context_default: 8192,
                gpu_layers_max: 32,
                reason: 'Estimated with peers and desktop reserve',
              },
            };
          });
          return send({
            members,
            gpus: [
              {
                ...fixture.host.gpus[0],
                headroom_mib: 2048,
                draft_mib: 4096 * members.length,
                remaining_mib: 10240 - 4096 * members.length,
                status: members.length > 2 ? 'over_budget' : 'within_budget',
              },
            ],
            sample_ts: fixture.host.ts,
            ram_available_mib: 24000,
            ram_headroom_mib: 4096,
            ram_draft_mib: 0,
            ram_remaining_mib: 19904,
            note: 'Preview only; launch rechecks capacity.',
          });
        }
        if (path === '/api/deployments' || path === '/api/deployment-sets') {
          if (fixture.holdSave)
            await new Promise<void>((resolve) => {
              fixture.releaseSave = resolve;
            });
          if (fixture.failSave)
            return send({ error: 'Alias already exists' }, 409);
          const input =
            path === '/api/deployment-sets'
              ? contracts.deploymentSetDraft(body)
              : contracts.deploymentDraft(body);
          const id = input.id || 'created';
          if (fixture.conflictSave) {
            // A concurrent change committed behind the user: bump the revision
            // and move a field the client did not. The client reviews the fresh
            // value and re-saves; it never overwrites the user's edits.
            if (path === '/api/deployment-sets') {
              const idx = fixture.sets.findIndex((group) => group.id === id);
              if (idx >= 0) {
                const set = fixture.sets[idx];
                fixture.sets[idx] = {
                  ...set,
                  revision: set.revision + 1,
                  idle_timeout: 600,
                };
                fixture.registry.deployments = fixture.registry.deployments.map(
                  (d) =>
                    set.member_ids.includes(d.id)
                      ? { ...d, revision: d.revision + 1 }
                      : d,
                );
              }
            } else {
              const idx = fixture.registry.deployments.findIndex(
                (d) => d.id === id,
              );
              if (idx >= 0) {
                const d = fixture.registry.deployments[idx];
                fixture.registry.deployments[idx] = {
                  ...d,
                  revision: d.revision + 1,
                  idle_timeout: 600,
                };
              }
            }
            fixture.conflictSave = false;
            return send(
              { error: 'Revision changed; refresh before saving' },
              400,
            );
          }
          const member = (
            draft: import('../../src/types').DeploymentDraft,
            memberId: string,
          ): Deployment => {
            const { configuration, ...fields } = draft;
            return {
              ...deployment(memberId, 'STOPPED'),
              ...fields,
              id: memberId,
              profile_snapshot: configuration
                ? {
                    ...configuration,
                    revision: 1,
                    id: configuration.id || `profile-${memberId}`,
                  }
                : profile,
            };
          };
          if ('members' in input) {
            const members = input.members.map((draft, i) => ({
              ...member(draft, `${id}-${i}`),
              unit_id: id,
            }));
            const saved: DeploymentSet = {
              ...input,
              id,
              revision: 1,
              state: 'STOPPED',
              multi_model: true,
              members,
              member_ids: members.map((m) => m.id),
              lifecycle: { serving: input.enabled },
            };
            fixture.sets = [
              ...fixture.sets.filter((group) => group.id !== id),
              saved,
            ];
            fixture.registry.deployments = [
              ...fixture.registry.deployments.filter((d) => d.unit_id !== id),
              ...members,
            ];
            return send(saved);
          }
          const saved = member(input, id);
          saved.revision =
            (fixture.registry.deployments.find((d) => d.id === id)?.revision ||
              0) + 1;
          fixture.registry.deployments = [
            ...fixture.registry.deployments.filter((d) => d.id !== id),
            saved,
          ];
          return send(saved);
        }
        if (path.endsWith('/validate'))
          return send({
            errors: [],
            warnings: ['1.0 GiB over budget'],
            estimates: {
              idle: {
                peak_mib: 6800,
                ram_mib: null,
                basis: 'observed',
                sample_count: 2,
                file_size_bytes: 8 * 1024 ** 3,
                kv_mib: null,
                profile_hash: 'fixture-config',
                provenance: 'Observed fixture peaks',
              },
            },
            stops: [],
            plan_token: 'review-token',
          });
        if (path.endsWith('/start')) {
          fixture.registry.jobs.push({
            id: `job-${++fixture.jobCounter}`,
            revision: 1,
            name: 'Start deployment',
            state: 'QUEUED',
            deployment_id: path.split('/').at(-2),
            created_at: fixture.host.ts,
          });
          return send({ state: 'QUEUED' });
        }
        if (/\/(stop|enabled)$/.test(path)) return send({ state: 'QUEUED' });
        if (path === '/api/downloads') {
          fixture.registry.jobs.push({
            id: `job-${++fixture.jobCounter}`,
            revision: 1,
            name: `Download ${b.repo} · ${b.filename}`,
            state: 'QUEUED',
            operation: 'download',
            repo: b.repo,
            filename: b.filename,
            created_at: fixture.host.ts,
          });
          return send({ state: 'QUEUED' });
        }
        if (path === '/api/models/local') {
          fixture.registry.jobs.push({
            id: `job-${++fixture.jobCounter}`,
            revision: 1,
            name: 'Add local model',
            state: 'QUEUED',
            operation: 'local-model',
            created_at: fixture.host.ts,
          });
          return send({ state: 'QUEUED' });
        }
        if (path === '/api/backup')
          return send({ path: '/fixtures/backup.sqlite' });
        if (path === '/api/settings') return send(body);
        if (path === '/api/catalog/hf')
          return send([
            {
              id: 'fixture/model',
              downloads: 100,
              gated: null,
              tags: ['gguf'],
            },
          ]);
        if (path === '/api/catalog/hf/revisions')
          return send([{ name: 'main', kind: 'branch' }]);
        if (path === '/api/catalog/hf/files')
          return send({
            revision: 'fixture-commit',
            files: [
              { name: 'model-7B-Q4_K_M.gguf', size: 4 * 1024 ** 3 },
              { name: 'model-7B-Q8_0.gguf', size: 8 * 1024 ** 3 },
            ],
          });
        fixture.unexpected.push(`${request.method()} ${path}`);
        return send({ error: 'Unmocked route: ' + path }, 500);
      });
      await use(fixture);
      expect(
        fixture.unexpected,
        'Every API request must be intercepted explicitly',
      ).toEqual([]);
      expect(fixture.errors, 'No React/browser errors').toEqual([]);
    },
    { auto: true },
  ],
});
export { expect };

export async function navigate(page: Page, name: string) {
  const link = page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name, exact: true });
  if (!(await link.isVisible()))
    await page.getByRole('button', { name: 'Toggle Sidebar' }).click();
  await link.click();
  // Wait for the Sheet's exit animation before testing the revealed page.
  await expect(page.locator('[data-mobile="true"]')).toBeHidden();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
}
