#!/usr/bin/env node

const { request, print } = require("./http-json");

const timeoutArg = process.argv.find((arg) => arg.startsWith("--timeout="));
const timeout = Number(timeoutArg ? timeoutArg.split("=")[1] : 60);
const deadline = Date.now() + timeout * 1000;

(async () => {
  while (Date.now() < deadline) {
    try {
      const latest = await request("GET", "/api/selection/latest");
      print(latest);
      process.exit(0);
    } catch (_) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  print({ ok: false, message: "Timed out waiting for a confirmed Figma selection." });
  process.exit(1);
})();
