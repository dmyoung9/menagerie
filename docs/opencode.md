# OpenCode / OpenChamber integration

## Install discovery

Menagerie includes the plugin source in `plugins/opencode/` and bundles its runtime
files into the Python wheel. It targets **OpenCode V2 2.1.3** and uses the matching
public `@opencode/plugin` SDK. V1 is not supported.

```sh
menagerie plugin install
menagerie plugin status
opencode service restart
```

Use `.venv/bin/menagerie` for a source installation. The plugin is auto-discovered
at `<OpenCode config>/plugins/menagerie/index.ts`; no main configuration rewrite
is needed. OpenCode resolves the declared SDK dependency when loading the plugin.
Your existing model default, credentials, plugins, and providers are unchanged.
The plugin registers a `menagerie` provider only if one is not already configured;
an existing provider's endpoint/settings remain authoritative.

The installer defaults to `OPENCODE_CONFIG_DIR`, or
`${XDG_CONFIG_HOME:-~/.config}/opencode`. Override explicitly if your server uses a
different configuration directory:

```sh
menagerie plugin install --config-dir /absolute/opencode-config --gateway-port 8028
```

Run this **on the machine that owns the OpenCode server**, in the same user account.
OpenChamber normally inherits that server's plugins. The bundled plugin only calls
a loopback HTTP `/v1` endpoint, rejects redirects, and never loads/evicts models.
Remote OpenCode servers therefore need an independently reviewed local forwarding
arrangement; the LAN dashboard is not an inference endpoint.

## Behavior

- Registers provider ID `menagerie`, using the OpenAI-compatible runtime.
- Fetches `/v1/models` after startup and every 30 seconds, with a three-second timeout.
- Validates the `menagerie.catalog` version-2 contract and the SDK's model schema.
  Capabilities, context/output limits, variants, pricing, and API aliases come from
  Menagerie, not guessed model names or old static overrides.
- Maps an empty `default` preset to the client's built-in Default choice rather
  than creating a duplicate. OpenCode/OpenChamber always retain that base choice;
  hiding Default in Menagerie's advertised presets cannot remove the client's
  built-in option. Other presets follow the deployment's exposure choices exactly.
- Replaces that provider's discovered inventory on a successful response, including
  an empty inventory. Keeps the last successful inventory during temporary outages.
- Clears retained inventory when the endpoint changes; cleans up timers and requests
  when unloaded. Discovery failures are logged without response bodies or credentials.
- Never changes your chosen default model. Select `menagerie/<api-alias>` yourself.

Avoid adding static `providers.menagerie.models` overrides alongside discovery unless
you deliberately want OpenCode's later configuration transforms to override it.
Existing differently named provider IDs are not silently renamed or removed.

Plugin installation updates an on-disk directory, **not a running OpenCode process**.
Restart the owning server with `opencode service restart`, then reconnect clients
and check `/models`. If your OpenChamber runs a separate server, restart that owner
instead. Successful installation is not proof the runtime loaded the plugin.

If your client offers configuration reload, consult that client's documentation
for its scope and effect on running work. Verify the resulting model catalog,
not just a successful reload notification.

Activate matching backend and plugin versions together. The plugin reads
`menagerie.catalog`; a catalog from a different backend version is not a compatible
substitute. Saved reasoning presets must appear as explicit `model.variants` in the
live catalog before any client can display them. A newer dashboard alone does not
update an already-running Python backend.

## Update, remove, and recover

Rerun `menagerie plugin install` after updating Menagerie. Existing managed files
must match the install manifest. Unmanaged directories, symlinks, unexpected files,
and local source edits are refused rather than overwritten. Preserve/review an old
manual plugin before replacing it; do not register two discovery plugins.

```sh
menagerie plugin remove
opencode service restart
```

Updates/removals preserve the old directory under
`<OpenCode config>/menagerie-plugin-backups/` and report its path. To roll back,
stop the OpenCode server, preserve the current plugin directory, restore the selected
backup as `plugins/menagerie`, and restart. Removing the plugin does not delete
Menagerie data or edit static provider configuration you added yourself.

## Static fallback and branding

`menagerie export-opencode` produces a native V2 fragment for clients without the
plugin. Merge only the desired provider entry; don't replace your global settings.
Regenerate/reload it when aliases or capabilities change.

The color and monochrome assets are included under `frontend/public/`. OpenCode
V2's documented provider configuration has no custom-icon field; this plugin does
not inject one. OpenChamber provider-icon rendering remains a client-side integration.
