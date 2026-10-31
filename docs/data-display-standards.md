# Menagerie Data Display and Visualization Standards

**Status:** Proposed v1.0  
**Scope:** React/Vite dashboard, deployment configuration, resource previews, live telemetry, model catalog, downloads, history, and evaluations.  
**Companion:** `docs/frontend-design-system.md`  
**Project foundation:** shadcn/ui Base UI, Mira preset `b2v6bT61lS`, Tailwind CSS v4, dark-mode default. Preserve existing semantic tokens, typography, accessibility, and UI ownership conventions.

## 1. Principles

1. Display *what* a measurement is (observed, reserved, estimated, proposed), not just a number.
2. Separate hardware utilization (activity) from memory consumption (capacity). A GPU at 100% compute load is not necessarily in trouble.
3. Use Treemaps for **composition**, capacity bars for **budget fit**, and time series for **behavior over time**. These are complementary, not interchangeable.
4. Never double-count or normalize away over-allocation. Always show the absolute capacity/demand fraction and the overage.
5. Never silently combine disjoint hardware pools, such as GPU 0 VRAM and GPU 1 VRAM, or VRAM and system RAM.
6. Explain uncertainty and stale data. Unknown is not zero. Predictions are not hardware measurements.
7. Preserve valid launch attempts after advisory information, subject to real engine restrictions and reviewed effects on other deployments.
8. Charts enhance but never replace accessible labels, exact values, and actionable feedback.

## 2. Canonical names and units

All raw memory values should be retained in exact bytes (or in the backend's documented MiB-native fields), and formatted only at the view boundary. Do not change backend field units by assumption.

| Metric | Primary display | Detail or note |
| --- | --- | --- |
| RAM/VRAM/disk/artifact size | MiB, GiB, TiB | IEC binary units; `1 GiB = 2^30 bytes`. Preserve original source's decimal GB labeling if quoting a manufacturer. |
| Download throughput | MiB/s | Clearly distinguish from network Mbps. |
| GPU/CPU busy time | `%` (integer) | Treat as activity, not memory capacity. |
| Memory share and progress | `%` (integer) | Show byte fraction beside it. Projected demand may exceed 100%. |
| Temperature | `72 °C` | Integer. Do not assume a generic throttling threshold. |
| Power | `185 W` | Integer; show power limit only if known. |
| Clock | MHz or GHz | Use a single scale within one comparison. |
| Parameter count | `335M`, `8B`, `70B` | Parameter count is not disk size or quantization. Unknown stays unknown. |
| Quantization | `Q4_K_M`, `Q8_0`, `FP16` | Label per artifact/variant, not guessed from size. |
| Context | `32,768 tokens` | Compact `32K` only in space-constrained UI; detailed number must be exact. |
| Inference speed | `42.6 output tokens/s` | Distinguish decode throughput from prompt/prefill throughput. |
| Latency | `248 ms`, `1.4 s` | Label TTFT, request duration, etc. |
| Duration | `4m 32s` | Use `MM:SS` when suitable, `1h 12m` for larger ETA; show `Estimating...` for insufficient samples. |
| Date/time | Local human-readable timestamp | Tooltip exposes full timestamp with timezone; history stores UTC/epoch. |

**Precision:** One decimal is the normal capacity-card display, two decimals for small model sizes or when distinction matters, integers for percentages and temperatures. Raw detail tooltips can show more. Never render a nonzero value as `0.0 GiB`: switch to MiB or `<0.1 GiB`. Use comparable precision on both sides of a fraction. Exact totals and percentages are computed *before* display rounding.

**Table formatting:** Right-align quantities, use tabular numerals, consistent units per column, and numeric sorting on raw values. Do not alphabetically sort formatted strings such as `900 MiB` and `1.2 GiB`. Show file size, parameters, quantization, and artifact type as distinct columns or compact metadata fields.

## 3. Canonical resource vocabulary

| Label | Definition |
| --- | --- |
| **Used** | Observed consumption reported by a source at a known timestamp. |
| **Free** | Unallocated memory reported by the device/OS. |
| **Reserved** | Capacity held by a workload or Menagerie policy. Reservation is not necessarily physical usage. |
| **Allocated** | Resources assigned by a configuration. Not synonymous with actively used. |
| **Estimated** | Computed from observed history and/or stated inputs, with basis and sample count. |
| **Proposed** | Additional or replacement demand from a pending edit/start. |
| **Available** | Capacity remaining under the *stated effective budget* after current and proposed demand. |
| **Headroom** | Capacity set aside for driver/runtime variation, host policy, or workload spikes. |
| **Over budget** | Positive excess demand above the selected effective budget. |
| **Peak** | Maximum measurement or estimate over a named time window or workload assumption. |

A device has **physical capacity** and may have a lower **usable budget** after reserved headroom. Both boundaries must be visible or clearly stated. The `gpu_headroom_mib` and `ram_headroom_mib` settings belong in this accounting. GPU telemetry may include driver-reserved memory, external processes, or unattributed use; show these as explicit categories only when there is evidence. Never label unattributed bytes as belonging to a model.

## 4. Three views of resources

**Live** uses timestamped host/device/process measurements. It shows used, free, load, temperature, power, and current process attribution. The source of the value is a tooltip/detail field. No data becomes `Unknown`/`Stale`, not zero.

**Allocated** shows the current running deployments, policy headroom, and what is free. On-demand workloads that are not guaranteed to coexist should appear as alternative configurations or admission scenarios, not all added as if resident simultaneously.

**Projected** uses configuration-driven estimates, memory placement, proposed deltas, and the current host sample as the baseline. Used primarily in the deployment editor and prelaunch review. Estimates have uncertainty, source/provenance, and a clearly named assumption (peak vs idle, configured context and parallel slots).

The UI may offer a Live / Allocated / Projected segmented selector. Never add values from these three modes to each other as if they were separate physical uses.

### 4.1 Memory components

Where the runtime estimator can substantiate the breakdown, use a hierarchy such as GPU > serving deployment > model > weights / KV cache / compute buffers / runtime overhead. For multi-model deployments, each model has a separate runtime-instance identity and its own memory requirements unless explicit shared-process behavior is verified. Offloaded weight or KV memory belongs in a *different* system-RAM view; it cannot appear as additional VRAM demand. No component should appear as an exact number if only the total is known: display an `Unattributed estimate` component instead.

### 4.2 Multiple GPUs

Show one VRAM budget per GPU, with its own capacity and placement. Never merge two 8 GiB GPUs into an undifferentiated 16 GiB block that implies a 16 GiB contiguous allocation is possible. A separate machine aggregate may sum utilization for overview reporting, but must explicitly state that it is an aggregate, not an allocatable pool.

## 5. Canonical capacity pair

**Recommended signature UI:** Treemap for shares + stacked horizontal capacity bar for exact fit, using the *same model* and *same budget basis*. Use the pair in deployment configuration, resource previews, and selected dashboard drill-downs. For single-value or two-category cases, a bar with a compact legend is preferable to a tiny Treemap.

### 5.1 Calculation

Given effective budget `B` and positive demand `D`, in the same resource units:

```ts
const available = Math.max(0, B - D);
const over = Math.max(0, D - B);
const withinBudget = Math.min(B, D);
const treemapTotal = Math.max(B, D);
```

`D` must include whatever existing and proposed consumption is relevant to the particular scenario; it must not include already-running instances twice. Treat the backend's resource preview as the authority on demand and budget fit, including headroom and sample age. Do not re-derive the status from the UI's partial data.

### 5.2 Treemap rules

**Under budget:** Show demand components and one `Available` leaf, totaling `B`.  
**Over budget:** Show the *first `B` units of demand* in a `Within budget` group, and the remaining `D-B` units in an `Over budget` group, totaling `D`. Split a component into in-budget and overflow portions only as required. Do not add `Over` on top of full unsplit demand; that double-counts.  
**Ordering:** To partition components, use a stable ordering, preferably by serving unit and configured sequence/priority. Describe the split as an accounting visualization, not as an assertion that this specific model would fail to load.  
**Area:** A leaf area represents a nonnegative quantity. The *whole* Treemap has scale `max(B, D)`. The visual therefore rescales when demand exceeds the budget; the adjacent capacity bar and text preserve physical reference.  
**Hierarchy:** Keep grouping deterministic and allow model and component drill-down. A leaf that is too small for a label remains accessible through legend/tooltips/table. Custom SVG nodes must preserve adequate contrast, text cutoff, hover/focus labels, and accessibility.  
**Color:** Categorical colors identify models/components; semantic amber/red is reserved for warning/overflow. The `Available` tile is neutral and subdued. Avoid turning all highly used resources red.

Example: A 16 GiB effective budget with weights A=7 GiB, weights B=6 GiB, and KV=4 GiB yields 16 GiB within budget and 1 GiB overflow. `KV (in budget)` is 3 GiB; `KV (over)` is 1 GiB. Total Treemap area equals 17 GiB of demand, not 18 GiB.

### 5.3 Stacked capacity bar rules

Use a horizontal stacked `BarChart` for current/existing, proposed, reserved/headroom, and overflow contributions where useful. Show a physical/effective capacity limit as a `ReferenceLine`, label, or a custom capacity marker on a quantitative axis. Never use `stackOffset="expand"` when comparing absolute capacity, because it rescales everything to 100%. Allow overage beyond the 100% limit rather than truncating the bar. Preserve an absolute axis in GiB and a textual `17.0 / 16.0 GiB` fraction, `+1.0 GiB over` status.

Avoid double-counting `Over` as a fifth bar segment alongside unsplit demand. Instead, split the last claims into their within-budget and overflow pieces, use an overlay on the overflowing interval, or show an independent overage annotation. Mark `headroom` and the true device boundary separately when they differ.

### 5.4 Confidence and feedback

Use the estimate's basis (observed, derived, unavailable) and sample count in a tooltip or an accompanying status. Distinguish observed values from derived values. When demand exceeds the budget, show a simple label such as `6.4 GiB over budget`. A label is not a block and not a prediction of failure. Display the exact reason: e.g. `6.4 GiB over budget`, `Telemetry was last updated 18s ago`, or `Other processes currently use 1.2 GiB`.

## 6. Chart catalog

| Screen / question | Canonical variant | Notes |
| --- | --- | --- |
| Deployment allocation: What takes VRAM? | `Treemap` (hierarchical; custom content) | Show model/weights/KV/overhead and Available or Over. Use with a capacity bar. |
| Deployment allocation: Will it fit? | `BarChart` horizontal stacked + `ReferenceLine` | Exact demand vs usable and physical limits; overage visible. |
| Live GPU busy %, CPU busy % | `LineChart` | Percentage axis fixed 0-100; GPU saturation not an error color. |
| Live GPU VRAM/RAM consumption over time | `AreaChart` (single used amount), optionally `ComposedChart` for allocated vs observed | Avoid stacking used + reserved when reserved is already part of used. Plot a capacity reference. |
| Historical peak and variation | `ComposedChart` or `AreaChart` with min/max band plus mean/median line | Keep aggregated min/max/p95 accessible in tooltip. Do not imply a continuous high-resolution sample where history is bucketed. |
| GPU temperature / power / clock over time | `LineChart` per independent unit; `ReferenceLine` for known limit | Do not plot C, W and MHz on a single unlabeled axis. |
| Download progress | Progress bar (shadcn), not Recharts | Show bytes done/total, rate, ETA, and state as text. |
| Download speed over time | Small `AreaChart` or `LineChart` | Optional detail; show instantaneous and smoothed trend as distinct metrics. |
| Disk composition by installed models | `Treemap` or horizontal `BarChart` | Show installed artifact bytes and free space when appropriate; never sum deduplicated shared weights per deployment. |
| Inference tokens/s, TTFT, requests/s, queue over time | `LineChart`, occasionally `ComposedChart` | Separate different units; don't mix latency and throughput on one axis by default. |
| Compare engines/models across benchmarks | `BarChart` horizontal for categories, `ScatterChart` for paired trade-offs | Use p50/p95 for distributions when sample count is meaningful. |
| Model counts / status breakdown | Metric cards or table; optional `BarChart` | Avoid pies/donuts for tiny categories where labels matter more. |
| Deployment status / errors / health | Status cards, activity feed, table | Not all data needs a chart. |
| GPU usage distribution across intervals | Optional box plot in history/analysis | Not recommended as the primary operational view. Recharts' example box-plot implementation is not the default Menagerie chart. |

### 6.1 Time-series defaults

Use a 5-15 minute live view by default, with 1 hour, 24 hours, and 7 days available when retention allows. Sample at the already-configured `sample_seconds`; do not hardcode a new poll interval. Downsample/aggregate on the backend for long ranges and preserve min, max, average, and sample count per bucket when possible. History baseline is per-run peak; within-run time series and aggregation are added later.

Time series should use restrained grids, minimal point markers, hover crosshairs, and reduced-motion support. Do not smooth away true spikes or draw misleading curves between sparse samples. For very busy scenes, keep the existing `MemoryChart` lightweight SVG unless Recharts yields a demonstrated accessibility or comparison benefit.

## 7. Semantic chart colors and interactions

Preserve Menagerie's exact shadcn theme tokens, including its emerald theme and amber chart palette. Do not reinvent a parallel hardcoded palette or use raw `red`, `green`, and `yellow` classes everywhere. Define shared presentation tokens and map them to the current theme:

- Categorical model/deployment components: stable palette assignment keyed to stable entity ID, with a legend when needed.
- Available: neutral/muted surface.
- Headroom/reserve: subdued neutral or hatched, visually distinct from Free and Available.
- Proposed: dashed outline or distinctive categorical shade, without implying danger.
- Warning: semantic warning/amber.
- Over budget and runtime failure: semantic destructive/red, with text and icon/shape reinforcement.
- Unknown/stale: muted appearance plus an explicit label, not a failure color.

Hover/focus tooltips should show name, exact amount, proportion, source type, and whether a value is observed or estimated. A single model selection should highlight its region in the Treemap, bar, and corresponding detail row. Touch/keyboard users need equivalent access to the details. When the dataset is dense, provide a text/table fallback. Avoid legend-only color recognition and respect reduced-motion settings.

## 8. Standard component boundaries

`frontend/src/components/ui/chart.tsx`: generated/owned shadcn chart primitives via the **Base UI** registry. Do not swap to Radix or use third-party wrapper packages in place of the official registry. The Base UI chart docs currently use Recharts v3; pin a tested compatible `recharts` version and account for release-specific API changes. The existing repo does *not* yet have `recharts` in `frontend/package.json`.

Recommended product components:

```text
components/charts/
  capacity-summary.tsx       # exact numerical header and current budget status
  capacity-bar.tsx           # shared physical/usable-limit visualization
  allocation-treemap.tsx     # hierarchical budget breakdown
  telemetry-series.tsx       # standardized line/area display
  chart-tooltip.tsx          # timestamp/units/provenance formatting
  chart-empty-state.tsx      # no data, missing device, stale source
lib/formatters.ts           # size, duration, rate, percent, temperature, tokens
lib/capacity-accounting.ts  # pure transforms; no React state
```

These are proposed placements, not a claim that the files already exist. Use the existing `frontend/src/ui.ts` helpers or migrate them deliberately; avoid concurrent conflicting size formatters. Keep data calculations in pure functions with tests, Recharts for appropriate visuals, and shadcn primitives for tooltip/legend/card composition. Do not re-implement Recharts' built-in rendering infrastructure where it already solves the problem.

### 8.1 Current backend alignment

The current frontend type contract in `frontend/src/types/index.ts` already exposes `GpuSnapshot` (VRAM total/used/free, utilization, temperature, power, clock); `HostSnapshot` (CPU/RAM/swap/disk/processes/deployment metrics); `HostSettings` (headroom, temperature limit, sample interval, history retention); `ResourceEstimate` (`peak_mib`, optional `idle_mib`, `components`, `confidence`, `provenance`); and `ResourcePreviewGpu` (`total_mib`, `used_mib`, `reserve_mib`, `draft_mib`, `remaining_mib`, `reservation_error`, `verdict`). `confidence`, `verdict`, and `reserve_mib` are transitional and will be replaced by basis, sample count, accounting status, and observed demand.

Create a view model adapter with explicitly documented source and unit conversions. Reuse the backend preview's verdict and rounding-free values. Ensure all new visual states support partial or null telemetry and optional estimator components. New estimator fields must be optional or schema-versioned for older installations.

## 9. Verification and acceptance

- Test `D=0`, `D=B`, `D<B`, `D>B`, null data, stale data, negative/invalid inputs, and values smaller than 0.1 display unit.
- Treemap area must total `max(B, D)` for valid nonnegative inputs, with no double-counted overflow.
- Stacked capacity bar must show the same sums and an accurate budget boundary, including more than 100% demand.
- Check 2 GPU devices with different physical capacities and cross-device placement; there must be no fictitious pooled VRAM.
- Check that shared model weights on disk are counted once, but separate loaded processes are accounted for independently if not truly shared.
- Change context, concurrency, engine, offload, and member selection; both charts must update consistently without losing unsaved editor state.
- Validate the same accounting status shown by the backend preview, with clear notes for derived estimates and external process use.
- Verify no-data, disconnected hardware, CPU-only, stale, and partial sensor availability states.
- Test keyboard, screen reader labels, touch interactions, contrast, 320px responsive widths, dark mode, and reduced motion.
- Retain launch-review safeguards and distinguish advisory information from actual runtime failure.
- Run the repository's documented check, lint, formatting, build, test, and Playwright UI workflows on fixture-only data.

## 10. Implementation order

1. Establish pure metric formatters and names; standardize all table and dashboard readouts.
2. Create a single unit-safe projected capacity view model, with backend verdict alignment and golden accounting tests.
3. Implement the capacity bar; it is the authoritative fit-to-budget visualization.
4. Add the hierarchical allocation Treemap and coordinated selection/tooltip interactions, with tested under/at/over-budget states.
5. Integrate the pair into deployment configuration and launch review, preserving editor state and permissions.
6. Add Recharts time-series components selectively where existing SVGs no longer meet product needs; retain `MemoryChart` until a specific gap is demonstrated.
7. Add per-model performance benchmarking visuals and richer historical aggregation as telemetry support matures.

## References

- Menagerie: `README.md`, `docs/frontend-design-system.md`, `docs/forms.md`, `docs/multi-model-deployments.md`, `frontend/src/types/index.ts` on `dmyoung9/menagerie`.
- shadcn/ui official Base UI charts: <https://ui.shadcn.com/docs/components/base/chart>
- Recharts Treemap: <https://recharts.github.io/api/Treemap/>
- Recharts BarChart: <https://recharts.github.io/en-US/api/BarChart/>
- Recharts ReferenceLine: <https://recharts.github.io/api/ReferenceLine/>
- NVIDIA NVML memory semantics: <https://docs.nvidia.com/deploy/nvml-api/latest/api/structnvmlMemory__t.html>