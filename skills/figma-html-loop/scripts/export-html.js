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
    const out = path.resolve(argValue("--out", "figma-html-loop-export"));
    const result = await request("POST", "/api/export/html", { out });
    print(result);
  } catch (error) {
    print({ ok: false, message: error.message, data: error.data || null });
    process.exit(1);
  }
})();
