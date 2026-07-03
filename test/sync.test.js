// ⑪ single-source guard: the skill's plugin assets must equal the packages source.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const src = path.join(root, "packages", "plugin", "figma-plugin");
const dst = path.join(root, "skills", "figma-html-loop", "assets", "figma-plugin");

for (const file of ["code.js", "ui.html", "manifest.json"]) {
  test(`skill plugin asset in sync: ${file}`, () => {
    const a = fs.readFileSync(path.join(src, file), "utf8");
    const b = fs.readFileSync(path.join(dst, file), "utf8");
    assert.strictEqual(a, b, `${file} drifted — run: npm run sync-skill`);
  });
}

test("plugin version is consistent (code.js / ui.html / server)", () => {
  const code = fs.readFileSync(path.join(src, "code.js"), "utf8");
  const ui = fs.readFileSync(path.join(src, "ui.html"), "utf8");
  const server = fs.readFileSync(path.join(root, "packages", "local-helper", "src", "server.js"), "utf8");
  const cv = (code.match(/PLUGIN_VERSION\s*=\s*'([^']+)'/) || [])[1];
  const uv = (ui.match(/EXPECTED_VERSION\s*=\s*"([^"]+)"/) || [])[1];
  const sv = (server.match(/helperVersion\s*=\s*"([^"]+)"/) || [])[1];
  assert.ok(cv, "PLUGIN_VERSION found in code.js");
  assert.strictEqual(uv, cv, "ui.html EXPECTED_VERSION must match code.js PLUGIN_VERSION (bump both)");
  assert.strictEqual(sv, cv, "server helperVersion must match plugin version (bump together)");
});
