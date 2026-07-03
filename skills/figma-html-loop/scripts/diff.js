#!/usr/bin/env node

const path = require("path");
const { request, print } = require("./http-json");

function argValue(name, fallback) {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  const prefixed = process.argv.find((arg) => arg.startsWith(`${name}=`));
  return prefixed ? prefixed.slice(name.length + 1) : fallback;
}

(async () => {
  try {
    const manifest = argValue("--manifest", "");
    const capture = argValue("--capture", "");
    if (!manifest || !capture) throw new Error("Missing --manifest or --capture.");
    const out = path.resolve(argValue("--out", "figma-patch.json"));
    const result = await request("POST", "/api/diff", {
      manifest: path.resolve(manifest),
      capture: path.resolve(capture),
      out
    });
    print(result);
  } catch (error) {
    print({ ok: false, message: error.message, data: error.data || null });
    process.exit(1);
  }
})();
