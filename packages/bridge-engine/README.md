# Bridge Engine

This package is the source-integrated Figma -> HTML engine for Figma HTML Loop.

It is seeded from Figma Bridge's `figma-html-bridge` pipeline, then wrapped by Figma HTML Loop's local helper and CLI.

Next extraction work:

1. Keep the upstream pipeline compiling in this package.
2. Add Figma HTML Loop metadata hooks such as `data-figma-id` and `loop-manifest.json`.
3. Expose a stable API for the local helper:

```js
figmaSelectionToHtml({ composition, assets, options })
```

4. Keep Figma Bridge license attribution in `NOTICE.md` and `LICENSES/Figma-Bridge-MIT.txt`.
