# Local Helper

The local helper is the single localhost service used by Figma HTML Loop.

Responsibilities:

- receive confirmed Figma selections from the plugin
- call `@figma-html-loop/bridge-engine` for Figma -> HTML
- write HTML/CSS/manifest output
- capture edited HTML
- create round-trip patches
- queue approved patches for the Figma plugin

The current default `src/server.js` is the round-trip prototype server. The `vendor-figma-bridge/` folder is a source reference for migrating the high-fidelity Figma -> HTML service.
