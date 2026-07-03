#!/usr/bin/env node

const path = require("path");

const manifest = path.resolve(__dirname, "..", "assets", "figma-plugin", "manifest.json");

console.log(JSON.stringify({
  ok: true,
  manifestPath: manifest,
  message: "Use this manifest file when Figma asks you to import a development plugin."
}, null, 2));
