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
    const target = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : argValue("--target", "");
    if (!target) throw new Error("Missing HTML file or URL.");
    const out = path.resolve(argValue("--out", "html-capture.json"));
    const css = argValue("--css", "");
    const result = await request("POST", "/api/capture/html", { target, out, css });
    print(result);
  } catch (error) {
    print({ ok: false, message: error.message, data: error.data || null });
    process.exit(1);
  }
})();
