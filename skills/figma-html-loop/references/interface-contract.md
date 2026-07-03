# Interface Contract

Use this when implementing or wiring the bundled helper, CLI, or Figma plugin.

## Local Helper

Default base URL (the active helper runs on **7800**; `FIGMA_HTML_LOOP_PORT` overrides):

```text
http://localhost:7800
```

Required endpoints:

- `GET /health` returns `ok`.
- `GET /figma-html-loop-capture.js` serves the browser capture client (inject into any HTML to capture it).
- `POST /api/selection/confirm` receives a confirmed Figma selection.
- `GET /api/selection/latest` returns the latest confirmed selection session.
- `POST /api/images/batch` / `POST /api/svgs/batch` save image / SVG assets.
- `POST /api/export/html` creates HTML/CSS/manifest from a selection session.
- `POST /api/capture/html` stores static HTML capture (no bounds).
- `POST /api/capture/dom` receives the live browser DOM capture (bounds + `created[]`).
- `GET /api/capture/latest` returns the latest live capture.
- `POST /api/diff` creates a Figma patch from manifest + capture (update/create/delete).
- `POST /api/build-page` creates a create-only patch (with a `page.create` directive) from a capture — **no manifest needed** (Scenario E: external HTML → new page). Accepts `cols`/`gap` to arrange multiple screens in a grid (batch multi-screen).
- `POST /api/apply/request` sends or queues a patch for the Figma plugin.
- `GET /api/apply/pending` / `POST /api/apply/ack` — plugin polls & acknowledges. The ack body includes `created` (a `createId → figmaId` map, nested nodes included) and `page`.
- `POST /api/writeback` — write `data-figma-id` back into a source HTML (matched by `data-figma-create-id`) using the last apply's `created` map, and optionally emit a `loop-manifest` so the next round-trip updates instead of re-creating.

## CLI

CLI commands should output JSON and avoid interactive prompts:

```bash
figma-html-loop doctor --json
figma-html-loop start-helper --json
figma-html-loop plugin-path --json
figma-html-loop wait-selection --timeout 60 --json
figma-html-loop export --out ./figma-html-loop-export --json
figma-html-loop capture <url-or-file> --out ./html-capture.json --json
figma-html-loop capture-latest --out ./html-capture.json --json
figma-html-loop diff --manifest ./figma-html-loop-export/loop-manifest.json --capture ./html-capture.json --out ./figma-patch.json --json
figma-html-loop build-page --page-name "New Page" --out ./figma-patch.json --json
figma-html-loop build-page --page-name "Board" --cols 3 --gap 48 --out ./figma-patch.json --json
figma-html-loop annotate-ids --html ./screen.html --json
figma-html-loop apply --patch ./figma-patch.json --json
figma-html-loop writeback --html ./screen.html --manifest-out ./loop-manifest.json --json
```

### Scenario E — external HTML → new Figma page

To reconstruct an unrelated HTML screen as a brand-new Figma page:

1. Mark each element that should become a layer: `data-figma-create="frame|text|image"` + `data-figma-name="..."` (containers = frame, text = text, `<img>` = image; nest by real layout).
2. Inject the capture client: `<script src="http://localhost:7800/figma-html-loop-capture.js"></script>`.
3. Open the HTML in a browser (`file://` works) so it POSTs the DOM capture.
4. `build-page --page-name "..."` → `apply`. The plugin creates a new page (via the patch's `page.create` directive) and builds everything there, untouched pages preserved.

## Figma Plugin

The plugin must:

- show connection status
- show current selection name, type, and size
- require a user click before confirming export
- send structured selection data to the local helper
- export missing image/SVG assets
- receive approved patches from the local helper
- apply patches with Figma's official plugin API

## Round-Trip Metadata

Generated HTML should preserve original Figma identity:

```html
<div data-figma-id="12:345" data-figma-type="FRAME" data-figma-name="Hero">
```

Export should include `loop-manifest.json` with:

- source file/page information when available
- root node ID
- original node IDs
- layer names and paths
- layout and style snapshots
- asset IDs
- HTML selectors

Patch logic should update original nodes first and create new nodes only when no original node matches.

## Patch Schema (v0.3.0)

`POST /api/diff` produces `{ schemaVersion: "0.3.0", operations: [...] }`. Each operation has an `action`:

- `update` — change an existing node by Figma `id`. Carries optional `text` and a `style` object.
- `create` — add a new layer. Carries `kind` (`rectangle` | `text` | `frame` | `image`), `parentId`, `name`, `text`, `imageBase64`, `style`, and optional **`children`** (array of nested create specs — a `frame` can contain its icon + label).
- `delete` — remove a node whose HTML element no longer exists.

A patch may also carry a top-level **`page`** directive:

- `page: { create: true, name: "..." }` — before applying ops, create a new Figma page and make it current. Root-level `create` ops (parentId unresolved) build onto that page; all existing pages/layers are untouched. Produced by `POST /api/build-page`.

The shared `style` model (understood by both diff and the plugin's `applyStyle`) supports:

- Layout: `x`, `y`, `width`, `height` (relative to the parent for `create`).
- Fills: `fill` (`{r,g,b,a}` single solid, back-compat) or `fills` (array of `{type:"SOLID",r,g,b,a}` / `{type:"GRADIENT_LINEAR", angle, stops:[{position,r,g,b,a}]}`).
- Stroke/border: `strokeColor` (`{r,g,b,a}`) + `strokeWeight`.
- Corner radius: `cornerRadius` (uniform) or `cornerRadii` (`[tl,tr,br,bl]`).
- Effects: `effects` (array of `{type:"DROP_SHADOW"|"INNER_SHADOW"|"LAYER_BLUR"|"BACKGROUND_BLUR", x, y, blur, spread, color}`).
- `opacity`, `visible`.
- Text: `fontSize`, `fontFamily`, `fontWeight` (mapped to the nearest Figma font style), `fontStyle` (`"italic"`), `lineHeightPx`, `letterSpacing`, `textAlign`, `textDecoration`.

### Deletion

Deletion is detected only from a full browser DOM capture (`/api/capture/dom`), never from the static HTML parser. It is **on by default**; pass `detectDeletions: false` to `/api/diff` to disable. The exported selection roots (`manifest.rootIds`) and originally zero-size nodes are never deleted, to avoid removing wrappers or never-rendered layers.

### Round-trip markers (HTML side)

- Existing layers keep `data-figma-id`; edits to their position, size, color, gradient, border, radius, shadow, opacity, or text reflow back automatically.
- New elements without `data-figma-id` are captured as `create`. Optional attributes: `data-figma-create` / `data-figma-new` (force layer kind), `data-figma-create-id` (stable id), `data-figma-name` (layer name).
