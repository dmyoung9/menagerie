import { useState } from 'react';
import { EngineCatalog } from './EngineCatalog';
import { VariantDialog } from './VariantDialog';
import { TestPrompt } from './TestPrompt';
import { gib, type api as request } from './ui';
import type { Registry, HostSnapshot } from './types';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card';

export function FirstRun({
  data,
  host,
  api,
  queued,
  create,
}: {
  data: Registry;
  host: HostSnapshot;
  api: typeof request;
  queued: () => void;
  create: (id?: string) => void;
}) {
  const [choose, setChoose] = useState(false);
  const models = data.models || [],
    deployments = data.deployments || [];
  const stale =
    host.stale ??
    (typeof host.ts === 'number' && Date.now() / 1000 - host.ts > 15);
  const telemetry = stale
    ? 'Telemetry is stale; refresh before relying on these numbers'
    : typeof host.ts !== 'number'
      ? 'Telemetry timestamp unavailable'
      : 'Observed telemetry';
  return (
    <details className="mb-5" open={!deployments.length}>
      <summary>Get your first response</summary>
      <Card className="mt-3 min-w-0">
        <CardHeader>
          <CardTitle>First-response checklist</CardTitle>
          <CardDescription>
            No client setup required. Follow these steps, or use a model you
            already have.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p>
            {telemetry}.{' '}
            {host.gpus?.length
              ? host.gpus
                  .map((g) => `${g.name}: ${gib(g.free_mib)} GiB free`)
                  .join(' · ')
              : 'GPU telemetry unavailable. A CPU engine is an option; this does not prove that no GPU is present.'}{' '}
            · RAM available: {gib(host.ram_available_mib)} GiB. Memory estimates
            are advisory, not a launch guarantee.
          </p>
          <h3>1. Install an engine</h3>
          <p>
            For the GGUF starter below, choose llama.cpp. CPU works without GPU
            drivers but is slower; CUDA requires a supported NVIDIA driver.
            Choose a backend whose listed requirements match this host.
          </p>
          {data.runtimes?.some(
            (r) =>
              r.engine === 'llama.cpp' &&
              r.capabilities?.formats?.includes('gguf'),
          ) ? (
            <p>
              llama.cpp engine installed. You can manage versions in{' '}
              <a href="#/settings/engines">Settings → Engines</a>.
            </p>
          ) : (
            <EngineCatalog
              runtimes={data.runtimes || []}
              recommended="llama.cpp"
            />
          )}
          <h3>2. Get a small chat model</h3>
          <p>
            Qwen2.5-0.5B-Instruct GGUF is a modest starter for testing the
            workflow, not a recommendation for demanding tasks. Choose Q4_K_M
            (roughly 0.5 GB); allow at least 1 GiB disk space plus engine
            storage, and additional RAM for context and runtime overhead.
          </p>
          <p>
            <a
              href="https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF"
              target="_blank"
              rel="noreferrer"
            >
              Files and source
            </a>{' '}
            ·{' '}
            <a
              href="https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct/blob/main/LICENSE"
              target="_blank"
              rel="noreferrer"
            >
              Publisher license
            </a>
            . Check the live variant size before downloading.
          </p>
          <Button variant="outline" onClick={() => setChoose(true)}>
            Choose starter variant
          </Button>{' '}
          <a href="#/models">Use an existing model / Add from File</a>
          <p>
            Downloads and engine installs run in{' '}
            <a href="#/activity/operations">Activity → Operations</a>, with
            progress, cancellation, and errors. If interrupted, return here to
            queue a new attempt; completed files are retained.
          </p>
          <h3>3. Create and load a deployment</h3>
          <p>
            Choose the installed GGUF and llama.cpp engine, save, then review
            and load the deployment. Wait for Ready; queued is not success. Use
            deployment logs if loading fails.
          </p>
          {models.map((m) => (
            <Button
              className="h-auto whitespace-normal break-all"
              variant="outline"
              key={m.id}
              onClick={() => create(m.id)}
            >
              Create deployment for {m.name}
            </Button>
          ))}
          {!!deployments.length && (
            <a href="#/deployments">Open deployments to review and load</a>
          )}
          <h3>4. Send a test prompt</h3>
          <TestPrompt deployments={deployments} />
          {choose && (
            <VariantDialog
              source="hf"
              name="Qwen/Qwen2.5-0.5B-Instruct-GGUF"
              api={api}
              close={() => setChoose(false)}
              queued={queued}
              openModel={() => {}}
            />
          )}
        </CardContent>
      </Card>
    </details>
  );
}
