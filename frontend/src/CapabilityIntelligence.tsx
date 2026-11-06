import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import type { CapabilityPreview, JsonObject } from './types';

const labels: Record<string, string> = {
  reasoning: 'Reasoning',
  reasoning_control: 'Reasoning control',
  reasoning_mechanism: 'Reasoning mechanism',
  reasoning_output: 'Reasoning output',
  reasoning_budget: 'Reasoning budget',
  client_compatibility: 'Client compatibility',
  tools: 'Tools',
  input_image: 'Image input',
  input_audio: 'Audio input',
  input_video: 'Video input',
  output_image: 'Image output',
  output_audio: 'Audio output',
  output_video: 'Video output',
};

export function CapabilityIntelligence({
  preview,
}: {
  preview?: CapabilityPreview;
}) {
  return (
    <section aria-label="Detected capabilities" className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        {['reasoning', 'input_image', 'input_audio', 'input_video'].map(
          (key) => {
            const finding = preview?.effective[key];
            return (
              <Badge key={key} variant="secondary">
                {labels[key]}:{' '}
                {finding?.conflicting
                  ? 'conflicting evidence'
                  : finding?.status || 'unknown'}
              </Badge>
            );
          },
        )}
      </div>
      <p className="text-muted-foreground text-sm">
        Detection is evidence, not inference certification. Unknown features
        remain manually configurable through templates, variants and Advanced
        declarations.
      </p>
      {preview?.warnings.map((warning) => (
        <Alert key={warning}>
          <AlertDescription>{warning}</AlertDescription>
        </Alert>
      ))}
      <details>
        <summary>Capability evidence</summary>
        {!preview && (
          <p>
            Capability preview unavailable. Manual configuration remains
            available.
          </p>
        )}
        {Object.entries(preview?.effective || {}).map(([key, finding]) => (
          <div key={key} className="my-3 flex flex-col gap-1">
            <strong>{labels[key] || key}</strong>
            <span>
              Model: {preview?.model[key]?.status || 'unknown'} · Deployment:{' '}
              {finding.status}
              {finding.conflicting ? ' · conflicting evidence' : ''}
            </span>
            {finding.value !== undefined && (
              <code>{JSON.stringify(finding.value)}</code>
            )}
            <ul>
              {finding.evidence.map((item, index) => (
                <li key={index}>
                  {item.source} · {item.confidence}: {item.detail}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </details>
    </section>
  );
}

export function SamplingRecommendations({
  preview,
  apply,
}: {
  preview?: CapabilityPreview;
  apply: (values: JsonObject) => void;
}) {
  const recommendations = preview?.recommendations || [];
  const compatible = recommendations.filter(
    (entry) => entry.compatible === true,
  );
  return (
    <details>
      <summary>Published sampling recommendations</summary>
      {!recommendations.length && (
        <p>
          No published recommendations detected. Engine defaults remain
          unchanged.
        </p>
      )}
      <ul>
        {recommendations.map((entry) => (
          <li key={entry.parameter}>
            <code>
              {entry.parameter} = {entry.value}
            </code>{' '}
            · {entry.detail} ·{' '}
            {entry.compatible
              ? 'compatible with installed schema'
              : 'not supported by installed schema'}
          </li>
        ))}
      </ul>
      {!!compatible.length && (
        <Button
          type="button"
          variant="outline"
          onClick={() =>
            apply(
              Object.fromEntries(
                compatible.map((entry) => [entry.parameter, entry.value]),
              ),
            )
          }
        >
          Apply compatible recommendations
        </Button>
      )}
      <p className="text-muted-foreground text-sm">
        Optional advice, not runtime defaults. Review before applying; Save is
        still required.
      </p>
    </details>
  );
}
