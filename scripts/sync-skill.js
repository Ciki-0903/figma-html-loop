#!/usr/bin/env node
// Single-source guard: the Figma plugin assets live in packages/plugin/figma-plugin
// and are COPIED into the skill (which must ship them for "Import plugin from
// manifest"). This script keeps the skill copy in sync — run it after editing the
// plugin, or via `npm run build`. `--check` verifies sync without writing (used by
// tests / CI) and exits non-zero on drift.

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const src = path.join(root, "packages", "plugin", "figma-plugin");
const dst = path.join(root, "skills", "figma-html-loop", "assets", "figma-plugin");

const FILES = ["code.js", "ui.html", "manifest.json"];
const check = process.argv.includes("--check");

const drift = [];
let copied = 0;

for (const file of FILES) {
  const a = path.join(src, file);
  const b = path.join(dst, file);
  const srcData = fs.readFileSync(a, "utf8");
  const dstData = fs.existsSync(b) ? fs.readFileSync(b, "utf8") : null;
  if (srcData === dstData) continue;
  if (check) {
    drift.push(file);
  } else {
    fs.mkdirSync(path.dirname(b), { recursive: true });
    fs.writeFileSync(b, srcData);
    copied += 1;
  }
}

if (check) {
  if (drift.length) {
    console.error(JSON.stringify({ ok: false, message: "Skill plugin assets are out of sync. Run: npm run sync-skill", drift }, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, message: "Skill plugin assets in sync.", files: FILES }, null, 2));
} else {
  console.log(JSON.stringify({ ok: true, message: "Skill plugin assets synced.", copied, files: FILES }, null, 2));
}
