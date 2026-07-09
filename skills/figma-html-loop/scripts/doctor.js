#!/usr/bin/env node

const http = require("http");

const port = Number(process.env.FIGMA_HTML_LOOP_PORT || 7800);
const host = "127.0.0.1";

function get(path) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path, timeout: 2000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body }));
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, error: "timeout" });
    });
    req.on("error", (error) => resolve({ ok: false, error: error.message }));
  });
}

(async () => {
  const health = await get("/health");
  const healthOk = health.ok && String(health.body || "").trim().toLowerCase() === "ok";
  const result = {
    ok: healthOk,
    bridgeUrl: `http://localhost:${port}`,
    port,
    message: healthOk
      ? "Local helper is running."
      : "Local helper is not reachable. Start it, then reopen the Figma plugin.",
    error: healthOk ? null : (health.error || `Unexpected response: ${health.status || "no status"}`)
  };

  console.log(JSON.stringify(result, null, 2));
  process.exit(healthOk ? 0 : 1);
})();
