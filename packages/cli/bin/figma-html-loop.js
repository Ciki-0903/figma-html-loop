#!/usr/bin/env node

const fs = require("fs");
const http = require("http");
const path = require("path");
const { execFileSync, spawn } = require("child_process");
const { packageFontsForExport } = require("../../local-helper/src/font-packager");

const root = path.resolve(__dirname, "..", "..", "..");
const port = Number(process.env.FIGMA_HTML_LOOP_PORT || 7800);

function json(data, code = 0) {
  console.log(JSON.stringify(data, null, 2));
  process.exit(code);
}

function request(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? "" : JSON.stringify(body);
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: pathname,
      method,
      timeout: 5000,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload)
      }
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => {
        let data = text;
        try { data = JSON.parse(text); } catch (_) {}
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
        else reject(Object.assign(new Error(data && data.message ? data.message : `HTTP ${res.statusCode}`), { data }));
      });
    });
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timed out."));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

function argValue(name, fallback = "") {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  const prefixed = process.argv.find((arg) => arg.startsWith(`${name}=`));
  return prefixed ? prefixed.slice(name.length + 1) : fallback;
}

function findHelperPids() {
  try {
    const out = execFileSync("lsof", ["-ti", `TCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
    return out.split(/\s+/).filter(Boolean).map((value) => Number(value)).filter(Boolean);
  } catch {
    return [];
  }
}

async function startHelper() {
  const serverPath = path.join(root, "packages", "local-helper", "src", "server.js");
  const child = spawn(process.execPath, [serverPath], { detached: true, stdio: "ignore", env: process.env });
  child.unref();
  return { ok: true, message: "Local helper is starting.", pid: child.pid, bridgeUrl: `http://localhost:${port}` };
}

function stopHelper() {
  const pids = findHelperPids();
  const stopped = [];
  const failed = [];
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
      stopped.push(pid);
    } catch (error) {
      failed.push({ pid, message: error.message });
    }
  }
  return { ok: failed.length === 0, stopped, failed, port };
}

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function exportSizeFromManifest(manifest) {
  const bounds = manifest && manifest.bounds;
  let width = Number(bounds && bounds.width);
  let height = Number(bounds && bounds.height);
  if ((!width || !height) && manifest && manifest.nodes) {
    for (const node of Object.values(manifest.nodes)) {
      const layout = node && node.layout;
      width = Math.max(width || 0, Number((layout && layout.width) || node.width || 0));
      height = Math.max(height || 0, Number((layout && layout.height) || node.height || 0));
    }
  }
  return {
    width: Math.max(1, Math.ceil(width || 800)),
    height: Math.max(1, Math.ceil(height || 600))
  };
}

function ensureExportShellCss(outDir) {
  const cssPath = path.join(outDir, "styles.css");
  const manifestPath = path.join(outDir, "loop-manifest.json");
  if (!fs.existsSync(cssPath) || !fs.existsSync(manifestPath)) return { patched: false };

  const css = fs.readFileSync(cssPath, "utf8");
  const manifest = readJsonFile(manifestPath);
  const { width, height } = exportSizeFromManifest(manifest);
  const shellCss = [
    `.figma-export{position:relative;width:${width}px;height:${height}px;overflow:visible;background:transparent;}`,
    `.figma-export>.content-layer{position:relative;width:${width}px;height:${height}px;}`
  ].join("\n");

  const cleaned = css
    .replace(/\.figma-export\{position:relative;width:[^}]+\}\n?/g, "")
    .replace(/\.figma-export>\.content-layer\{position:relative;width:[^}]+\}\n?/g, "");
  const next = `${shellCss}\n${cleaned}`;
  if (next !== css) fs.writeFileSync(cssPath, next, "utf8");
  return { patched: next !== css, width, height };
}

function ensureExportFonts(outDir) {
  const manifestPath = path.join(outDir, "loop-manifest.json");
  if (!fs.existsSync(manifestPath)) return { embedded: [], missing: [], cssInjected: false };
  const manifest = readJsonFile(manifestPath);
  return packageFontsForExport(outDir, manifest);
}

async function main() {
  const cmd = process.argv[2] || "help";
  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    json({
      ok: true,
      commands: ["doctor", "start", "stop", "restart", "plugin-path", "wait-selection", "export", "exports", "capture", "capture-latest", "capture-stable", "diff", "build-page", "annotate-ids", "apply", "writeback"],
      port
    });
  }

  if (cmd === "plugin-path") {
    json({
      ok: true,
      manifestPath: path.join(root, "packages", "plugin", "figma-plugin", "manifest.json")
    });
  }

  if (cmd === "start") {
    json(await startHelper());
  }

  if (cmd === "stop") {
    json(stopHelper());
  }

  if (cmd === "restart") {
    const stopped = stopHelper();
    await new Promise((resolve) => setTimeout(resolve, 800));
    const started = await startHelper();
    json({ ok: stopped.ok && started.ok, stopped, started });
  }

  if (cmd === "doctor") {
    try {
      const health = await request("GET", "/health");
      json({ ok: String(health).trim().toLowerCase() === "ok", bridgeUrl: `http://localhost:${port}` });
    } catch (error) {
      json({ ok: false, bridgeUrl: `http://localhost:${port}`, message: error.message }, 1);
    }
  }

  if (cmd === "wait-selection") {
    const timeout = Number(argValue("--timeout", "60"));
    const deadline = Date.now() + timeout * 1000;
    while (Date.now() < deadline) {
      try {
        json(await request("GET", "/api/selection/latest"));
      } catch (_) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    json({ ok: false, message: "Timed out waiting for a confirmed Figma selection." }, 1);
  }

  if (cmd === "export") {
    const out = path.resolve(argValue("--out", "figma-html-loop-export"));
    const result = await request("POST", "/api/export/html", { out });
    const shell = ensureExportShellCss(out);
    const fonts = ensureExportFonts(out);
    json({ ...result, shellCss: shell, fonts });
  }

  if (cmd === "exports") {
    const out = path.resolve(argValue("--out", "figma-html-loop-export"));
    const result = await request("GET", `/api/exports?out=${encodeURIComponent(out)}`);
    json(result);
  }

  if (cmd === "capture") {
    const target = process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : argValue("--target");
    const out = path.resolve(argValue("--out", "html-capture.json"));
    const css = argValue("--css", "");
    const latest = process.argv.includes("--latest");
    if (!target) json({ ok: false, message: "Missing HTML file or URL." }, 1);
    json(await request("POST", "/api/capture/html", { target, out, css, latest }));
  }

  if (cmd === "capture-latest") {
    const out = path.resolve(argValue("--out", "html-capture.json"));
    try {
      const data = await request("GET", "/api/capture/latest");
      fs.writeFileSync(out, JSON.stringify(data, null, 2), "utf8");
      json({ ok: true, capture: data, out });
    } catch (error) {
      const fallbackTarget = path.join(root, "figma-html-loop-export", "index.html");
      const fallbackCss = path.join(root, "figma-html-loop-export", "styles.css");
      try {
        const fallback = await request("POST", "/api/capture/html", {
          target: fallbackTarget,
          css: fs.existsSync(fallbackCss) ? fallbackCss : "",
          out
        });
        json({
          ok: true,
          fallback: true,
          message: "还没有收到浏览器实时捕获，已先使用当前导出的 HTML 生成捕获文件。要获得更准的位置，请打开 http://localhost:7800/export/index.html 后再运行一次 capture-latest。",
          capture: fallback.capture,
          out
        });
      } catch (fallbackError) {
        json({
          ok: false,
          message: "还没有收到浏览器捕获。请先打开 http://localhost:7800/export/index.html，等待 1 秒，再重新运行 capture-latest。",
          data: fallbackError.data || error.data || null
        }, 1);
      }
    }
  }

  if (cmd === "diff") {
    const manifest = argValue("--manifest");
    const capture = argValue("--capture");
    const out = path.resolve(argValue("--out", "figma-patch.json"));
    if (!manifest) json({ ok: false, message: "Missing --manifest." }, 1);
    json(await request("POST", "/api/diff", { manifest: path.resolve(manifest), capture: capture ? path.resolve(capture) : "", out }));
  }

  if (cmd === "capture-stable") {
    // Wait until the live browser capture stops changing (settled DOM + assets),
    // instead of guessing with a fixed sleep. Returns the stable capture.
    const timeout = Number(argValue("--timeout", "15")) * 1000;
    const out = argValue("--out", "");
    const deadline = Date.now() + timeout;
    let lastSig = null;
    while (Date.now() < deadline) {
      let data = null;
      try { data = await request("GET", "/api/capture/latest"); } catch (_) {}
      const created = data && Array.isArray(data.created) ? data.created.length : 0;
      const nodes = data && data.nodes ? Object.keys(data.nodes).length : 0;
      const nonEmpty = created > 0 || nodes > 0;
      const sig = data ? String(data.capturedAt) + ":" + created + ":" + nodes : "";
      if (nonEmpty && sig === lastSig) {
        if (out) fs.writeFileSync(path.resolve(out), JSON.stringify(data, null, 2));
        json({ ok: true, stable: true, created, nodes, capturedAt: data.capturedAt, out: out || null });
      }
      lastSig = sig;
      await new Promise((r) => setTimeout(r, 400));
    }
    json({ ok: false, message: "Capture did not stabilize before timeout.", timeoutMs: timeout }, 1);
  }

  if (cmd === "build-page") {
    const capture = argValue("--capture");
    const pageName = argValue("--page-name", "HTML Import");
    const out = path.resolve(argValue("--out", "figma-patch.json"));
    const cols = Number(argValue("--cols", "0")) || 0;   // >1 arranges multiple screens in a grid
    const gap = Number(argValue("--gap", "48"));
    json(await request("POST", "/api/build-page", { capture: capture ? path.resolve(capture) : "", pageName, out, cols, gap }));
  }

  if (cmd === "annotate-ids") {
    const file = argValue("--html");
    if (!file) json({ ok: false, message: "Missing --html." }, 1);
    const p = path.resolve(file);
    const { annotateCreateIds } = require("../../local-helper/src/server.js");
    const result = annotateCreateIds(fs.readFileSync(p, "utf8"));
    fs.writeFileSync(p, result.html, "utf8");
    json({ ok: true, file: p, added: result.added });
  }

  if (cmd === "writeback") {
    const html = argValue("--html");
    const manifestOut = argValue("--manifest-out", "");
    if (!html) json({ ok: false, message: "Missing --html." }, 1);
    json(await request("POST", "/api/writeback", {
      html: path.resolve(html),
      manifestOut: manifestOut ? path.resolve(manifestOut) : ""
    }));
  }

  if (cmd === "apply") {
    const patchFile = argValue("--patch");
    if (!patchFile) json({ ok: false, message: "Missing --patch." }, 1);
    json(await request("POST", "/api/apply/request", { patchFile: path.resolve(patchFile) }));
  }

  json({ ok: false, message: `Unknown command: ${cmd}` }, 1);
}

main().catch((error) => json({ ok: false, message: error.message, data: error.data || null }, 1));
