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
    const patch = argValue("--patch", "");
    if (!patch) throw new Error("Missing --patch.");
    const result = await request("POST", "/api/apply/request", { patchFile: path.resolve(patch) });
    print(result);
  } catch (error) {
    print({ ok: false, message: error.message, data: error.data || null });
    process.exit(1);
  }
})();
