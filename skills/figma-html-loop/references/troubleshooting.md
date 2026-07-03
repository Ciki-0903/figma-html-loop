# Troubleshooting

Use this when the user gets stuck. Start with one clear action.

## Plugin Shows Offline

Say:

> The plugin cannot see the local helper yet. I will check whether the helper is running.

Run:

```bash
cd /Users/bytedance/figma-html-loop
node packages/cli/bin/figma-html-loop.js doctor
```

If it is not running, start it:

```bash
node packages/cli/bin/figma-html-loop.js start
```

Ask the user to close and reopen the Figma plugin.

## User Cannot Find The Plugin File

Say:

> I will show the exact plugin file path. In Figma, choose this file when it asks for a manifest.

Run:

```bash
cd /Users/bytedance/figma-html-loop
node packages/cli/bin/figma-html-loop.js plugin-path
```

Point them to `assets/figma-plugin/manifest.json`.

If image resources are missing in the exported HTML, ask the user to re-import the formal project plugin:

```text
/Users/bytedance/figma-html-loop/packages/plugin/figma-plugin/manifest.json
```

The plugin should show **Plugin version: bridge-assets-0.3** or newer.

## Figma Does Not Show Development Plugins

Ask the user to check:

- They are logged in to Figma.
- A Figma file is open.
- They are using the Figma top menu, not the browser context menu.
- They selected **Plugins > Development > Import plugin from manifest**.

## No Selection Found

Say:

> Please click one Frame or component in Figma, then click **Export Selection** in the plugin.

If they selected loose layers, recommend selecting the parent Frame.

## Export Takes A Long Time

Say:

> The first export can be slower because images and SVGs are being saved. Later exports are usually faster.

Check for:

- very large selected Frame
- many images
- many vector or SVG layers
- first-time export on this device

## HTML Does Not Match Figma

Check:

- Did the user select the correct parent Frame?
- Did images or fonts fail to load?
- Did the edited HTML remove `data-figma-id`?
- Did complex CSS need to be flattened into image/SVG?

Tell the user when a layer may not stay fully editable.

## Apply Back To Figma Fails

Say:

> The plugin needs to be open in Figma so it can apply the approved changes.

Check:

- Figma is open.
- The same design file is open when possible.
- The **Figma HTML Loop** plugin is running.
- The patch was approved by the user.
- The original node IDs still exist.

## New Device Setup Is Confusing

Slow down:

1. Start local helper.
2. Install plugin from `manifest.json`.
3. Open plugin and confirm Connected.
4. Select one Frame.
5. Click **Export Selection**.

Do not move to HTML editing until these five steps work.
