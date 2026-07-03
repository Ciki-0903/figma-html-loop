# Notices

This project source-integrates parts of Figma Bridge for the Figma -> HTML path.

## Figma Bridge

- Source: `kingkongshot/Figma-Bridge`
- License: MIT
- Local license copy: `LICENSES/Figma-Bridge-MIT.txt`

Integrated areas:

- `packages/bridge-engine`: seeded from Figma Bridge's `packages/bridge-pipeline`
- `packages/plugin/vendor-figma-bridge`: reference copy of the original Figma plugin extraction layer
- `packages/local-helper/vendor-figma-bridge`: reference copy of the original local service and preview assets

The product surface remains Figma HTML Loop. Figma Bridge code is treated as an internal engine/reference layer while preserving its MIT license notice.
