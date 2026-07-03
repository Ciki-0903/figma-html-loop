#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const serverPath = path.resolve(__dirname, "server.js");

if (!fs.existsSync(serverPath)) {
  console.log(JSON.stringify({
    ok: false,
    message: "The bundled local helper server is not installed yet.",
    missing: serverPath
  }, null, 2));
  process.exit(1);
}

const child = spawn(process.execPath, [serverPath], {
  detached: true,
  stdio: "ignore",
  env: process.env
});

child.unref();

console.log(JSON.stringify({
  ok: true,
  message: "Local helper is starting.",
  pid: child.pid,
  bridgeUrl: `http://localhost:${process.env.FIGMA_HTML_LOOP_PORT || 7799}`
}, null, 2));
