# Frontend design system

Contributor reference for components, styling, and accessibility. For daily use,
start with the [user guide](../README.md).

For canonical measurement units, capacity accounting, and chart selection, see [Data Display and Visualization Standards](data-display-standards.md). This specification complements the component and accessibility rules in this guide.

Menagerie uses **Tailwind CSS v4** (`@tailwindcss/vite`) and the **Base UI**
variant of shadcn/ui. UI changes must preserve routing, polling, streaming,
launch-review consent, and domain calculations.

## Reproduce the foundation

The canonical preset is
[`b2v6bT61lS`](https://ui.shadcn.com/create?preset=b2v6bT61lS): Mira,
taupe base, emerald theme, amber charts, Public Sans body, Outfit headings,
small radius, subtle translucent menus, Lucide icons. Both font families are
self-hosted in the built dashboard; no font CDN request is needed.

`frontend/components.json` explicitly selects Base UI with `style: "base-mira"`
and the matching official registry. The CLI reports the derived `base` as
`"base"`. `frontend/preset.json` captures its exact resolved preset (no
fallbacks), and `frontend/src/theme.css` contains the CLI's
unaltered light/dark tokens and Tailwind mappings. The dashboard opens in dark
mode; there is no theme-switching workflow.

From `frontend/`:

```sh
npm ci
npx shadcn info --json
npx shadcn preset resolve --json
npx shadcn preset decode b2v6bT61lS
```

The initial setup was `npx shadcn init --base base --preset b2v6bT61lS --yes`.
To regenerate an existing installation, use `npx shadcn apply b2v6bT61lS` on a
clean branch and review the diff: it can replace component customizations.
Do not approximate the palette manually or switch the base registry to Radix.

## Owned components and local policy

Generated components are **owned source**, not a centrally upgraded UI package:

- `frontend/src/components/ui/`: shadcn source from the matching Base registry.
- `frontend/src/lib/utils.ts`: shared `cn` utility.
- `frontend/src/components/workspace.tsx`: product compositions (guarded dialogs,
  labeled fields, semantic statuses, copying, menus, empty states, route selectors).
- `frontend/src/hooks/use-confirmation.tsx`: asynchronous AlertDialog confirmation
  for engine changes and removal, with no native `window.confirm` dependency.
- `frontend/src/ui.ts`: API/token handling, formatters, domain mapping, and
  compatibility exports; `frontend/src/Json.tsx` owns structured data editing.
- `frontend/src/editor-state.ts`, `frontend/src/navigation.ts`, and
  `frontend/src/hooks/use-resource-preview.ts`: non-component state, navigation,
  and preview helpers, separate from React refresh boundaries.
- `frontend/src/types/`: distinct stored records, editor drafts, serving groups,
  modal states, telemetry, capabilities, history, and resource contracts.
- `frontend/src/contracts.ts` and `frontend/src/decode.ts`: checked wire and JSON
  boundaries. `api` returns `unknown`; `readApi` requires a decoder. Decoders
  retain extension properties while checking the fields consumed by the UI.
- `.agents/skills/`: project-local upstream shadcn and Radix-to-Base skills;
  `skills-lock.json` records their installation source.

Use the project-local CLI, not a global installation:

```sh
cd frontend
npx shadcn docs button dialog select
npx shadcn add @shadcn/component-name
# Inspect upstream changes without discarding local edits:
npx shadcn add @shadcn/button --dry-run
npx shadcn add @shadcn/button --diff button.tsx
```

Use Base UI's `render` composition API, not Radix `asChild`. A Button rendered
as an anchor also needs `nativeButton={false}`. Menu items belong inside their
group and use DropdownMenuItem, not nested Buttons. Select items belong inside
SelectGroup. Dialogs always have a title. Portals own positioning, collision
handling, modal focus, scroll locking, and dismissal.

Local source customizations: NativeSelect wrappers fill their field; Slider
forwards accessible names/value text to thumbs; Sonner receives its theme from
the caller without a Next.js theme dependency; CardTitle retains native heading
semantics; FieldSet allows shrinking below native fieldset min-content width so
long model names do not force mobile editors wider than their viewport.
RSC-only `use client` directives
are removed from owned source in this Vite SPA. Retain these when updating.
NativeSelect is deliberately used for large model/engine option lists and
native required-form validation; Base Select is used for the small residency
policy list. Route selectors use ToggleGroup, not incomplete ARIA tabs without
panels. They preserve browser Back and existing hash URLs.

Use semantic tokens and built-in component variants. There are no legacy global
button/input/table/dialog skin rules. Plain CSS in `style.css`, `catalog.css`,
and `capabilities.css` handles product layout and custom graphics. ResourceMap,
LiveResources, DraftResources, and their attribution/reservation/staleness rules
are retained. Their palette now comes from semantic/chart tokens. MemoryChart
remains a small, responsive SVG: introducing Recharts would add machinery
without improving its existing time-series behavior.

## Verification

Performance and Generation group their card contents in `FieldSet`, with a
screen-reader legend (the visible title remains in CardHeader) and a `FieldGroup`.
Explicit engine flags are compact `Item` rows (`size="sm"`) in an `ItemGroup`.
`ItemContent` contains the complete vertical `Field`: label, control,
syntax/default `FieldDescription`, then `FieldError`. The icon-only trash button
belongs separately in `ItemActions`, not inside the field.
Descriptions and errors stay below the controls at every viewport size.
Header Add opens a responsive Drawer of
supported, absent flags (`size="default"`), using leading checkboxes without value
editors. Cancel discards the selection; Add (N) seeds explicit values in the parent
draft. Installed help defaults take precedence over the llama.cpp server README
reference; historical application presets are not engine defaults. Removing a flag
omits it rather than passing a disabled value. Existing explicit values, including
zero and values equal to defaults, remain explicit. Thinking budget is a Generation
flag; max output tokens remains separate client catalog metadata.

TanStack Form owns the editor draft and transient numeric text together; cards
do not create independent forms. A module-level Zod schema checks known flag
types without supplying defaults or stripping extensions. Installed capability
constraints are validated alongside it. Batch comparisons require explicit values
or installed-engine defaults, never reference presets. Numeric controls compose
`FieldGroup`/`Field` with an input and slider. Clearing the input preserves blank
text while typing; blur validates and commits valid numbers without substituting
zero or an automatic sentinel. Submission validates any pending text before
serialization. Invalid text participates in dirty/navigation protection; Discard
resets text and errors. JSON replacements reconcile changed values, capability
refreshes preserve edits, and model membership changes keep buffers with their
original member. Backend validation and wire decoders remain authoritative at
their boundaries.

The Variants editor composes shadcn Item rows in an ItemGroup. Its Add variant
button is in the CardHeader's CardAction, with the default selector in
CardContent and no introductory, default-selector or footer advisory text.
Rows have their name in ItemContent and the enablement Switch and overflow menu
in ItemActions.
Custom entries have a secondary Custom badge anchored to the right edge of the
name cell, independent of name length; built-ins and legacy Default do not.
The legacy Default row stays editable and reorderable but has no exposure Switch;
it must not imply control over the client's built-in no-variant Default choice.
Configuration summaries and drag handles are deliberately omitted; editing and
Move up/down live in the menu. Keyed rows preserve control focus across updates.
A Base UI Drawer opens on the right on desktop and from the bottom on narrow viewports;
the owned wrapper is scoped to those directions. Apply updates the parent draft,
not the server. Nested navigation guards protect both unapplied Drawer edits and
the builder draft. New drafts seed common reasoning defaults; existing catalogs
are never reset by merely viewing or saving unrelated settings.
Variants remain visible and editable independently of the Reasoning capability.
Their client exposure/defaults and gateway transformations are independent too;
the declaration is metadata, not a gate on saved variants.

```sh
cd frontend
npm run check
npm run lint
npm run format:check
npm run build
npm test
npx playwright install chromium  # once, if Chromium is not already available
npm run test:ui
```

The browser suite starts its own loopback Vite server, refuses to reuse an
occupied port, and intercepts API calls. Its network guard blocks requests to
other origins. See [testing](testing.md). Checks cover desktop/mobile primary pages,
catalog/download selection, keyboard menus, focus trapping/restoration, dirty
and busy dialogs, engine-reset confirmation, launch consent/tokens, form
validation, multi-model settings, sliders, Select/Switch, polling, SSE, and
resource drill-down. An isolated effect harness also checks API-client replacement,
stale-response cancellation, JSON validation across parent rerenders, and runtime
schema reconciliation without losing edits. Contract tests cover malformed API
responses, invalid JSON shapes, extension round-trips, nullable telemetry, and
multi-model groups without a single alias/profile. The backend suite also feeds
offline ASGI responses through the frontend decoders. Axe checks WCAG A/AA rules and contrast on both viewport
sizes plus the editor and variant dialog. Screenshots/traces are written to
ignored `frontend/test-results/`; CI retains them as fixture-only artifacts.

Automated accessibility checks are not a substitute for testing with an actual
screen reader. GPU compatibility and live inference remain outside this
frontend migration's verification boundary.
