# Frontend design system

Menagerie uses **Tailwind CSS v4** (`@tailwindcss/vite`) and the **Base UI**
variant of shadcn/ui. This is a component migration, not a new router or API.
Hash routes, registry polling, SSE, launch-review tokens, and domain calculations
remain in the existing product modules.

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
mode, as before; this change does not introduce a theme-switching workflow.

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
- `frontend/src/ui.tsx`: retained API/token handling, formatters, domain mapping,
  structured data editing, and compatibility exports for the product modules.
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

```sh
cd frontend
npm run build
npm test
npx playwright install chromium  # once, if Chromium is not already available
npm run test:ui
```

The browser suite starts its own loopback Vite server on **8049**, refuses to
reuse an occupied port, and intercepts every API call. It never contacts the
live registry or launches a runtime. Checks cover desktop/mobile primary pages,
catalog/download selection, keyboard menus, focus trapping/restoration, dirty
and busy dialogs, engine-reset confirmation, launch consent/tokens, form
validation, multi-model settings, sliders, Select/Switch, polling, SSE, and
resource drill-down. Axe checks WCAG A/AA rules and contrast on both viewport
sizes plus the editor and variant dialog. Screenshots/traces are written to
ignored `frontend/test-results/`; CI retains them as fixture-only artifacts.

Automated accessibility checks are not a substitute for testing with an actual
screen reader. GPU compatibility and live inference remain outside this
frontend migration's verification boundary.
