import { useEffect, useState } from 'react';
import { readApi, message } from '../ui';
import {
  resourcePreview,
  resourcePreviewDraft,
  resourcePreviewRequest,
} from '../contracts';
import { array } from '../decode';
import type {
  ProfileDraft,
  ResourcePreview,
  ResourcePreviewDraft,
} from '../types';

export function useResourcePreview(
  members: ResourcePreviewDraft[],
  sampleTs?: number,
) {
  const configurationKeys = [
    'name',
    'artifact_id',
    'runtime_id',
    'config',
    'raw_args',
    'catalog',
  ] as const satisfies readonly (keyof ProfileDraft)[];
  const payload = JSON.stringify(
    members.map((member) => {
      const configuration = member.configuration;
      return {
        name: member.name || 'Draft model',
        gpu: member.gpu ?? 0,
        reservation_mib: member.reservation_mib || 0,
        configuration: configuration
          ? Object.fromEntries(
              configurationKeys
                .filter((key) => configuration[key] !== undefined)
                .map((key) => [key, configuration[key]]),
            )
          : undefined,
      };
    }),
  );
  const [result, setResult] = useState<{
    key: string;
    data?: ResourcePreview;
    error?: string;
  }>({ key: '' });
  useEffect(() => {
    let alive = true;
    const parsed = array(resourcePreviewDraft)(JSON.parse(payload) as unknown);
    if (
      !parsed.length ||
      parsed.some(
        (member) =>
          !member.configuration?.artifact_id ||
          !member.configuration?.runtime_id,
      )
    )
      return;
    const timer = setTimeout(() => {
      void readApi(
        '/api/resources/preview',
        resourcePreview,
        resourcePreviewRequest({ members: parsed }),
      )
        .then((data) => {
          if (alive) setResult({ key: payload, data });
        })
        .catch((error) => {
          if (alive) setResult({ key: payload, error: message(error) });
        });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [payload, sampleTs]);
  return {
    data: result.key === payload ? result.data : undefined,
    error: result.key === payload ? result.error : undefined,
  };
}
