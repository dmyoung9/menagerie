import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { FieldSet, FieldLegend } from '@/components/ui/field';
import { useEffect, useMemo, useState } from 'react';
import { Dialog } from '@/components/workspace';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { ArrowUpRight, Download, Check, LoaderCircle } from 'lucide-react';
import {
  byteSize,
  candidates,
  choose,
  dimensions,
  hfVariants,
  optionsFor,
  QUANTS,
  reconcile,
  SUFFIXES,
  type Dimension,
  type Selection,
  type Variant,
} from './variants';

import type { CatalogFiles, CatalogRevision, CatalogModel } from './types';
import type { api as request } from './ui';
import { readApi } from './ui';
import { array } from './decode';
import { catalogFiles, catalogRevision, catalogModel } from './contracts';
type Props = {
  source: 'hf';
  name: string;
  api: typeof request;
  close: () => void;
  queued: () => void;
  openModel: (name: string) => void;
};
const labels: Record<Dimension, string> = {
  format: 'Format',
  parameters: 'Parameter size',
  quant: 'Quantization',
  suffix: 'Size / quality suffix',
};

export function VariantDialog({
  source,
  name,
  api,
  close,
  queued,
  openModel,
}: Props) {
  const [data, setData] = useState<CatalogFiles | null>(null),
    [refs, setRefs] = useState<CatalogRevision[]>([]),
    [revision, setRevision] = useState('main');
  const [selection, setSelection] = useState<Selection>({}),
    [exact, setExact] = useState(''),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [submitting, setSubmitting] = useState(false),
    [related, setRelated] = useState<CatalogModel[] | null>(null),
    [relatedBusy, setRelatedBusy] = useState(false);
  const [projector, setProjector] = useState('');
  const variants = useMemo(() => (data ? hfVariants(data.files) : []), [data]);
  const matches = candidates(variants, selection);
  const selected: Variant | undefined =
    matches.length === 1 ? matches[0] : matches.find((v) => v.id === exact);
  const ready =
    !!selected &&
    dimensions.every((d) => !!selection[d]) &&
    selected.complete &&
    selected.bytes !== null;
  const supplier = 'Hugging Face';
  const url = `https://huggingface.co/${name}`;
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    setData(null);
    setSelection({});
    setExact('');
    setProjector('');
    (async () => {
      try {
        const next = await readApi(
          `/api/catalog/hf/files?repo=${encodeURIComponent(name)}&revision=${encodeURIComponent(revision)}`,
          catalogFiles,
          undefined,
          api,
        );
        if (!active) return;
        setData(next);
        setSelection(reconcile(hfVariants(next.files)));
      } catch (e) {
        if (active) setError(String(e));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [source, name, revision, api]);
  useEffect(() => {
    let active = true;
    if (source === 'hf')
      readApi(
        '/api/catalog/hf/revisions?repo=' + encodeURIComponent(name),
        array(catalogRevision),
        undefined,
        api,
      )
        .then((r) => {
          if (active) setRefs(r);
        })
        .catch(() => {
          if (active)
            setNotice('Branch list unavailable; using the selected revision.');
        });
    return () => {
      active = false;
    };
  }, [source, name, api]);
  async function download() {
    if (!ready || !selected || !data) return;
    setSubmitting(true);
    setError('');
    try {
      await api('/api/downloads', {
        repo: name,
        revision: data.revision,
        filename: selected.id,
        ...(selected.format === 'GGUF' && projector ? { projector } : {}),
      });
      queued();
      close();
    } catch (e) {
      setError(String(e));
      setSubmitting(false);
    }
  }
  return (
    <Dialog
      title="Choose a variant"
      close={close}
      busy={submitting}
      wide
      guardChanges={false}
    >
      <div className="mb-5 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <Badge variant="secondary">{supplier}</Badge>
          <p className="mt-2 break-words">{name}</p>
        </div>
        <Button
          nativeButton={false}
          variant="ghost"
          size="icon"
          render={
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              aria-label={`Open ${name} on ${supplier}`}
            />
          }
        >
          <ArrowUpRight />
        </Button>
      </div>
      <div className="variant-body" aria-busy={loading}>
        {source === 'hf' && (
          <label className="variant-revision">
            Revision
            <NativeSelect
              disabled={loading || submitting}
              value={revision}
              onChange={(e) => {
                setRelated(null);
                setRevision(e.target.value);
              }}
            >
              {!refs.some((r) => r.name === 'main') && (
                <NativeSelectOption value="main">main</NativeSelectOption>
              )}
              {refs.map((r) => (
                <NativeSelectOption key={r.kind + ':' + r.name} value={r.name}>
                  {r.name} · {r.kind}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
        )}
        {error && (
          <Alert variant="destructive" className="mb-5" role="alert">
            <AlertDescription className="flex flex-wrap items-center justify-between gap-3 whitespace-pre-line">
              {error}
            </AlertDescription>
          </Alert>
        )}
        {notice && <p>{notice}</p>}
        {loading ? (
          <div className="variant-loading" role="status">
            <LoaderCircle size={24} />
            Loading available variants…
          </div>
        ) : (
          data && (
            <>
              {variants.length === 0 && (
                <p>
                  No primary downloadable weights were found in this repository.
                  Try a linked quantization below.
                </p>
              )}
              {data.capabilities && (
                <details>
                  <summary>Detected capabilities & dependencies</summary>
                  <p>
                    {[
                      ...data.capabilities.input,
                      ...(data.capabilities.tools ? ['tools'] : []),
                      ...(data.capabilities.reasoning ? ['reasoning'] : []),
                    ].join(' · ')}
                  </p>
                  <p>
                    {data.capabilities.evidence.join('; ') ||
                      'No conclusive structured metadata.'}
                  </p>
                  <p>{data.capabilities.note}</p>
                  {data.capabilities.warnings?.map((w: string) => (
                    <p key={w}>{w}</p>
                  ))}
                </details>
              )}
              {dimensions.map((d, index) => {
                if (
                  d === 'format' &&
                  new Set(variants.map((v) => v.format)).size < 2
                )
                  return null;
                if (
                  d === 'parameters' &&
                  new Set(variants.map((v) => v.parameters)).size < 2
                )
                  return null;
                const locked = dimensions
                  .slice(0, index)
                  .some((parent) => !selection[parent]);
                const available = optionsFor(variants, selection, d);
                const common =
                  d === 'quant' ? QUANTS : d === 'suffix' ? SUFFIXES : [];
                const values = [
                  ...new Set([...common, ...variants.map((v) => v[d])]),
                ];
                if (!variants.length) return null;
                return (
                  <FieldSet className="variant-field" key={d}>
                    <FieldLegend>{labels[d]}</FieldLegend>
                    <ToggleGroup
                      variant="outline"
                      className="flex-wrap"
                      aria-label={labels[d]}
                      value={selection[d] ? [selection[d]!] : []}
                      onValueChange={(next) => {
                        if (next.length) {
                          setSelection(choose(variants, selection, d, next[0]));
                          setExact('');
                        }
                      }}
                    >
                      {values.map((value) => (
                        <ToggleGroupItem
                          key={value}
                          value={value}
                          disabled={
                            locked || !available.has(value) || submitting
                          }
                          title={
                            locked
                              ? 'Choose the preceding option first'
                              : !available.has(value)
                                ? 'Not available for this model and selection'
                                : value
                          }
                        >
                          {selection[d] === value && <Check />}{' '}
                          {value === 'None' ? 'No suffix' : value}
                        </ToggleGroupItem>
                      ))}
                    </ToggleGroup>
                  </FieldSet>
                );
              })}
              {matches.length > 1 &&
                dimensions.every((d) => !!selection[d]) && (
                  <label>
                    Exact variant
                    <NativeSelect
                      value={exact}
                      disabled={submitting}
                      onChange={(e) => setExact(e.target.value)}
                    >
                      <NativeSelectOption value="">
                        Choose the supplier variant…
                      </NativeSelectOption>
                      {matches.map((v) => (
                        <NativeSelectOption key={v.id} value={v.id}>
                          {v.label}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                    <small>
                      These files/tags share the same chip choices. Choose the
                      exact supplier variant.
                    </small>
                  </label>
                )}
              {source === 'hf' &&
                selected?.format === 'GGUF' &&
                !!data.capabilities?.dependencies?.length && (
                  <label>
                    Optional multimodal projector
                    <NativeSelect
                      value={projector}
                      disabled={submitting}
                      onChange={(e) => setProjector(e.target.value)}
                    >
                      <NativeSelectOption value="">
                        Do not download a projector
                      </NativeSelectOption>
                      {data.capabilities.dependencies.map((d) => (
                        <NativeSelectOption key={d.name} value={d.name}>
                          {d.name} · {byteSize(d.size)}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                    <small>
                      Candidates only: confirm compatibility with these weights.
                      The selected file is checked against its upstream checksum
                      when available and must be enabled in deployment settings.
                    </small>
                  </label>
                )}
              <div className="variant-summary" aria-live="polite">
                <span className="eyebrow">YOUR SELECTION</span>
                {selected ? (
                  <>
                    <h3>{selected.label}</h3>
                    <div className="catalog-chips">
                      <Badge
                        variant="secondary"
                        className="max-w-full whitespace-normal break-words"
                      >
                        {selected.format}
                      </Badge>
                      <Badge
                        variant="secondary"
                        className="max-w-full whitespace-normal break-words"
                      >
                        {selected.quant}
                      </Badge>
                      {selected.suffix !== 'None' && (
                        <Badge
                          variant="secondary"
                          className="max-w-full whitespace-normal break-words"
                        >
                          {selected.suffix}
                        </Badge>
                      )}
                      {selected.parameters !== 'Unspecified' && (
                        <Badge
                          variant="secondary"
                          className="max-w-full whitespace-normal break-words"
                        >
                          {selected.parameters}
                        </Badge>
                      )}
                      {selected.bytes !== null && (
                        <Badge
                          variant="secondary"
                          className="max-w-full whitespace-normal break-words"
                        >
                          {byteSize(selected.bytes)}
                        </Badge>
                      )}
                      {selected.note && (
                        <Badge
                          variant="secondary"
                          className="max-w-full whitespace-normal break-words"
                        >
                          {selected.note}
                        </Badge>
                      )}
                    </div>
                    {!selected.complete && (
                      <p className="error-text">
                        The supplier listing is missing shards. This variant
                        cannot be downloaded.
                      </p>
                    )}
                    {source === 'hf' && selected.bytes === null && (
                      <p>
                        Download is unavailable until the supplier reports file
                        sizes.
                      </p>
                    )}
                    {source === 'hf' && (
                      <>
                        <p className="variant-commit">
                          Pinned commit: {data.revision}
                        </p>
                        <details>
                          <summary>
                            {selected.files.length} file
                            {selected.files.length === 1 ? '' : 's'} included
                          </summary>
                          <ul>
                            {selected.files.map((f) => (
                              <li key={f.name}>
                                <code>{f.name}</code>
                                <span>{byteSize(f.size)}</span>
                              </li>
                            ))}
                          </ul>
                        </details>
                      </>
                    )}
                  </>
                ) : (
                  <p>
                    Choose{' '}
                    {dimensions
                      .filter((d) => !selection[d])
                      .map((d) => labels[d].toLowerCase())
                      .join(' and ') || 'an exact variant'}{' '}
                    to complete your selection.
                  </p>
                )}
              </div>
              {source === 'hf' && (
                <details className="variant-related">
                  <summary>Other quantized repositories</summary>
                  <p>
                    Some suppliers publish quantizations in separate
                    repositories.
                  </p>
                  <Button
                    variant="outline"
                    type="button"
                    disabled={relatedBusy || submitting}
                    onClick={async () => {
                      setRelatedBusy(true);
                      try {
                        setRelated(
                          await readApi(
                            '/api/catalog/hf/quantizations?repo=' +
                              encodeURIComponent(name),
                            array(catalogModel),
                            undefined,
                            api,
                          ),
                        );
                      } catch (e) {
                        setError(String(e));
                      } finally {
                        setRelatedBusy(false);
                      }
                    }}
                  >
                    {relatedBusy ? 'Loading…' : 'Find related quantizations'}
                  </Button>
                  {related?.length === 0 && (
                    <p>No linked quantizations declared upstream.</p>
                  )}
                  {related?.map((r) => (
                    <Button
                      variant="outline"
                      type="button"
                      className="variant-related-item"
                      key={r.id}
                      disabled={submitting}
                      onClick={() => openModel(r.id)}
                    >
                      {r.id}
                    </Button>
                  ))}
                </details>
              )}
            </>
          )
        )}
      </div>
      <div className="dialog-actions">
        <span className="mr-auto text-muted-foreground">
          {selected ? byteSize(selected.bytes) : 'Choose your variant'}
        </span>
        <Button
          variant="outline"
          type="button"
          disabled={submitting}
          onClick={close}
        >
          Cancel
        </Button>
        <Button
          variant="default"
          type="button"
          disabled={loading || submitting || !ready}
          onClick={download}
        >
          <Download />
          {submitting ? 'Queuing…' : 'Download'}
        </Button>
      </div>
    </Dialog>
  );
}
