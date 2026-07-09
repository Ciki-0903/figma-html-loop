#!/usr/bin/env node

const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const { spawn } = require("child_process");
const { URL } = require("url");
const { packageFontsForExport } = require("./font-packager");
const { comparePng } = require("./pixel-diff");

const port = Number(process.env.FIGMA_HTML_LOOP_PORT || 7800);
const projectRoot = path.resolve(__dirname, "..", "..", "..");
const bridgeEngineDist = path.resolve(__dirname, "..", "..", "bridge-engine", "dist");
const cacheRoot = path.resolve(__dirname, "..", "..", "..", "temp");
const defaultExportDir = path.join(projectRoot, "figma-html-loop-export");
const imageCacheDir = path.join(cacheRoot, "images");
const svgCacheDir = path.join(cacheRoot, "svgs");
const helperVersion = "roundtrip-1.4";

let latestSelection = null;
let pendingPatch = null;
let lastApplied = null;
let latestCapture = null;
// Active verify render job: the plugin polls for the Figma-side PNG, the
// exported page polls for the HTML-side PNG; verify compares the two.
let renderJob = null;

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 25 * 1024 * 1024) {
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body.trim()) return resolve(null);
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON."));
      }
    });
    req.on("error", reject);
  });
}

function send(res, status, data, contentType = "application/json") {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  if (contentType === "application/json") res.end(JSON.stringify(data, null, 2));
  else res.end(data);
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttc": "font/collection",
  };
  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, {
      "Content-Type": types[ext] || "application/octet-stream",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(data);
  } catch {
    send(res, 404, { ok: false, message: "File not found." });
  }
}

function safeId(id) {
  return String(id || "node").replace(/[^a-zA-Z0-9_-]/g, "_");
}

function escHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escAttr(value) {
  return escHtml(value).replace(/'/g, "&#39;");
}

function textValue(text) {
  if (text == null) return "";
  if (typeof text === "string") return text;
  if (typeof text.characters === "string") return text.characters;
  return "";
}

function rgbToCss(fill) {
  if (!fill || fill.type !== "SOLID" || !fill.color) return null;
  const r = Math.round((fill.color.r || 0) * 255);
  const g = Math.round((fill.color.g || 0) * 255);
  const b = Math.round((fill.color.b || 0) * 255);
  const a = fill.color.a == null ? 1 : Number(fill.color.a);
  return a >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${Number(a.toFixed(3))})`;
}

function cssColorToFigma(value) {
  const raw = String(value || "").trim();
  if (!raw || raw === "transparent" || raw === "none") return raw === "transparent" ? { r: 0, g: 0, b: 0, a: 0 } : null;
  let m = raw.match(/^#([0-9a-f]{8})$/i);
  if (m) {
    const n = parseInt(m[1], 16);
    return { r: ((n >>> 24) & 255) / 255, g: ((n >>> 16) & 255) / 255, b: ((n >>> 8) & 255) / 255, a: (n & 255) / 255 };
  }
  m = raw.match(/^#([0-9a-f]{6})$/i);
  if (m) {
    const n = parseInt(m[1], 16);
    return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255, a: 1 };
  }
  m = raw.match(/^#([0-9a-f]{3})$/i);
  if (m) {
    const s = m[1];
    const r = parseInt(s[0] + s[0], 16), g = parseInt(s[1] + s[1], 16), b = parseInt(s[2] + s[2], 16);
    return { r: r / 255, g: g / 255, b: b / 255, a: 1 };
  }
  m = raw.match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    const parts = m[1].split(/[,/]/).map((x) => x.trim()).filter(Boolean);
    if (parts.length >= 3) {
      return {
        r: Math.max(0, Math.min(255, Number(parts[0]))) / 255,
        g: Math.max(0, Math.min(255, Number(parts[1]))) / 255,
        b: Math.max(0, Math.min(255, Number(parts[2]))) / 255,
        a: parts[3] == null ? 1 : Math.max(0, Math.min(1, Number(parts[3])))
      };
    }
  }
  return null;
}

function nodeCss(node, root) {
  const css = [];
  const x = Math.round(Number(node.x || 0));
  const y = Math.round(Number(node.y || 0));
  const w = Math.max(0, Math.round(Number(node.width || 0)));
  const h = Math.max(0, Math.round(Number(node.height || 0)));
  css.push(`position:absolute`, `left:${x}px`, `top:${y}px`, `width:${w}px`, `height:${h}px`, `box-sizing:border-box`);
  if (node.type === "TEXT") css.push(`white-space:pre-wrap`, `display:flex`, `align-items:flex-start`);
  if (node.style) {
    const fill = rgbToCss(node.style.fill);
    if (fill && node.type !== "TEXT") css.push(`background:${fill}`);
    if (fill && node.type === "TEXT") css.push(`color:${fill}`);
    if (node.style.strokeColor) css.push(`border:${Math.max(1, Number(node.style.strokeWeight || 1))}px solid ${rgbToCss(node.style.strokeColor) || "transparent"}`);
    if (node.style.cornerRadius) css.push(`border-radius:${Math.round(Number(node.style.cornerRadius))}px`);
    if (node.style.opacity != null && node.style.opacity !== 1) css.push(`opacity:${Number(node.style.opacity)}`);
    if (node.style.fontSize) css.push(`font-size:${Math.round(Number(node.style.fontSize))}px`);
    if (node.style.fontFamily) css.push(`font-family:${JSON.stringify(String(node.style.fontFamily))}, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`);
    if (node.style.fontWeight) css.push(`font-weight:${Number(node.style.fontWeight)}`);
    if (node.style.lineHeightPx) css.push(`line-height:${Math.round(Number(node.style.lineHeightPx))}px`);
  }
  if (node.children && node.children.length && node.type !== "TEXT") css.push(`overflow:${node.clipsContent ? "hidden" : "visible"}`);
  return css.join(";") + ";";
}

function flatten(nodes, out = []) {
  for (const node of nodes || []) {
    out.push(node);
    flatten(node.children || [], out);
  }
  return out;
}

function renderNode(node, cssRules, manifestNodes, root) {
  const cls = `node-${safeId(node.id)}`;
  const plainText = textValue(node.text);
  cssRules.push(`.${cls}{${nodeCss(node, root)}}`);
  manifestNodes[node.id] = {
    id: node.id,
    name: node.name || "",
    type: node.type || "",
    selector: `[data-figma-id="${node.id}"]`,
    className: cls,
    text: plainText,
    x: node.x || 0,
    y: node.y || 0,
    width: node.width || 0,
    height: node.height || 0,
    style: node.style || {}
  };
  const attrs = `data-figma-id="${escAttr(node.id)}" data-figma-type="${escAttr(node.type)}" data-figma-name="${escAttr(node.name || "")}"`;
  if (node.type === "TEXT") {
    return `<div ${attrs} class="figma-node ${cls}">${escHtml(plainText)}</div>`;
  }
  const children = (node.children || []).map((child) => renderNode(child, cssRules, manifestNodes, root)).join("\n");
  return `<div ${attrs} class="figma-node ${cls}">\n${children}\n</div>`;
}

// Max right/bottom edge of any visible node, relative to the composition
// origin. Used to detect scrollable screens whose content extends past the
// root frame (clipsContent would hide it in the browser preview entirely).
function compositionContentExtent(composition) {
  const origin = composition && composition.absOrigin ? composition.absOrigin : { x: 0, y: 0 };
  const ox = Number(origin.x) || 0;
  const oy = Number(origin.y) || 0;
  let maxRight = 0;
  let maxBottom = 0;
  (function walk(nodes) {
    for (const node of nodes || []) {
      if (!node || node.visible === false) continue;
      const M = Array.isArray(node.absoluteTransform) ? node.absoluteTransform : null;
      if (M && M[0] && M[1] && typeof M[0][2] === "number" && typeof M[1][2] === "number") {
        maxRight = Math.max(maxRight, M[0][2] - ox + (Number(node.width) || 0));
        maxBottom = Math.max(maxBottom, M[1][2] - oy + (Number(node.height) || 0));
      }
      walk(node.children);
    }
  })(composition && composition.children);
  return { maxRight: Math.ceil(maxRight), maxBottom: Math.ceil(maxBottom) };
}

// When content extends below the root frame, grow the page wrapper and
// un-clip the root frames so the full screen is visible and scrollable at
// the page level. Node rects are untouched, so diff geometry stays stable
// (a scrollable node container would shift child rects and pollute diffs).
function longScreenCss(session, height, rootSelectors) {
  const extent = compositionContentExtent(session.composition);
  if (!(extent.maxBottom > height + 4)) return [];
  const rules = [
    `.figma-export{height:${extent.maxBottom}px;}`,
    // The engine base CSS locks html/body to overflow:hidden; unlock page
    // scrolling so the grown wrapper is actually reachable.
    "html,body{overflow:auto !important;}"
  ];
  for (const selector of rootSelectors) {
    rules.push(`.figma-export ${selector}{overflow:visible !important;}`);
  }
  return rules;
}

function buildExport(session) {
  if (!session.composition || !Array.isArray(session.composition.children)) {
    throw new Error("The Figma plugin sent only a selection summary, not the full layer tree. Re-import the plugin manifest, reopen the plugin, click Export Selection again, then retry export.");
  }
  const composition = session.composition;
  const roots = Array.isArray(composition.children) ? composition.children : [];
  if (!roots.length) throw new Error("No exported Figma nodes found.");
  const bounds = composition.bounds || roots[0] || { width: 800, height: 600 };
  const cssRules = [
    "html,body{margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;}",
    `.figma-export{position:relative;width:${Math.ceil(bounds.width || 800)}px;height:${Math.ceil(bounds.height || 600)}px;background:transparent;overflow:visible;}`,
    ".figma-node{box-sizing:border-box;}",
    ...longScreenCss(session, Math.ceil(bounds.height || 600), roots.map((n) => `> [data-figma-id="${n.id}"]`))
  ];
  const manifestNodes = {};
  const body = roots.map((root) => renderNode(root, cssRules, manifestNodes, root)).join("\n");
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Figma HTML Loop Export</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <main class="figma-export" data-loop-session="${escAttr(session.sessionId)}">
${body}
    </main>
  </body>
</html>
`;
  const css = cssRules.join("\n");
  const manifest = {
    schemaVersion: "0.1.0",
    exportedAt: new Date().toISOString(),
    sessionId: session.sessionId,
    page: session.page || null,
    bounds,
    rootIds: roots.map((n) => n.id),
    nodes: manifestNodes
  };
  return { html, css, manifest };
}

async function buildBridgeEngineExport(session) {
  const entry = path.join(bridgeEngineDist, "index.js");
  if (!fs.existsSync(entry)) {
    throw new Error("bridge-engine is not built yet.");
  }
  // A long-lived helper must not serve a stale engine after `npm run build`:
  // drop cached dist modules so every export loads the current build.
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(bridgeEngineDist)) delete require.cache[key];
  }
  const engine = require(entry);
  if (!engine || typeof engine.figmaSelectionToHtml !== "function") {
    throw new Error("bridge-engine does not expose figmaSelectionToHtml.");
  }
  if (!session.composition || !Array.isArray(session.composition.children)) {
    throw new Error("The Figma plugin did not send a full composition.");
  }
  const result = await engine.figmaSelectionToHtml({
    composition: session.composition,
    sessionId: session.sessionId,
    assetUrlProvider: (id, type) => {
      if (type === "image") return `images/${id}.png`;
      if (type === "svg") return `svgs/${id}`;
      return String(id);
    }
  });
  const width = Math.ceil(Number(result.baseWidth || session.composition?.bounds?.width || 800));
  const height = Math.ceil(Number(result.baseHeight || session.composition?.bounds?.height || 600));
  const bodyHtml = `<div class="figma-export" data-loop-session="${escAttr(session.sessionId)}">\n${result.bodyHtml}\n</div>`;
  const rootIds = Array.isArray(result.manifest && result.manifest.rootIds) ? result.manifest.rootIds : [];
  const shellCss = [
    `.figma-export{position:relative;width:${width}px;height:${height}px;overflow:visible;background:transparent;}`,
    `.figma-export>.content-layer{position:relative;width:${width}px;height:${height}px;}`,
    ...longScreenCss(session, height, rootIds.map((id) => `[data-figma-id="${id}"]`))
  ].join("\n");
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Figma HTML Loop Export</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
${bodyHtml}
  </body>
</html>
`;
  return {
    html,
    css: `${shellCss}\n${result.cssText}`,
    manifest: { ...result.manifest, assets: result.assets || {} },
    engine: "bridge-engine"
  };
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function validAssetId(id) {
  return typeof id === "string" && /^[a-zA-Z0-9_-]+$/.test(id);
}

function listMissingAssets(ids, dir, ext) {
  return (Array.isArray(ids) ? ids : [])
    .filter(validAssetId)
    .filter((id) => !fs.existsSync(path.join(dir, `${id}.${ext}`)));
}

function saveImageBatch(items) {
  ensureDir(imageCacheDir);
  let saved = 0;
  const failed = [];
  for (const item of Array.isArray(items) ? items : []) {
    try {
      if (!validAssetId(item && item.id) || typeof item.data !== "string") throw new Error("Invalid image item.");
      fs.writeFileSync(path.join(imageCacheDir, `${item.id}.png`), Buffer.from(item.data, "base64"));
      saved += 1;
    } catch (error) {
      failed.push({ id: String(item && item.id || ""), error: error.message });
    }
  }
  return { saved, failed };
}

function saveSvgBatch(items) {
  ensureDir(svgCacheDir);
  let saved = 0;
  const failed = [];
  for (const item of Array.isArray(items) ? items : []) {
    try {
      if (!validAssetId(item && item.id) || typeof item.data !== "string") throw new Error("Invalid SVG item.");
      fs.writeFileSync(path.join(svgCacheDir, `${item.id}.svg`), item.data, "utf8");
      saved += 1;
    } catch (error) {
      failed.push({ id: String(item && item.id || ""), error: error.message });
    }
  }
  return { saved, failed };
}

function copyAssetFiles(outDir, manifest) {
  const assets = manifest && manifest.assets ? manifest.assets : {};
  const images = Array.isArray(assets.images) ? assets.images : [];
  const svgs = Array.isArray(assets.svgs) ? assets.svgs : [];
  if (images.length) ensureDir(path.join(outDir, "images"));
  if (svgs.length) ensureDir(path.join(outDir, "svgs"));
  for (const id of images) {
    if (!validAssetId(id)) continue;
    const src = path.join(imageCacheDir, `${id}.png`);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(outDir, "images", `${id}.png`));
  }
  for (const file of svgs) {
    const id = String(file || "").replace(/\.svg$/i, "");
    if (!validAssetId(id)) continue;
    const src = path.join(svgCacheDir, `${id}.svg`);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(outDir, "svgs", `${id}.svg`));
  }
}

function writeExport(outDir, bundle) {
  ensureDir(outDir);
  fs.writeFileSync(path.join(outDir, "index.html"), injectCaptureClient(bundle.html), "utf8");
  fs.writeFileSync(path.join(outDir, "styles.css"), bundle.css, "utf8");
  fs.writeFileSync(path.join(outDir, "loop-manifest.json"), JSON.stringify(bundle.manifest, null, 2), "utf8");
  copyAssetFiles(outDir, bundle.manifest);
  bundle.fonts = packageFontsForExport(outDir, bundle.manifest);
}

const EXPORT_ARCHIVE_DIR = "_archive";

function slugifyName(name) {
  return String(name || "")
    .trim()
    .replace(/[\/\\?%*:|"<>\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "export";
}

function exportStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Prefer the selected frame's name, fall back to the Figma page name.
function exportDisplayName(session) {
  const roots = session && session.composition && Array.isArray(session.composition.children) ? session.composition.children : [];
  const rootName = roots.length && roots[0] && roots[0].name ? roots[0].name : "";
  const pageName = session && session.page && session.page.name ? session.page.name : "";
  return rootName || pageName || "export";
}

function archiveUrl(slug) {
  return `http://localhost:${port}/export/${EXPORT_ARCHIVE_DIR}/${encodeURIComponent(slug)}/index.html`;
}

// Save a self-contained, timestamped copy of the just-written export under
// <outDir>/_archive/<stamp>__<name>/ so a later export never overwrites an earlier
// one. The main outDir stays the "current" export the reflow/capture flow points at.
function archiveExport(outDir, session) {
  try {
    const name = exportDisplayName(session);
    const slug = `${exportStamp()}__${slugifyName(name)}`;
    const dest = path.join(outDir, EXPORT_ARCHIVE_DIR, slug);
    ensureDir(dest);
    for (const entry of fs.readdirSync(outDir)) {
      if (entry === EXPORT_ARCHIVE_DIR) continue;
      fs.cpSync(path.join(outDir, entry), path.join(dest, entry), { recursive: true });
    }
    return { ok: true, slug, name, dir: dest, url: archiveUrl(slug) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

// List saved export copies (newest first) from <outDir>/_archive.
function listExportArchives(outDir) {
  const root = path.join(outDir, EXPORT_ARCHIVE_DIR);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .filter((slug) => {
      try { return fs.statSync(path.join(root, slug)).isDirectory(); } catch { return false; }
    })
    .map((slug) => {
      let savedAt = null;
      try { savedAt = fs.statSync(path.join(root, slug)).mtime.toISOString(); } catch {}
      const name = slug.includes("__") ? slug.slice(slug.indexOf("__") + 2) : slug;
      return { slug, name, savedAt, dir: path.join(root, slug), url: archiveUrl(slug) };
    })
    .sort((a, b) => (b.slug < a.slug ? -1 : 1));
}

async function createExportBundle(session) {
  let bundle;
  let fallbackReason = null;
  try {
    bundle = await buildBridgeEngineExport(session);
  } catch (error) {
    fallbackReason = error.message;
    bundle = buildExport(session);
    bundle.engine = "prototype";
  }
  return { bundle, fallbackReason };
}

function openPath(filePath) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) return { ok: false, message: "File not found.", file: abs };
  const attempts = [];
  if (process.platform === "darwin") {
    attempts.push(["open", [abs]]);
    attempts.push(["open", ["-a", "Google Chrome", abs]]);
    attempts.push(["open", ["-a", "Safari", abs]]);
    attempts.push(["open", ["-a", "Microsoft Edge", abs]]);
  } else if (process.platform === "win32") {
    attempts.push(["cmd", ["/c", "start", "", abs]]);
  } else {
    attempts.push(["xdg-open", [abs]]);
  }

  const errors = [];
  for (const [command, args] of attempts) {
    try {
      const result = require("child_process").spawnSync(command, args, {
        encoding: "utf8",
        timeout: 5000,
      });
      if (result.status === 0) return { ok: true, file: abs, command: [command, ...args].join(" ") };
      errors.push((result.stderr || result.stdout || `exit ${result.status}`).trim());
    } catch (error) {
      errors.push(error.message);
    }
  }
  return { ok: false, message: errors.filter(Boolean).join(" | ") || "Could not open file.", file: abs };
}

async function exportSelection(session, outDir, opts = {}) {
  const { bundle, fallbackReason } = await createExportBundle(session);
  writeExport(outDir, bundle);
  // Keep a permanent, timestamped copy so re-exporting never overwrites earlier work.
  const archived = opts.archive === false ? null : archiveExport(outDir, session);
  const indexPath = path.join(outDir, "index.html");
  const opened = opts.open === true ? openPath(indexPath) : null;
  const url = `http://localhost:${port}/export/index.html`;
  const files = ["index.html", "styles.css", "loop-manifest.json"];
  if (bundle.fonts && bundle.fonts.embedded && bundle.fonts.embedded.length) files.push("fonts/");
  return {
    ok: true,
    outDir,
    indexPath,
    url,
    opened,
    engine: bundle.engine || "unknown",
    fallbackReason,
    files,
    fonts: bundle.fonts || null,
    manifest: bundle.manifest,
    archived,
  };
}

function readUrl(target) {
  return new Promise((resolve, reject) => {
    const u = new URL(target);
    const mod = u.protocol === "https:" ? https : http;
    mod.get(u, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve(body));
    }).on("error", reject);
  });
}

async function readTarget(target) {
  if (/^https?:\/\//i.test(target)) return readUrl(target);
  return fs.readFileSync(path.resolve(target), "utf8");
}

function parseCssRules(css) {
  const rules = {};
  const re = /\.([a-zA-Z0-9_-]+)\s*\{([^}]+)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const props = {};
    m[2].split(";").forEach((part) => {
      const idx = part.indexOf(":");
      if (idx > 0) props[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
    });
    rules[m[1]] = props;
  }
  return rules;
}

function stripTags(value) {
  return String(value || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

function captureClientScript() {
  return `
(function () {
  const scriptOrigin = document.currentScript && document.currentScript.src ? new URL(document.currentScript.src).origin : "";
  const helper = /^https?:/i.test(location.origin) ? location.origin : scriptOrigin;
  const sent = { value: "" };

  function round(n) {
    return Math.round(Number(n || 0) * 100) / 100;
  }

  function pickStyle(cs) {
    return {
      color: cs.color,
      backgroundColor: cs.backgroundColor,
      backgroundImage: cs.backgroundImage,
      opacity: cs.opacity,
      borderRadius: cs.borderRadius,
      borderTopLeftRadius: cs.borderTopLeftRadius,
      borderTopRightRadius: cs.borderTopRightRadius,
      borderBottomRightRadius: cs.borderBottomRightRadius,
      borderBottomLeftRadius: cs.borderBottomLeftRadius,
      borderWidth: cs.borderWidth,
      borderColor: cs.borderColor,
      borderStyle: cs.borderStyle,
      borderTopWidth: cs.borderTopWidth,
      borderTopStyle: cs.borderTopStyle,
      borderTopColor: cs.borderTopColor,
      boxShadow: cs.boxShadow,
      filter: cs.filter,
      backdropFilter: cs.backdropFilter || cs.webkitBackdropFilter,
      fontSize: cs.fontSize,
      fontFamily: cs.fontFamily,
      fontWeight: cs.fontWeight,
      fontStyle: cs.fontStyle,
      lineHeight: cs.lineHeight,
      letterSpacing: cs.letterSpacing,
      textAlign: cs.textAlign,
      textDecorationLine: cs.textDecorationLine || cs.textDecoration,
      visibility: cs.visibility,
      display: cs.display,
      objectFit: cs.objectFit,
      backgroundSize: cs.backgroundSize,
      backgroundPosition: cs.backgroundPosition,
      mixBlendMode: cs.mixBlendMode,
      transform: cs.transform,
      // Flex/grid layout → Figma auto-layout
      gridTemplateColumns: cs.gridTemplateColumns,
      flexDirection: cs.flexDirection,
      justifyContent: cs.justifyContent,
      alignItems: cs.alignItems,
      alignContent: cs.alignContent,
      flexWrap: cs.flexWrap,
      rowGap: cs.rowGap,
      columnGap: cs.columnGap,
      gap: cs.gap,
      paddingTop: cs.paddingTop,
      paddingRight: cs.paddingRight,
      paddingBottom: cs.paddingBottom,
      paddingLeft: cs.paddingLeft,
      position: cs.position,
      flexGrow: cs.flexGrow
    };
  }

  function imageFrom(el, cs) {
    if (el.tagName === "IMG") return el.currentSrc || el.src || "";
    const bg = cs.backgroundImage || "";
    const m = bg.match(/^url\\(["']?(.+?)["']?\\)$/);
    return m ? m[1] : "";
  }

  // Extract per-run rich-text segments (text + font/size/weight/italic/color)
  // by walking descendant text nodes; returns { text, segments }.
  function textSegments(el) {
    var full = "";
    var segs = [];
    try {
      var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
      var node;
      while ((node = walker.nextNode())) {
        var t = node.nodeValue || "";
        if (!t) continue;
        var parent = node.parentElement;
        if (!parent) continue;
        var pcs = getComputedStyle(parent);
        var start = full.length;
        full += t;
        segs.push({
          start: start,
          end: full.length,
          text: t,
          fontSize: round(parseFloat(pcs.fontSize) || 0),
          fontFamily: (pcs.fontFamily || "").split(",")[0].replace(/["']/g, "").trim(),
          fontWeight: Number(pcs.fontWeight) || 400,
          italic: (pcs.fontStyle || "").indexOf("italic") === 0,
          color: pcs.color
        });
      }
    } catch (_) {}
    // Only meaningful when there are 2+ runs with differing style.
    var distinct = segs.some(function (s) {
      return s.fontSize !== segs[0].fontSize || s.fontWeight !== segs[0].fontWeight || s.color !== segs[0].color || s.italic !== segs[0].italic;
    });
    return { text: full, segments: (segs.length >= 2 && distinct) ? segs : null, runs: segs };
  }

  function isSvg(el) {
    if (String(el.tagName).toLowerCase() === "svg") return true;
    if (el.tagName === "IMG" && /\\.svg(\\?|$)/i.test(el.getAttribute("src") || el.src || "")) return true;
    return false;
  }

  function svgFrom(el) {
    if (String(el.tagName).toLowerCase() === "svg") return { svgContent: el.outerHTML };
    if (el.tagName === "IMG") return { svgSrc: el.currentSrc || el.src || "" };
    return {};
  }

  // Synthesize a node for a visible ::before / ::after pseudo-element (which the
  // DOM can't expose directly), e.g. a tab's underline bar. Position is computed
  // from the pseudo's box relative to its element.
  function pseudoRect(el, which) {
    var pcs = getComputedStyle(el, which);
    if (!pcs) return null;
    var content = pcs.content;
    if (!content || content === "none" || content === "normal") return null;
    var w = parseFloat(pcs.width) || 0;
    var h = parseFloat(pcs.height) || 0;
    if (w <= 0 || h <= 0) return null;
    var bc = pcs.backgroundColor || "";
    var bi = pcs.backgroundImage || "";
    var hasBg = (bc && bc !== "rgba(0, 0, 0, 0)" && bc !== "transparent") || /gradient|url\\(/.test(bi);
    if (!hasBg) return null;
    var er = el.getBoundingClientRect();
    function resolve(v, base) {
      if (!v || v === "auto") return null;
      if (v.indexOf("%") >= 0) return parseFloat(v) / 100 * base;
      return parseFloat(v);
    }
    var left = resolve(pcs.left, er.width), right = resolve(pcs.right, er.width);
    var top = resolve(pcs.top, er.height), bottom = resolve(pcs.bottom, er.height);
    var tx = 0, ty = 0;
    var tm = (pcs.transform || "").match(/matrix\\(([^)]+)\\)/);
    if (tm) { var pr = tm[1].split(",").map(parseFloat); tx = pr[4] || 0; ty = pr[5] || 0; }
    var x = left != null ? left : (right != null ? er.width - right - w : 0);
    var y = top != null ? top : (bottom != null ? er.height - bottom - h : 0);
    return { x: x + tx, y: y + ty, width: w, height: h, backgroundColor: bc, backgroundImage: bi };
  }

  function inferKind(el, cs) {
    const marked = el.getAttribute("data-figma-create") || el.getAttribute("data-figma-new");
    if (marked) return String(marked).toLowerCase();
    if (isSvg(el)) return "svg";
    if (el.tagName === "IMG" || imageFrom(el, cs)) return "image";
    if ((el.innerText || "").trim() && !Array.from(el.children || []).some((child) => (child.innerText || "").trim())) return "text";
    return "rectangle";
  }

  function capture() {
    const root = document.querySelector(".figma-export") || document.body;
    const rootRect = root.getBoundingClientRect();
    // Preview pages may scale the whole export (e.g. fit-to-screen fullscreen
    // mode). Client rects are visual-space; divide by the root's uniform scale
    // factor so all captured geometry stays in design-space pixels. Computed
    // styles (font sizes, colors) are unaffected by transforms.
    const rootScale = root.offsetWidth > 0 ? rootRect.width / root.offsetWidth : 1;
    const norm = (v) => v / (rootScale || 1);
    const nodes = {};
    const created = [];
    const selector = "[data-figma-id], [data-figma-create], [data-figma-new]";
    document.querySelectorAll(selector).forEach((el, index) => {
      // Inline <svg data-figma-create="svg"> roots are SVGElement, not HTMLElement.
      if (!(el instanceof HTMLElement || el instanceof SVGElement)) return;
      const cs = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 && rect.height <= 0) return;
      const bounds = {
        x: round(norm(rect.left - rootRect.left) + root.scrollLeft),
        y: round(norm(rect.top - rootRect.top) + root.scrollTop),
        width: round(norm(rect.width)),
        height: round(norm(rect.height))
      };
      const style = pickStyle(cs);
      const imageSrc = imageFrom(el, cs);
      const kind = inferKind(el, cs);
      // Exported text nodes are div.text > span with no data-figma-type, and
      // inferKind calls them rectangles. Treat the export text class (and real
      // TEXT nodes) as text-kind so we read the span's actual color/size.
      const isTextKind = kind === "text"
        || (el.getAttribute("data-figma-type") || "").toUpperCase() === "TEXT"
        || / text /.test(" " + (el.getAttribute("class") || "") + " ");
      let text = (el.innerText || el.textContent || "").trim();
      let segments = null;
      if (isTextKind) {
        const seg = textSegments(el);
        if (seg.segments) { segments = seg.segments; text = seg.text; }
        // Text color/size come from the real text run (the styled span), not the
        // container div (which usually only carries an inherited color). Use the
        // first run that actually has non-whitespace text.
        const run = seg.runs && seg.runs.find(function (r) { return r && r.text && r.text.trim(); });
        if (run) {
          if (run.color) style.color = run.color;
          if (run.fontSize) style.fontSize = run.fontSize + "px";
          if (run.fontWeight) style.fontWeight = String(run.fontWeight);
          if (run.italic) style.fontStyle = "italic";
        }
      }
      const svg = kind === "svg" ? svgFrom(el) : {};
      const figmaId = el.getAttribute("data-figma-id");
      if (figmaId) {
        // Position relative to the nearest data-figma-id ancestor (= Figma parent),
        // matching Figma node x/y and the manifest parent-relative layout.
        // This is what the diff compares against; bounds stays root-absolute.
        let parentFigmaId = "";
        let local = { x: bounds.x, y: bounds.y };
        const pAnc = el.parentElement ? el.parentElement.closest("[data-figma-id]") : null;
        if (pAnc) {
          parentFigmaId = pAnc.getAttribute("data-figma-id") || "";
          const pr = pAnc.getBoundingClientRect();
          local = { x: round(norm(rect.left - pr.left)), y: round(norm(rect.top - pr.top)) };
        }
        nodes[figmaId] = {
          id: figmaId,
          type: el.getAttribute("data-figma-type") || "",
          name: el.getAttribute("data-figma-name") || "",
          text,
          segments,
          bounds,
          local,
          parentFigmaId,
          style,
          imageSrc
        };
        return;
      }
      const parent = el.parentElement && el.parentElement.closest("[data-figma-id]");
      // Nearest ancestor that is itself a captured "created" element, so new
      // elements can nest inside each other (a card containing an icon + label).
      let anc = el.parentElement;
      let parentCreateId = "";
      while (anc) {
        if (anc.__loopCreateId) { parentCreateId = anc.__loopCreateId; break; }
        anc = anc.parentElement;
      }
      const createId = el.getAttribute("data-figma-create-id") || ("html_" + Date.now().toString(36) + "_" + index);
      el.__loopCreateId = createId;
      created.push({
        createId,
        parentCreateId,
        parentId: parent ? parent.getAttribute("data-figma-id") : "",
        name: el.getAttribute("data-figma-name") || el.getAttribute("aria-label") || "HTML layer",
        kind,
        text,
        segments,
        svgContent: svg.svgContent,
        svgSrc: svg.svgSrc,
        bounds,
        style,
        imageSrc
      });

      // Synthesize visible ::before / ::after pseudo-elements as child rects
      // (e.g. an active tab's underline bar), nested under this element.
      if (kind === "frame") {
        ["::before", "::after"].forEach(function (which) {
          const pr = pseudoRect(el, which);
          if (!pr) return;
          created.push({
            createId: createId + (which === "::before" ? "_before" : "_after"),
            parentCreateId: createId,
            parentId: "",
            name: (el.getAttribute("data-figma-name") || "el") + which,
            kind: "rectangle",
            text: "",
            bounds: { x: bounds.x + pr.x, y: bounds.y + pr.y, width: pr.width, height: pr.height },
            style: {
              position: "absolute", // don't let an auto-layout parent reflow the pseudo bar
              backgroundColor: pr.backgroundColor,
              backgroundImage: pr.backgroundImage,
              borderRadius: getComputedStyle(el, which).borderRadius
            }
          });
        });

        // Auto-split: direct text nodes inside a created frame become their
        // own virtual text layers (measured via Range), so a "text + inline
        // box" mix keeps its loose text when the container becomes a frame,
        // without requiring hand-wrapped spans in the source HTML.
        let vi = 0;
        el.childNodes.forEach(function (tn) {
          if (tn.nodeType !== 3) return;
          const content = String(tn.textContent || "").trim();
          if (!content) return;
          const fontPx = parseFloat(cs.fontSize) || 0;
          const colorMatch = String(cs.color || "").match(/rgba?\(([^)]+)\)/);
          const colorParts = colorMatch ? colorMatch[1].split(",") : [];
          const alpha = colorParts.length >= 4 ? parseFloat(colorParts[3]) : 1;
          if (fontPx < 1 || alpha === 0) return; // hidden icon-font style text
          const range = document.createRange();
          range.selectNodeContents(tn);
          const r = range.getBoundingClientRect();
          if (!(r.width > 0.5 && r.height > 0.5)) return;
          created.push({
            createId: createId + "_t" + (vi++),
            parentCreateId: createId,
            parentId: "",
            name: content.slice(0, 12),
            kind: "text",
            text: content,
            segments: null,
            bounds: {
              x: round(norm(r.left - rootRect.left) + root.scrollLeft),
              y: round(norm(r.top - rootRect.top) + root.scrollTop),
              width: round(norm(r.width)),
              height: round(norm(r.height))
            },
            style: pickStyle(cs),
            imageSrc: ""
          });
        });
      }
    });
    return {
      ok: true,
      source: location.href,
      capturedAt: new Date().toISOString(),
      viewport: { width: window.innerWidth, height: window.innerHeight },
      nodes,
      created
    };
  }

  function sendCapture(useKeepalive) {
    try {
      const data = capture();
      const serialized = JSON.stringify(data);
      if (serialized === sent.value) return;
      sent.value = serialized;
      const opts = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: serialized
      };
      // keepalive fetch bodies are capped at 64KB by the browser; large captures
      // (many elements) exceed that and get silently dropped. Only use keepalive
      // for the unload send, and only when the body is small enough.
      if (useKeepalive && serialized.length < 60000) opts.keepalive = true;
      fetch(helper + "/api/capture/dom", opts).catch(function () {});
    } catch (_) {}
  }

  let timer = null;
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(function () { sendCapture(); }, 250);
  }

  window.addEventListener("load", function () {
    sendCapture();
    setTimeout(function () { sendCapture(); }, 600);
    setTimeout(function () { sendCapture(); }, 1600);
  });
  window.addEventListener("beforeunload", function () { sendCapture(true); });
  new MutationObserver(schedule).observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true
  });

  // ---- verify support: render this page to PNG on helper request ----
  var htmlToImageReady = null;
  function loadHtmlToImage() {
    if (window.htmlToImage) return Promise.resolve();
    if (htmlToImageReady) return htmlToImageReady;
    htmlToImageReady = new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = helper + "/libs/html-to-image.min.js";
      s.onload = function () { resolve(); };
      s.onerror = function () { htmlToImageReady = null; reject(new Error("html-to-image failed to load")); };
      document.head.appendChild(s);
    });
    return htmlToImageReady;
  }
  var renderBusy = false;
  function pollRenderRequest() {
    if (renderBusy || document.hidden) return;
    fetch(helper + "/api/render/html-pending", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var job = data && data.job;
        if (!job) return;
        renderBusy = true;
        return loadHtmlToImage().then(function () {
          var el = (job.selector && document.querySelector(job.selector))
            || document.querySelector(".figma-export")
            || document.body;
          return window.htmlToImage.toPng(el, { pixelRatio: 1 });
        }).then(function (dataUrl) {
          return fetch(helper + "/api/render/html", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: job.id, dataUrl: dataUrl })
          });
        }).then(function () { renderBusy = false; }, function () { renderBusy = false; });
      })
      .catch(function () { renderBusy = false; });
  }
  setInterval(pollRenderRequest, 2000);
})();
`;
}

function injectCaptureClient(html) {
  const script = `<script src="http://localhost:${port}/figma-html-loop-capture.js"></script>`;
  if (html.includes("/figma-html-loop-capture.js")) return html;
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `  ${script}\n  </body>`);
  return `${html}\n${script}\n`;
}

function captureFromHtml(html, cssText = "") {
  const cssRules = parseCssRules(cssText);
  const nodes = {};
  const re = /<([a-z0-9-]+)\b([^>]*data-figma-id="([^"]+)"[^>]*)>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attr = m[2];
    const id = m[3];
    const classMatch = attr.match(/\bclass="([^"]+)"/);
    const classes = classMatch ? classMatch[1].split(/\s+/) : [];
    const style = {};
    for (const cls of classes) Object.assign(style, cssRules[cls] || {});
    const inline = attr.match(/\bstyle="([^"]+)"/);
    if (inline) {
      inline[1].split(";").forEach((part) => {
        const idx = part.indexOf(":");
        if (idx > 0) style[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
      });
    }
    const contentStart = re.lastIndex;
    const closeTag = `</${m[1]}>`;
    const closeIndex = html.indexOf(closeTag, contentStart);
    const inner = closeIndex >= 0 ? html.slice(contentStart, closeIndex) : "";
    nodes[id] = { id, text: stripTags(inner), style };
  }
  return { capturedAt: new Date().toISOString(), nodes };
}

function px(value) {
  const m = String(value || "").match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : undefined;
}

function alphaFromCss(value) {
  const fill = cssColorToFigma(value);
  if (!fill) return null;
  return fill.a == null ? 1 : fill.a;
}

function cssUrlToLocalPath(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    if (/^file:\/\//i.test(raw)) {
      return decodeURIComponent(new URL(raw).pathname);
    }
    if (/^https?:\/\//i.test(raw)) {
      const u = new URL(raw);
      if (u.hostname !== "localhost" && u.hostname !== "127.0.0.1") return "";
      return path.join(defaultExportDir, decodeURIComponent(u.pathname.replace(/^\/export\/?/, "")));
    }
  } catch (_) {}
  if (/^data:/i.test(raw)) return raw;
  if (path.isAbsolute(raw)) return raw;
  return path.resolve(defaultExportDir, raw.replace(/^\.?\//, ""));
}

function fnv1a(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(36);
}

// Save a captured image into the helper cache and return a content-hash id, so
// patches reference the image by id instead of inlining a big base64 blob.
function cacheImageFromCapture(src) {
  const b64 = imageBase64FromCapture(src);
  if (!b64) return null;
  const id = "img_" + fnv1a(b64);
  ensureDir(imageCacheDir);
  const file = path.join(imageCacheDir, id + ".png");
  if (!fs.existsSync(file)) {
    try { fs.writeFileSync(file, Buffer.from(b64, "base64")); } catch (_) { return null; }
  }
  return id;
}

// Decode an SVG referenced from CSS background-image: data URI (base64 or
// URL-encoded) or a local .svg file. Returns "" for anything else.
function svgTextFromImageSrc(src) {
  const raw = String(src || "").trim();
  if (!raw) return "";
  let m = raw.match(/^data:image\/svg\+xml;base64,(.*)$/i);
  if (m) {
    try { return Buffer.from(m[1], "base64").toString("utf8"); } catch (_) { return ""; }
  }
  m = raw.match(/^data:image\/svg\+xml[^,]*,(.*)$/i);
  if (m) {
    try { return decodeURIComponent(m[1]); } catch (_) { return m[1]; }
  }
  const localPath = cssUrlToLocalPath(raw);
  if (localPath && /\.svg$/i.test(localPath) && fs.existsSync(localPath)) {
    try { return fs.readFileSync(localPath, "utf8"); } catch (_) { return ""; }
  }
  return "";
}

// A CSS background SVG cannot become a Figma image fill (fills are raster
// only); recreate it as a vector child layer placed per background-size /
// background-position, keeping the container's own fill and radius.
function svgIconChildFromCapture(item, svgText) {
  const bounds = item && item.bounds ? item.bounds : {};
  const css = item && item.style ? item.style : {};
  const pw = Number(bounds.width) || 0;
  const ph = Number(bounds.height) || 0;
  let iw = pw, ih = ph;
  const sizeTokens = String(css.backgroundSize || "").match(/(-?\d+(?:\.\d+)?)px/g);
  if (sizeTokens && sizeTokens.length) {
    iw = parseFloat(sizeTokens[0]);
    ih = sizeTokens[1] != null ? parseFloat(sizeTokens[1]) : iw;
  }
  const place = (token, total, size) => {
    const t = String(token || "").trim();
    if (/%$/.test(t)) return ((total - size) * parseFloat(t)) / 100;
    if (/px$/i.test(t)) return parseFloat(t);
    return (total - size) / 2;
  };
  const pos = String(css.backgroundPosition || "").trim().split(/\s+/);
  return {
    action: "create",
    id: `${String(item.createId || item.id || "node")}_svgbg`,
    kind: "svg",
    name: `${item.name || "icon"} 图标`,
    text: "",
    svgContent: svgText,
    style: {
      x: Math.round(place(pos[0], pw, iw) * 100) / 100,
      y: Math.round(place(pos.length > 1 ? pos[1] : pos[0], ph, ih) * 100) / 100,
      width: Math.max(1, iw),
      height: Math.max(1, ih),
      absolutePos: true
    }
  };
}

function imageBase64FromCapture(src) {
  const raw = String(src || "").trim();
  if (!raw) return "";
  // Vectors are not raster fills — the svg path handles them (a base64 svg
  // slipped through here before and was cached as a broken "png").
  if (/^data:image\/svg\+xml/i.test(raw)) return "";
  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(raw)) return raw.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "");
  const localPath = cssUrlToLocalPath(raw);
  if (!localPath || !fs.existsSync(localPath)) return "";
  const ext = path.extname(localPath).toLowerCase();
  if (![".png", ".jpg", ".jpeg", ".gif"].includes(ext)) return "";
  return fs.readFileSync(localPath).toString("base64");
}

function manifestLayout(node) {
  return (node && node.layout) || node || {};
}

// Read SVG markup for a captured node: inline content, a data: URI, or a .svg file.
function svgContentFromCapture(item) {
  if (item && item.svgContent) return String(item.svgContent);
  const raw = String((item && item.svgSrc) || "").trim();
  if (!raw) return "";
  const dataMatch = raw.match(/^data:image\/svg\+xml(;base64)?,(.*)$/i);
  if (dataMatch) {
    return dataMatch[1] ? Buffer.from(dataMatch[2], "base64").toString("utf8") : decodeURIComponent(dataMatch[2]);
  }
  const localPath = cssUrlToLocalPath(raw);
  if (!localPath || !fs.existsSync(localPath)) return "";
  if (path.extname(localPath).toLowerCase() !== ".svg") return "";
  return fs.readFileSync(localPath, "utf8");
}

// Split a comma-separated CSS list without breaking inside parentheses (rgb(), gradients).
function splitTopLevel(value) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of String(value || "")) {
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// Pull out the first color token (rgb/rgba/#hex) and return {color, rest}.
function extractColorToken(part) {
  let color = null;
  let rest = part;
  const fn = part.match(/rgba?\([^)]*\)/i);
  if (fn) {
    color = fn[0];
    rest = part.replace(fn[0], " ");
  } else {
    const hex = part.match(/#[0-9a-f]{3,8}\b/i);
    if (hex) {
      color = hex[0];
      rest = part.replace(hex[0], " ");
    }
  }
  return { color, rest };
}

// Parse a CSS box-shadow into Figma-style effect descriptors.
function parseBoxShadow(value) {
  const raw = String(value || "").trim();
  if (!raw || raw === "none") return null;
  const effects = [];
  for (const part of splitTopLevel(raw)) {
    if (!part) continue;
    const inset = /\binset\b/i.test(part);
    const cleaned = part.replace(/\binset\b/i, " ");
    const { color, rest } = extractColorToken(cleaned);
    const nums = (rest.match(/-?\d+(?:\.\d+)?(?:px)?/gi) || []).map((n) => Number(String(n).replace(/px$/i, "")));
    if (nums.length < 2) continue;
    const fill = color ? cssColorToFigma(color) : { r: 0, g: 0, b: 0, a: 0.25 };
    effects.push({
      type: inset ? "INNER_SHADOW" : "DROP_SHADOW",
      x: nums[0] || 0,
      y: nums[1] || 0,
      blur: nums[2] || 0,
      spread: nums[3] || 0,
      color: fill || { r: 0, g: 0, b: 0, a: 0.25 }
    });
  }
  return effects.length ? effects : null;
}

// Convert a CSS linear-gradient direction keyword or angle into CSS degrees.
// Corner keywords ("to top right") depend on the box aspect ratio: the CSS
// gradient line points at the corner, which is only 45° in a square box.
// Without a box the legacy fixed diagonals are used.
function gradientAngleFromDirection(token, box) {
  const t = String(token || "").trim().toLowerCase();
  const deg = t.match(/^(-?\d+(?:\.\d+)?)deg$/);
  if (deg) return Number(deg[1]);
  const turn = t.match(/^(-?\d+(?:\.\d+)?)turn$/);
  if (turn) return Number(turn[1]) * 360;
  if (t.startsWith("to ")) {
    const dir = t.slice(3).trim().split(/\s+/).sort().join(" ");
    const side = { "top": 0, "right": 90, "bottom": 180, "left": 270 };
    if (side[dir] != null) return side[dir];
    const w = box && Number(box.width) > 0 ? Number(box.width) : 0;
    const h = box && Number(box.height) > 0 ? Number(box.height) : 0;
    const a = w && h ? Math.round((Math.atan2(w, h) * 180 / Math.PI) * 100) / 100 : 45;
    const corner = {
      "right top": a,
      "bottom right": 180 - a,
      "bottom left": 180 + a,
      "left top": 360 - a
    };
    if (corner[dir] != null) return corner[dir];
  }
  return null;
}

// Extract color stops from gradient argument parts (skips non-color args like
// shape/size/position/angle that may precede the stops in radial/conic).
// Positions: % always; deg/turn for conic (opts.angular); px against
// opts.axisPx when known. Unpositioned stops interpolate linearly between
// their nearest positioned neighbors (CSS behavior), first→0 and last→1.
function parseGradientStops(args, opts = {}) {
  const axisPx = Number(opts.axisPx) || 0;
  const angular = !!opts.angular;
  const entries = [];
  for (const part of args) {
    const { color, rest } = extractColorToken(part);
    if (!color) continue;
    const fill = cssColorToFigma(color);
    if (!fill) continue;
    let position = null;
    const pct = rest.match(/(-?\d+(?:\.\d+)?)%/);
    const degM = angular ? rest.match(/(-?\d+(?:\.\d+)?)deg/) : null;
    const turnM = angular ? rest.match(/(-?\d+(?:\.\d+)?)turn/) : null;
    const pxM = !angular && axisPx > 0 ? rest.match(/(-?\d+(?:\.\d+)?)px/) : null;
    if (pct) position = Number(pct[1]) / 100;
    else if (degM) position = Number(degM[1]) / 360;
    else if (turnM) position = Number(turnM[1]);
    else if (pxM) position = Number(pxM[1]) / axisPx;
    entries.push({ fill, position });
  }
  if (!entries.length) return [];
  if (entries[0].position == null) entries[0].position = 0;
  if (entries[entries.length - 1].position == null) entries[entries.length - 1].position = 1;
  let anchor = 0;
  for (let i = 1; i < entries.length; i++) {
    if (entries[i].position == null) continue;
    if (entries[i].position < entries[anchor].position) entries[i].position = entries[anchor].position;
    const gap = i - anchor;
    for (let j = 1; j < gap; j++) {
      entries[anchor + j].position = entries[anchor].position + ((entries[i].position - entries[anchor].position) * j) / gap;
    }
    anchor = i;
  }
  return entries.map((e) => ({
    position: Math.max(0, Math.min(1, e.position)),
    r: e.fill.r, g: e.fill.g, b: e.fill.b,
    a: e.fill.a == null ? 1 : e.fill.a
  }));
}

// "60%" / "left" / "center" → fraction of the box axis.
function positionFraction(token, fallback = 0.5) {
  const t = String(token || "").trim().toLowerCase();
  if (t === "left" || t === "top") return 0;
  if (t === "center") return 0.5;
  if (t === "right" || t === "bottom") return 1;
  const pct = t.match(/^(-?\d+(?:\.\d+)?)%$/);
  if (pct) return Number(pct[1]) / 100;
  return fallback;
}

// Default CSS radial size (farthest-corner) as x/y radius fractions.
function farthestCornerRadius(shape, center, box) {
  const w = box && Number(box.width) > 0 ? Number(box.width) : 0;
  const h = box && Number(box.height) > 0 ? Number(box.height) : 0;
  if (!w || !h) return null;
  const cx = center.x * w;
  const cy = center.y * h;
  const dx = Math.max(cx, w - cx);
  const dy = Math.max(cy, h - cy);
  if (shape === "circle") {
    const r = Math.sqrt(dx * dx + dy * dy);
    return { x: r / w, y: r / h };
  }
  // ellipse farthest-corner: side radii scaled to pass through the corner
  return { x: (dx * Math.SQRT2) / w, y: (dy * Math.SQRT2) / h };
}

// Parse ALL gradient layers of a CSS background-image value (top-level comma
// split, so multiple backgrounds parse independently). url() layers are
// skipped — images travel through the imageSrc path. CSS lists layers
// top-first; callers that build Figma fills must reverse (bottom-first).
function parseGradientLayers(value, box) {
  const out = [];
  for (const layer of splitTopLevel(String(value || "").trim())) {
    const m = layer.match(/^(repeating-)?(linear|radial|conic)-gradient\(/i);
    if (!m) continue;
    const kind = m[2].toLowerCase();
    // balanced-paren extraction so nested rgba(...) never truncates the body
    let i = m[0].length, depth = 1;
    while (i < layer.length && depth > 0) {
      if (layer[i] === "(") depth++;
      else if (layer[i] === ")") depth--;
      i++;
    }
    const args = splitTopLevel(layer.slice(m[0].length, i - 1));
    if (!args.length) continue;

    if (kind === "linear") {
      let angle = 180, start = 0;
      const first = args[0];
      const maybeAngle = gradientAngleFromDirection(first, box);
      if (maybeAngle != null && !extractColorToken(first).color) { angle = maybeAngle; start = 1; }
      // px stop positions project onto the CSS gradient line length
      const rad = (angle * Math.PI) / 180;
      const w = box && Number(box.width) > 0 ? Number(box.width) : 0;
      const h = box && Number(box.height) > 0 ? Number(box.height) : 0;
      const axisPx = w && h ? Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad)) : 0;
      const stops = parseGradientStops(args.slice(start), { axisPx });
      if (stops.length >= 2) out.push({ type: "GRADIENT_LINEAR", angle, stops });
      continue;
    }

    if (kind === "radial") {
      let start = 0;
      let shape = "ellipse";
      const center = { x: 0.5, y: 0.5 };
      let radius = null;
      const prelude = args[0] && !extractColorToken(args[0]).color ? args[0] : null;
      if (prelude) {
        start = 1;
        const atIdx = prelude.search(/\bat\b/i);
        const sizePart = (atIdx >= 0 ? prelude.slice(0, atIdx) : prelude).trim();
        const posPart = atIdx >= 0 ? prelude.slice(atIdx + 2).trim() : "";
        if (/\bcircle\b/i.test(sizePart)) shape = "circle";
        const lengths = sizePart.match(/(-?\d+(?:\.\d+)?)%/g);
        if (lengths && lengths.length >= 2) {
          radius = { x: Number(lengths[0].replace("%", "")) / 100, y: Number(lengths[1].replace("%", "")) / 100 };
        } else if (lengths && lengths.length === 1 && shape === "circle") {
          const r = Number(lengths[0].replace("%", "")) / 100;
          radius = { x: r, y: r };
        }
        if (posPart) {
          const tokens = posPart.split(/\s+/);
          center.x = positionFraction(tokens[0], 0.5);
          center.y = positionFraction(tokens[1] != null ? tokens[1] : "center", 0.5);
        }
      }
      if (!radius) radius = farthestCornerRadius(shape, center, box);
      const w = box && Number(box.width) > 0 ? Number(box.width) : 0;
      const axisPx = radius && w ? radius.x * w : 0;
      const stops = parseGradientStops(args.slice(start), { axisPx });
      if (stops.length >= 2) {
        const g = { type: "GRADIENT_RADIAL", stops, center, shape };
        if (radius) g.radius = radius;
        out.push(g);
      }
      continue;
    }

    // conic
    let start = 0;
    let from = 0;
    const center = { x: 0.5, y: 0.5 };
    const prelude = args[0] && !extractColorToken(args[0]).color ? args[0] : null;
    if (prelude && /\bfrom\b|\bat\b/i.test(prelude)) {
      start = 1;
      const fromM = prelude.match(/from\s+(-?\d+(?:\.\d+)?)(deg|turn)/i);
      if (fromM) from = fromM[2].toLowerCase() === "turn" ? Number(fromM[1]) * 360 : Number(fromM[1]);
      const atM = prelude.match(/\bat\s+(.+)$/i);
      if (atM) {
        const tokens = atM[1].trim().split(/\s+/);
        center.x = positionFraction(tokens[0], 0.5);
        center.y = positionFraction(tokens[1] != null ? tokens[1] : "center", 0.5);
      }
    }
    const stops = parseGradientStops(args.slice(start), { angular: true });
    if (stops.length >= 2) out.push({ type: "GRADIENT_ANGULAR", stops, center, from });
  }
  return out;
}

// Parse the first gradient of a CSS background-image value.
// { type:'GRADIENT_LINEAR'|'GRADIENT_RADIAL'|'GRADIENT_ANGULAR', angle?, stops, center?, radius?, from? }
function parseGradient(value, box) {
  const layers = parseGradientLayers(value, box);
  return layers.length ? layers[0] : null;
}

// Back-compat: linear-only helper used by older call sites.
function parseLinearGradient(value) {
  const g = parseGradient(value);
  return g && g.type === "GRADIENT_LINEAR" ? { angle: g.angle, stops: g.stops } : null;
}

// Parse a CSS `filter` string for drop-shadow(...) → Figma DROP_SHADOW effects.
// Balanced-paren scan so a nested rgba(...) color isn't truncated.
function parseFilterEffects(value) {
  const raw = String(value || "");
  if (!raw || raw === "none") return null;
  const out = [];
  const token = "drop-shadow(";
  const lower = raw.toLowerCase();
  let idx = 0;
  while ((idx = lower.indexOf(token, idx)) !== -1) {
    let i = idx + token.length, depth = 1;
    while (i < raw.length && depth > 0) {
      if (raw[i] === "(") depth++;
      else if (raw[i] === ")") depth--;
      i++;
    }
    const inner = raw.slice(idx + token.length, i - 1);
    idx = i;
    const { color, rest } = extractColorToken(inner);
    const nums = (rest.match(/-?\d+(?:\.\d+)?(?:px)?/gi) || []).map((n) => Number(String(n).replace(/px$/i, "")));
    if (nums.length < 2) continue;
    const fill = color ? cssColorToFigma(color) : { r: 0, g: 0, b: 0, a: 0.25 };
    out.push({ type: "DROP_SHADOW", x: nums[0] || 0, y: nums[1] || 0, blur: nums[2] || 0, spread: 0, color: fill || { r: 0, g: 0, b: 0, a: 0.25 } });
  }
  return out.length ? out : null;
}

// Parse `backdrop-filter: blur(Npx)` → Figma BACKGROUND_BLUR effect.
function parseBackdropBlur(value) {
  const m = String(value || "").match(/blur\(\s*(-?\d+(?:\.\d+)?)px\s*\)/i);
  if (!m) return null;
  return { type: "BACKGROUND_BLUR", blur: Math.max(0, Number(m[1]) || 0) };
}

// Extract per-corner radii; returns [tl,tr,br,bl] or null when uniform.
function perCornerRadii(css) {
  const g = (k1, k2) => px(css[k1] != null ? css[k1] : css[k2]);
  const tl = g("borderTopLeftRadius", "border-top-left-radius");
  const tr = g("borderTopRightRadius", "border-top-right-radius");
  const br = g("borderBottomRightRadius", "border-bottom-right-radius");
  const bl = g("borderBottomLeftRadius", "border-bottom-left-radius");
  const vals = [tl, tr, br, bl];
  if (vals.some((v) => v === undefined)) return null;
  if (vals.every((v) => v === vals[0])) return null; // uniform → handled elsewhere
  return vals.map((v) => Math.max(0, v));
}

function mapJustify(v) {
  return ({ "flex-start": "MIN", "start": "MIN", "left": "MIN", "center": "CENTER",
    "flex-end": "MAX", "end": "MAX", "right": "MAX",
    "space-between": "SPACE_BETWEEN", "space-around": "SPACE_BETWEEN", "space-evenly": "SPACE_BETWEEN"
  })[String(v || "").trim()] || "MIN";
}
function mapAlign(v) {
  return ({ "flex-start": "MIN", "start": "MIN", "center": "CENTER",
    "flex-end": "MAX", "end": "MAX", "stretch": "MIN", "baseline": "MIN"
  })[String(v || "").trim()] || "MIN";
}

// Infer hug (AUTO) sizing for a created auto-layout frame by comparing the
// container's captured size with its flow children's extent. Wrapping
// containers are skipped upstream (their main-axis math depends on line
// breaking). A space-between container never hugs its main axis because the
// children's sum is smaller than the container — the check naturally fails.
function inferAutoLayoutSizing(al, style, childSpecs) {
  const flow = childSpecs.filter((c) => c && c.style && !c.style.absolutePos);
  if (!flow.length) return;
  const isRow = al.mode === "HORIZONTAL";
  const mainSize = (s) => Number(isRow ? s.style.width : s.style.height) || 0;
  const crossSize = (s) => Number(isRow ? s.style.height : s.style.width) || 0;
  const mainPadding = isRow
    ? (al.paddingLeft || 0) + (al.paddingRight || 0)
    : (al.paddingTop || 0) + (al.paddingBottom || 0);
  const crossPadding = isRow
    ? (al.paddingTop || 0) + (al.paddingBottom || 0)
    : (al.paddingLeft || 0) + (al.paddingRight || 0);
  const mainSum = flow.reduce((acc, s) => acc + mainSize(s), 0)
    + Math.max(0, flow.length - 1) * (Number(al.itemSpacing) || 0)
    + mainPadding;
  const crossMax = Math.max(...flow.map(crossSize)) + crossPadding;
  const containerMain = Number(isRow ? style.width : style.height) || 0;
  const containerCross = Number(isRow ? style.height : style.width) || 0;
  if (Math.abs(mainSum - containerMain) <= 2) al.primaryAxisSizingMode = "AUTO";
  if (Math.abs(crossMax - containerCross) <= 2) al.counterAxisSizingMode = "AUTO";
}

// `margin: auto` centering is invisible in computed styles; detect it from
// geometry instead: when every flow child sits centered on the cross axis,
// upgrade the container's counter alignment. Full-width children are
// trivially centered, so mixed sheets (grab bar + full-width sections) work.
function inferCounterAxisCenter(al, style, childSpecs) {
  if (String(al.counterAxisAlignItems || "MIN") !== "MIN" || al.counterStretch) return;
  const flow = childSpecs.filter((c) => c && c.style && !c.style.absolutePos);
  if (!flow.length) return;
  const isRow = al.mode === "HORIZONTAL";
  const parentSize = Number(isRow ? style.height : style.width) || 0;
  if (!parentSize) return;
  const centered = flow.every((c) => {
    const off = Number(isRow ? c.style.y : c.style.x) || 0;
    const size = Number(isRow ? c.style.height : c.style.width) || 0;
    return Math.abs(off + size / 2 - parentSize / 2) <= 2;
  });
  if (centered) al.counterAxisAlignItems = "CENTER";
}

// A CSS `margin-left: auto` tail (chevron/icon pushed to the row end) has no
// Figma equivalent; emulate it by growing the preceding child to fill the gap.
function inferTailGrow(al, style, childSpecs) {
  if (al.mode !== "HORIZONTAL" || al.layoutWrap === "WRAP") return;
  const flow = childSpecs.filter((c) => c && c.style && !c.style.absolutePos);
  if (flow.length < 2) return;
  const last = flow[flow.length - 1];
  const prev = flow[flow.length - 2];
  const containerW = Number(style.width) || 0;
  if (!containerW) return;
  const lastRight = (Number(last.style.x) || 0) + (Number(last.style.width) || 0);
  const flushRight = Math.abs(containerW - (Number(al.paddingRight) || 0) - lastRight) <= 2;
  const gap = (Number(last.style.x) || 0) - ((Number(prev.style.x) || 0) + (Number(prev.style.width) || 0));
  if (flushRight && gap > (Number(al.itemSpacing) || 0) + 4) prev.style.layoutGrow = 1;
}

// A simple CSS grid (2+ resolved column tracks) maps to a wrapping
// horizontal auto-layout: column-gap → itemSpacing, row-gap → cross spacing.
// Children keep their captured sizes, so the visual grid survives even
// though Figma has no real grid primitive.
function gridToAutoLayout(css) {
  const tracks = String(css.gridTemplateColumns || "").trim().split(/\s+/)
    .map((t) => px(t))
    .filter((v) => Number.isFinite(v));
  if (tracks.length < 2) return null;
  return {
    mode: "HORIZONTAL",
    itemSpacing: px(css.columnGap) || px(css.gap) || 0,
    paddingTop: px(css.paddingTop) || 0,
    paddingRight: px(css.paddingRight) || 0,
    paddingBottom: px(css.paddingBottom) || 0,
    paddingLeft: px(css.paddingLeft) || 0,
    primaryAxisAlignItems: "MIN",
    counterAxisAlignItems: "MIN",
    layoutWrap: "WRAP",
    counterAxisSpacing: px(css.rowGap) || px(css.gap) || 0,
  };
}

// Translate CSS flexbox into a Figma auto-layout descriptor, or null if not flex.
function cssToAutoLayout(css) {
  const disp = String((css && css.display) || "").trim();
  if (disp === "grid" || disp === "inline-grid") return gridToAutoLayout(css);
  if (disp !== "flex" && disp !== "inline-flex") return null;
  const dir = String(css.flexDirection || "row").trim();
  const isColumn = dir.indexOf("column") === 0;
  const reversed = dir.indexOf("-reverse") !== -1;
  const wrapRaw = String(css.flexWrap || "").trim();
  const wrap = wrapRaw.indexOf("wrap") === 0; // "wrap" or "wrap-reverse", not "nowrap"

  const rowGap = px(css.rowGap);
  const colGap = px(css.columnGap);
  const mainGap = isColumn ? rowGap : colGap;
  const crossGap = isColumn ? colGap : rowGap;

  const al = {
    mode: isColumn ? "VERTICAL" : "HORIZONTAL",
    itemSpacing: Number.isFinite(mainGap) ? mainGap : 0,
    paddingTop: px(css.paddingTop) || 0,
    paddingRight: px(css.paddingRight) || 0,
    paddingBottom: px(css.paddingBottom) || 0,
    paddingLeft: px(css.paddingLeft) || 0,
    primaryAxisAlignItems: mapJustify(css.justifyContent),
    counterAxisAlignItems: mapAlign(css.alignItems)
  };
  if (wrap && !isColumn) {
    al.layoutWrap = "WRAP";
    if (Number.isFinite(crossGap)) al.counterAxisSpacing = crossGap;
  }
  if (String(css.alignItems || "").trim() === "stretch") al.counterStretch = true;
  // row-reverse / column-reverse: children order flips and main-axis packing
  // mirrors; the create path consumes this flag (see specFor).
  if (reversed) al.reverse = true;
  return al;
}

// The single source of truth for turning captured CSS into a Figma style patch.
// Shared by both update (stylePatchFromCapture) and create (createOperationFromCapture).
// `box` ({width,height} px) refines gradient geometry (corner angles, px stops,
// radial farthest-corner sizing) when available.
function cssToFigmaStyle(css, isText, box) {
  const style = {};
  css = css || {};
  const get = (camel, kebab) => (css[camel] != null ? css[camel] : css[kebab]);

  // Fills: text uses color; shapes prefer gradient, then background color.
  if (isText) {
    const fill = cssColorToFigma(css.color);
    if (fill && fill.a !== 0) style.fill = fill;
  } else {
    const bgImage = get("backgroundImage", "background-image");
    const gradients = bgImage ? parseGradientLayers(bgImage, box) : [];
    if (gradients.length) {
      const fills = gradients.map((g) => {
        const f = { type: g.type, stops: g.stops };
        if (g.angle != null) f.angle = g.angle;
        if (g.center) f.center = g.center;
        if (g.radius) f.radius = g.radius;
        if (g.from != null) f.from = g.from;
        return f;
      });
      // CSS lists background layers top-first; Figma paints bottom-first.
      fills.reverse();
      style.fills = fills;
    } else {
      const bg = get("backgroundColor", "background-color") || css.background || css.color;
      const fill = cssColorToFigma(bg);
      if (fill && fill.a !== 0) style.fill = fill;
    }
  }

  // Stroke / border (uniform).
  const borderStyle = get("borderTopStyle", "border-top-style") || get("borderStyle", "border-style");
  const borderWidth = px(get("borderTopWidth", "border-top-width") || get("borderWidth", "border-width"));
  const borderColor = get("borderTopColor", "border-top-color") || get("borderColor", "border-color");
  if (borderWidth && borderWidth > 0 && borderStyle && borderStyle !== "none") {
    const sc = cssColorToFigma(borderColor);
    if (sc && sc.a !== 0) {
      style.strokeColor = sc;
      style.strokeWeight = borderWidth;
    }
  }

  // Corner radius (per-corner or uniform).
  const radii = perCornerRadii(css);
  if (radii) {
    style.cornerRadii = radii;
  } else {
    const radius = px(get("borderRadius", "border-radius"));
    if (radius !== undefined) style.cornerRadius = Math.max(0, radius);
  }

  // Opacity.
  const opacity = Number(get("opacity", "opacity"));
  if (Number.isFinite(opacity) && opacity >= 0 && opacity < 1) style.opacity = opacity;

  // Effects: box-shadow + filter drop-shadow + backdrop blur.
  let effects = parseBoxShadow(get("boxShadow", "box-shadow")) || [];
  // The export renders INSIDE strokes as zero-blur zero-offset inset
  // box-shadows; those are strokes, not INNER_SHADOW effects. (A real inner
  // shadow with no blur and no offset is indistinguishable — accepted edge.)
  effects = effects.filter((e) => !(e.type === "INNER_SHADOW" && !e.blur && !e.x && !e.y));
  const filterFx = parseFilterEffects(get("filter", "filter"));
  if (filterFx) effects = effects.concat(filterFx);
  const backdropFx = parseBackdropBlur(get("backdropFilter", "backdrop-filter"));
  // The export renders Figma background blur at radius/2 in CSS, so the CSS
  // value must double on the way back or blur shrinks every round trip.
  if (backdropFx) effects = effects.concat([{ ...backdropFx, blur: backdropFx.blur * 2 }]);
  if (effects.length) style.effects = effects;

  // Visibility.
  const visibility = get("visibility", "visibility");
  if (visibility === "hidden") style.visible = false;

  // Blend mode (kebab-case CSS value; 'normal' is the implicit default).
  const blend = String(get("mixBlendMode", "mix-blend-mode") || "").trim().toLowerCase();
  if (blend && blend !== "normal") style.blendMode = blend;

  // Image scale mode from object-fit / background-size. Only the two
  // unambiguous keywords translate; percentage/px sizes belong to CROP
  // transforms which the capture cannot reconstruct.
  if (!isText) {
    const objectFit = String(get("objectFit", "object-fit") || "").trim().toLowerCase();
    const bgSize = String(get("backgroundSize", "background-size") || "").trim().toLowerCase();
    const fit = (objectFit === "cover" || objectFit === "contain")
      ? objectFit
      : ((bgSize === "cover" || bgSize === "contain") ? bgSize : "");
    if (fit) style.scaleMode = fit === "cover" ? "FILL" : "FIT";
  }

  // Rotation from the computed transform matrix. CSS rotates clockwise
  // (screen coords), Figma's rotation property is counter-clockwise.
  const transform = String(get("transform", "transform") || "");
  const matrix = transform.match(/matrix\(\s*(-?[\d.e+-]+)\s*,\s*(-?[\d.e+-]+)\s*,/i);
  if (matrix) {
    const deg = Math.atan2(Number(matrix[2]) || 0, Number(matrix[1])) * 180 / Math.PI;
    if (Math.abs(deg) > 0.05) style.rotation = -Math.round(deg * 100) / 100;
  }

  // Per-child layout hints apply to any node inside an auto-layout parent.
  if (String(get("position", "position") || "") === "absolute") style.absolutePos = true;
  const grow = Number(get("flexGrow", "flex-grow"));
  if (Number.isFinite(grow) && grow > 0) style.layoutGrow = 1;
  // Auto-layout container config is only meaningful on non-text frames.
  if (!isText) {
    const al = cssToAutoLayout(css);
    if (al) style.autoLayout = al;
  }

  // Text properties.
  if (isText) {
    const fontSize = px(get("fontSize", "font-size"));
    if (fontSize !== undefined) style.fontSize = fontSize;
    const lineHeight = px(get("lineHeight", "line-height"));
    if (lineHeight !== undefined) style.lineHeightPx = lineHeight;
    const fontWeight = px(get("fontWeight", "font-weight"));
    if (fontWeight !== undefined) style.fontWeight = fontWeight;
    const fontFamily = get("fontFamily", "font-family");
    if (fontFamily) style.fontFamily = String(fontFamily).split(",")[0].replace(/["']/g, "").trim();
    const fontStyleVal = get("fontStyle", "font-style");
    if (fontStyleVal && /italic|oblique/i.test(fontStyleVal)) style.fontStyle = "italic";
    const letterSpacing = px(get("letterSpacing", "letter-spacing"));
    if (letterSpacing !== undefined) style.letterSpacing = letterSpacing;
    const textAlign = get("textAlign", "text-align");
    if (textAlign) style.textAlign = String(textAlign).trim();
    const textDecoration = get("textDecorationLine", "text-decoration-line") || get("textDecoration", "text-decoration");
    if (textDecoration && !/^none/i.test(textDecoration)) style.textDecoration = String(textDecoration).trim();
  }

  return style;
}

// Figma-native manifest style → the comparable shape cssToFigmaStyle produces,
// so the diff can drop properties that did not actually change.
function normManifestStyle(ms) {
  const out = {};
  if (ms && Array.isArray(ms.fills) && ms.fills.length) {
    const f = ms.fills.find((x) => x && x.visible !== false) || ms.fills[0];
    if (f.type === "SOLID" && f.color) out.fill = { r: f.color.r, g: f.color.g, b: f.color.b, a: f.color.a == null ? 1 : f.color.a };
    else if (String(f.type || "").indexOf("GRADIENT") === 0) {
      out.isGradient = true;
      // Comparable stop signature: [position, r, g, b, a] per stop.
      if (Array.isArray(f.gradientStops)) {
        out.gradStops = f.gradientStops.map((s) => {
          const c = s.color || {};
          return [Number(s.position) || 0, c.r, c.g, c.b, c.a == null ? 1 : c.a];
        });
      }
    }
    // All gradient layers (fills order = bottom-first) for multi-layer compare.
    const gradientFills = ms.fills.filter((x) => x && x.visible !== false && String(x.type || "").indexOf("GRADIENT") === 0);
    if (gradientFills.length) {
      out.gradients = gradientFills.map((g) => (Array.isArray(g.gradientStops) ? g.gradientStops.map((s) => {
        const c = s.color || {};
        return [Number(s.position) || 0, c.r, c.g, c.b, c.a == null ? 1 : c.a];
      }) : []));
    }
    // Image fill scale mode baseline (exported image shapes carry it).
    const imageFill = ms.fills.find((x) => x && x.visible !== false && String(x.type || "").toUpperCase() === "IMAGE");
    if (imageFill) out.scaleMode = String(imageFill.scaleMode || "FILL").toUpperCase();
  }
  // Blend mode baseline: the export only records non-normal modes, so a
  // missing value IS the 'normal' baseline.
  if (ms && typeof ms === "object") {
    out.blendMode = typeof ms.blendMode === "string" ? String(ms.blendMode).toLowerCase() : "normal";
  }
  if (ms && ms.radii) {
    if (typeof ms.radii.uniform === "number") out.cornerRadius = ms.radii.uniform;
    else if (Array.isArray(ms.radii.corners)) {
      // The capture emits a uniform cornerRadius when all four corners match, so
      // collapse an all-equal corner array to uniform for a like-for-like compare.
      const c = ms.radii.corners;
      if (c.length && c.every((v) => Math.abs(Number(v) - Number(c[0])) < 0.5)) out.cornerRadius = Number(c[0]);
      else out.cornerRadii = c.slice();
    }
  } else if (typeof (ms && ms.cornerRadius) === "number") out.cornerRadius = ms.cornerRadius;
  if (ms && Array.isArray(ms.strokes) && ms.strokes.length) {
    const s = ms.strokes.find((x) => x && x.visible !== false) || ms.strokes[0];
    if (s.type === "SOLID" && s.color) out.strokeColor = { r: s.color.r, g: s.color.g, b: s.color.b, a: s.color.a == null ? 1 : s.color.a };
  }
  if (ms && typeof ms.opacity === "number") out.opacity = ms.opacity;

  // Effects baseline, normalized to the capture's patch shape ({x,y,blur,spread}
  // in Figma units) so shadow edits can be diffed property-for-property.
  if (ms && Array.isArray(ms.effects)) {
    out.effects = [];
    for (const e of ms.effects) {
      if (!e || e.visible === false || !e.type) continue;
      const type = String(e.type).toUpperCase();
      if (type === "DROP_SHADOW" || type === "INNER_SHADOW") {
        out.effects.push({
          type,
          x: Number(e.offset && e.offset.x) || 0,
          y: Number(e.offset && e.offset.y) || 0,
          blur: Number(e.radius) || 0,
          spread: Number(e.spread) || 0,
          color: e.color ? { r: e.color.r, g: e.color.g, b: e.color.b, a: e.color.a == null ? 1 : e.color.a } : { r: 0, g: 0, b: 0, a: 1 }
        });
      } else if (type === "LAYER_BLUR" || type === "BACKGROUND_BLUR") {
        out.effects.push({ type, blur: Number(e.radius) || 0 });
      }
    }
  }

  // Text baseline (uniform-run snapshot from the export), normalized to the
  // capture's CSS-derived shape so font edits can be compared directly.
  const ts = ms && ms.textStyle;
  if (ts && typeof ts === "object") {
    if (typeof ts.fontSize === "number") out.fontSize = ts.fontSize;
    if (typeof ts.fontWeight === "number") out.fontWeight = ts.fontWeight;
    if (typeof ts.fontFamily === "string") out.fontFamily = ts.fontFamily;
    if (typeof ts.italic === "boolean") out.fontStyle = ts.italic ? "italic" : "normal";
    if (typeof ts.letterSpacingPx === "number") out.letterSpacing = ts.letterSpacingPx;
    if (typeof ts.lineHeightPx === "number") out.lineHeightPx = ts.lineHeightPx;
    if (typeof ts.textAlign === "string") {
      const alignMap = { LEFT: "left", CENTER: "center", RIGHT: "right", JUSTIFIED: "justify" };
      out.textAlign = alignMap[String(ts.textAlign).toUpperCase()] || String(ts.textAlign).toLowerCase();
    }
    if (typeof ts.textDecoration === "string") {
      const decoMap = { NONE: "none", UNDERLINE: "underline", STRIKETHROUGH: "line-through" };
      out.textDecoration = decoMap[String(ts.textDecoration).toUpperCase()] || "none";
    }
  }
  return out;
}

// Compare two [position,r,g,b,a] gradient-stop lists within colour epsilon.
function gradientStopsEq(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const e = 1 / 255 + 1e-6;
  for (let i = 0; i < a.length; i++) {
    const s = a[i], t = b[i];
    if (Math.abs((s[0] || 0) - (t[0] || 0)) > 0.01) return false;
    for (let j = 1; j <= 4; j++) if (Math.abs((s[j] == null ? 1 : s[j]) - (t[j] == null ? 1 : t[j])) > (j === 4 ? 0.02 : e)) return false;
  }
  return true;
}

function colorEq(a, b) {
  if (!a || !b) return false;
  const e = 1 / 255 + 1e-6;
  return Math.abs(a.r - b.r) < e && Math.abs(a.g - b.g) < e && Math.abs(a.b - b.b) < e
    && Math.abs((a.a == null ? 1 : a.a) - (b.a == null ? 1 : b.a)) < 0.02;
}

// Effect equality in patch shape (captured a vs baseline b, Figma units).
// A captured spread of 0 is ambiguous — filter:drop-shadow() carries no
// spread — so only a non-zero captured spread can contradict the baseline.
function effectSigEq(a, b) {
  if (!a || !b || a.type !== b.type) return false;
  if (a.type === "LAYER_BLUR" || a.type === "BACKGROUND_BLUR") return Math.abs((a.blur || 0) - (b.blur || 0)) < 1.1;
  if (Math.abs((a.x || 0) - (b.x || 0)) > 0.6 || Math.abs((a.y || 0) - (b.y || 0)) > 0.6) return false;
  if (Math.abs((a.blur || 0) - (b.blur || 0)) > 0.6) return false;
  if ((a.spread || 0) !== 0 && Math.abs((a.spread || 0) - (b.spread || 0)) > 0.6) return false;
  return colorEq(a.color, b.color);
}

// Remove captured style properties that match the exported baseline, so an
// update only carries what actually changed (no whole-page re-emission).
// Properties that differ from an existing baseline are recorded in `verified`
// so downstream gates treat them as independently confirmed changes.
const NON_BOX_TYPES = ["ELLIPSE", "VECTOR", "STAR", "POLYGON", "LINE", "BOOLEAN_OPERATION"];
function dropUnchangedStyle(style, original, verified = new Set()) {
  const orig = normManifestStyle(original && original.style);
  if (style.fill && orig.fill && colorEq(style.fill, orig.fill)) delete style.fill;

  // Gradient fills. Drop when every captured layer matches the baseline layer
  // stop-for-stop (both lists are bottom-first), or when the baseline is a
  // solid and every captured stop is that same colour (a uniform gradient the
  // browser renders for what Figma stores as a plain solid fill).
  if (Array.isArray(style.fills) && style.fills.length) {
    const capturedSigs = style.fills
      .filter((f) => f && Array.isArray(f.stops))
      .map((f) => f.stops.map((s) => [Number(s.position) || 0, s.r, s.g, s.b, s.a == null ? 1 : s.a]));
    if (capturedSigs.length) {
      if (Array.isArray(orig.gradients)) {
        const allEqual = capturedSigs.length === orig.gradients.length
          && capturedSigs.every((sig, i) => gradientStopsEq(sig, orig.gradients[i]));
        if (allEqual) delete style.fills;
      } else if (orig.fill && capturedSigs.length === 1
        && style.fills[0].stops.every((s) => colorEq({ r: s.r, g: s.g, b: s.b, a: s.a }, orig.fill))) {
        delete style.fills;
      }
    }
  }

  // Opacity: baseline lives in the manifest, drop when unchanged.
  if (typeof style.opacity === "number") {
    const oo = typeof orig.opacity === "number" ? orig.opacity : 1;
    if (Math.abs(style.opacity - oo) < 0.01) delete style.opacity;
  }

  // Corner radius: a node with no rounded corners is captured as cornerRadius:0,
  // while a baseline with no radius has none at all — treat "missing" as 0 so the
  // overwhelmingly common no-radius node does not re-emit cornerRadius on every op.
  // Vector/ellipse shapes carry radius in their geometry, never as a box corner.
  const type = String((original && original.type) || "").toUpperCase();
  const kind = String((original && original.kind) || "").toLowerCase();
  if (NON_BOX_TYPES.indexOf(type) !== -1 || kind === "svg" || kind === "image") {
    delete style.cornerRadius;
    delete style.cornerRadii;
  } else {
    const hasBaselineRadii = Array.isArray(orig.cornerRadii);
    const baselineRadius = typeof orig.cornerRadius === "number" ? orig.cornerRadius : (hasBaselineRadii ? null : 0);
    if (typeof style.cornerRadius === "number" && baselineRadius !== null && Math.abs(style.cornerRadius - baselineRadius) < 0.5) delete style.cornerRadius;
    if (Array.isArray(style.cornerRadii)) {
      if (hasBaselineRadii && style.cornerRadii.join() === orig.cornerRadii.join()) delete style.cornerRadii;
      else if (!hasBaselineRadii && typeof orig.cornerRadius !== "number" && style.cornerRadii.every((v) => Math.abs(Number(v)) < 0.5)) delete style.cornerRadii;
    }
  }

  // Stroke: drop when it matches the baseline, and drop a zero/absent stroke that
  // has no baseline to change against.
  if (style.strokeColor && orig.strokeColor && colorEq(style.strokeColor, orig.strokeColor)) {
    delete style.strokeColor;
    delete style.strokeWeight;
  } else if (!style.strokeColor && !orig.strokeColor) {
    delete style.strokeWeight;
  }

  // Blend mode: baseline is always defined ('normal' when unrecorded), so a
  // removed mix-blend-mode also diffs (captured default vs recorded mode).
  if ("blendMode" in orig) {
    const captured = typeof style.blendMode === "string" ? style.blendMode : "normal";
    if (captured === orig.blendMode) delete style.blendMode;
    else { style.blendMode = captured; verified.add("blendMode"); }
  }

  // Image scale mode: only meaningful for nodes with an image-fill baseline,
  // and only the cover/contain (FILL/FIT) transitions are detectable — CROP
  // and TILE render as sizes the capture cannot re-derive, so leave them be.
  if (typeof style.scaleMode === "string") {
    if (!("scaleMode" in orig)) delete style.scaleMode;
    else if (style.scaleMode === orig.scaleMode) delete style.scaleMode;
    else if (orig.scaleMode !== "FILL" && orig.scaleMode !== "FIT") delete style.scaleMode;
    else verified.add("scaleMode");
  }

  // Effects: compare captured shadows / backdrop blur against the baseline.
  // LAYER_BLUR never survives the DOM capture (filter:blur is not parsed
  // back), so it is excluded from comparison and re-attached on emission to
  // survive the plugin's wholesale effects replacement.
  if (Array.isArray(style.effects) && Array.isArray(orig.effects)) {
    const isShadow = (e) => e && (e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW");
    // Mirror the capture-side stroke-emulation filter on the baseline so a
    // (rare) real zero-blur zero-offset inner shadow compares like-for-like.
    const isStrokeEmulation = (e) => e.type === "INNER_SHADOW" && !e.blur && !e.x && !e.y;
    const capturedShadows = style.effects.filter(isShadow).filter((e) => !isStrokeEmulation(e));
    const capturedBlurs = style.effects.filter((e) => e && e.type === "BACKGROUND_BLUR");
    const baseShadows = orig.effects.filter(isShadow).filter((e) => !isStrokeEmulation(e));
    const baseBackdrop = orig.effects.filter((e) => e.type === "BACKGROUND_BLUR");
    const baseLayerBlurs = orig.effects.filter((e) => e.type === "LAYER_BLUR");
    const shadowsEq = capturedShadows.length === baseShadows.length
      && capturedShadows.every((e, i) => effectSigEq(e, baseShadows[i]));
    const blursEq = capturedBlurs.length === baseBackdrop.length
      && capturedBlurs.every((e, i) => effectSigEq(e, baseBackdrop[i]));
    if (shadowsEq && blursEq) {
      delete style.effects;
    } else {
      for (const lb of baseLayerBlurs) style.effects.push({ type: "LAYER_BLUR", blur: lb.blur });
      verified.add("effects");
    }
  }

  // Text properties: compare against the export-side uniform-run baseline.
  // Props with no baseline (mixed rich-text runs, old manifests) fall through
  // to the conservative gating in stripUnbaselinedProps.
  const TEXT_PROP_EQ = {
    fontSize: (a, b) => Math.abs(a - b) < 0.6,
    fontWeight: (a, b) => Math.abs(a - b) < 10,
    fontFamily: (a, b) => String(a).toLowerCase() === String(b).toLowerCase(),
    fontStyle: (a, b) => a === b,
    letterSpacing: (a, b) => Math.abs(a - b) < 0.6,
    lineHeightPx: (a, b) => Math.abs(a - b) < 0.6,
    textAlign: (a, b) => a === b,
    textDecoration: (a, b) => a === b,
  };
  for (const key of Object.keys(TEXT_PROP_EQ)) {
    if (!(key in orig)) continue;
    let cap = style[key];
    // The capture omits default values; synthesize them so removals diff too.
    if (cap === undefined) {
      if (key === "fontStyle") cap = "normal";
      else if (key === "textDecoration") cap = "none";
      else continue;
    }
    if (key === "textAlign") cap = ({ start: "left", end: "right" })[cap] || cap;
    if (TEXT_PROP_EQ[key](cap, orig[key])) delete style[key];
    else { style[key] = cap; verified.add(key); }
  }
  return style;
}

// Fallback gate for properties whose manifest baseline may be missing (old
// manifests, mixed rich-text runs). When dropUnchangedStyle verified a prop
// against a real baseline it passes freely; otherwise it is only emitted when
// the layer shows an independently-verified change (text edited, or a
// baseline-backed property like fill/opacity/radius/layout actually differs),
// so an unchanged layer does not re-emit them on every reflow.
const UNBASELINED_PROPS = ["fontSize", "fontWeight", "fontFamily", "fontStyle", "textAlign", "lineHeightPx", "letterSpacing", "textDecoration", "effects"];
function stripUnbaselinedProps(style, textChanged) {
  if (textChanged) return style;
  const verified = style.__verified instanceof Set ? style.__verified : new Set();
  const keys = Object.keys(style);
  const hasBaselineChange = verified.size > 0 || keys.some((k) => UNBASELINED_PROPS.indexOf(k) === -1);
  if (!hasBaselineChange) for (const k of keys) if (UNBASELINED_PROPS.indexOf(k) !== -1 && !verified.has(k)) delete style[k];
  return style;
}

function stylePatchFromCapture(original, current) {
  const bounds = current && current.bounds ? current.bounds : {};
  const originalLayout = manifestLayout(original);
  const isText = String(original && original.type || "").toUpperCase() === "TEXT";

  // Only emit visual properties that actually changed from the exported baseline.
  const css = current && current.style ? current.style : {};
  const style = cssToFigmaStyle(css, isText, bounds);
  // Props confirmed changed against a real baseline land in `verified` and
  // bypass the conservative no-baseline gates downstream.
  const verified = new Set();
  // Per-child layout hints are a create-only concern.
  delete style.layoutGrow;
  delete style.absolutePos;
  // Auto-layout updates only for frames that already are auto-layout with the
  // same direction (never restructure NONE↔flex or flip direction on update),
  // and only when a baselined property (gap/padding/alignment) actually moved.
  const baseAl = original && original.style && original.style.autoLayout;
  if (style.autoLayout && baseAl && String(style.autoLayout.mode) === String(baseAl.mode)) {
    const cap = style.autoLayout;
    const near = (a, b) => Math.abs((Number(a) || 0) - (Number(b) || 0)) < 0.6;
    const alignEq = (a, b) => {
      const norm = (v) => {
        const s = String(v || "MIN").toUpperCase();
        return s === "BASELINE" ? "MIN" : s;
      };
      return norm(a) === norm(b);
    };
    const same = near(cap.itemSpacing, baseAl.itemSpacing)
      && near(cap.paddingTop, baseAl.paddingTop)
      && near(cap.paddingRight, baseAl.paddingRight)
      && near(cap.paddingBottom, baseAl.paddingBottom)
      && near(cap.paddingLeft, baseAl.paddingLeft)
      && alignEq(cap.primaryAxisAlignItems, baseAl.primaryAxisAlignItems)
      && alignEq(cap.counterAxisAlignItems, baseAl.counterAxisAlignItems);
    if (same) delete style.autoLayout;
    else verified.add("autoLayout");
  } else {
    delete style.autoLayout;
  }
  // Keep only properties that actually changed vs the exported baseline.
  dropUnchangedStyle(style, original, verified);

  // Rotation: compare the captured CSS matrix angle against the exported
  // transform2x2 baseline (both normalized to Figma's counter-clockwise
  // degrees). A rotated node's bounding rect is its axis-aligned envelope,
  // so geometry diffs are skipped whenever either side is rotated.
  const t2 = originalLayout && originalLayout.transform2x2;
  const baseRotation = t2
    ? -Math.round(Math.atan2(Number(t2.b) || 0, Number(t2.a) == null ? 1 : Number(t2.a)) * (180 / Math.PI) * 100) / 100
    : 0;
  const capRotation = typeof style.rotation === "number" ? style.rotation : 0;
  const rotated = Math.abs(baseRotation) > 0.5 || Math.abs(capRotation) > 0.5;
  if (Math.abs(capRotation - baseRotation) < 0.5) delete style.rotation;
  else { style.rotation = capRotation; verified.add("rotation"); }

  // Layout diff. Two rules make this a real diff instead of a whole-page re-emit:
  //  - x/y only matter for absolutely-positioned nodes. Auto-layout / flow children
  //    store left/top=0 in the manifest (Figma positions them by layout), while the
  //    capture sees their real pixel offset — comparing those always mismatches.
  //  - Text nodes are sized by their content + font, so never emit their x/y/w/h;
  //    a real font-size change shows up as a bounds change, which gates fontSize.
  const layoutSrc = current && current.local ? current.local : bounds;
  const width = Number(bounds.width);
  const height = Number(bounds.height);
  const x = Number(layoutSrc.x);
  const y = Number(layoutSrc.y);
  const ow = Number(originalLayout.width || original.width || 0);
  const oh = Number(originalLayout.height || original.height || 0);
  // Tolerance absorbs sub-pixel rounding between the browser render and Figma's
  // exported layout (a few px on large containers) while still catching real resizes.
  const wChanged = Number.isFinite(width) && Math.abs(width - ow) > Math.max(3, ow * 0.03);
  const hChanged = Number.isFinite(height) && Math.abs(height - oh) > Math.max(3, oh * 0.03);
  const isAbsolute = String((originalLayout && originalLayout.position) || "") === "absolute";

  if (isText) {
    // Metrics need either a baseline-verified change or a real size change:
    // a fixed-width text box swallows font-size edits in its geometry, so the
    // baseline comparison is what lets those through.
    if (!(wChanged || hChanged)) {
      for (const k of ["fontSize", "lineHeightPx", "letterSpacing"]) {
        if (!verified.has(k)) delete style[k];
      }
    }
  } else if (!rotated) {
    if (wChanged) style.width = width;
    if (hChanged) style.height = height;
    if (isAbsolute) {
      if (Number.isFinite(x) && Math.abs(x - Number(originalLayout.left ?? original.x ?? 0)) > 0.5) style.x = x;
      if (Number.isFinite(y) && Math.abs(y - Number(originalLayout.top ?? original.y ?? 0)) > 0.5) style.y = y;
    }
  }

  // The plugin's resolveFont() falls back to Inter when fontFamily is absent
  // and to Regular when fontWeight is absent, so a patch touching any part of
  // the font identity must carry all of family + weight + italic — otherwise
  // a weight-only edit would silently reset the family.
  if (isText && (style.fontWeight !== undefined || style.fontStyle !== undefined || style.fontFamily !== undefined)) {
    const get = (camel, kebab) => (css[camel] != null ? css[camel] : css[kebab]);
    if (style.fontFamily === undefined) {
      const family = get("fontFamily", "font-family");
      if (family) style.fontFamily = String(family).split(",")[0].replace(/["']/g, "").trim();
    }
    if (style.fontStyle === undefined) {
      const fontStyleVal = get("fontStyle", "font-style");
      style.fontStyle = fontStyleVal && /italic|oblique/i.test(String(fontStyleVal)) ? "italic" : "normal";
    }
    if (style.fontWeight === undefined) {
      const fontWeight = px(get("fontWeight", "font-weight"));
      if (fontWeight !== undefined) style.fontWeight = fontWeight;
    }
  }

  // Non-enumerable so Object.keys/JSON never see it; read by stripUnbaselinedProps.
  Object.defineProperty(style, "__verified", { value: verified, enumerable: false, configurable: true });
  return style;
}

function createOperationFromCapture(item, manifest) {
  const bounds = item && item.bounds ? item.bounds : {};
  const css = item && item.style ? item.style : {};
  const parentId = item.parentId && manifest.nodes && manifest.nodes[item.parentId] ? item.parentId : (manifest.rootIds && manifest.rootIds[0]) || "";
  const parentNode = parentId ? manifest.nodes[parentId] : null;
  const parentLayout = manifestLayout(parentNode);
  const parentX = Number(parentLayout.left ?? parentLayout.x ?? 0);
  const parentY = Number(parentLayout.top ?? parentLayout.y ?? 0);
  const kind = String(item.kind || "rectangle").toLowerCase();
  const isText = kind === "text";
  const style = Object.assign(cssToFigmaStyle(css, isText, bounds), {
    x: Math.max(0, Number(bounds.x || 0) - parentX),
    y: Math.max(0, Number(bounds.y || 0) - parentY),
    width: Math.max(1, Number(bounds.width || 1)),
    height: Math.max(1, Number(bounds.height || 1)),
  });
  // Single-line text hugs its content (font-fallback metrics otherwise wrap it).
  if (isText) {
    const lineHeight = Number(style.lineHeightPx) || (Number(style.fontSize) || 14) * 1.6;
    if (Number(bounds.height || 0) < lineHeight * 1.5) style.textAutoResize = "WIDTH_AND_HEIGHT";
  }
  const svgBgText = !isText && kind !== "svg" && item.imageSrc ? svgTextFromImageSrc(item.imageSrc) : "";
  const op = {
    action: "create",
    id: item.createId || `html_${Date.now()}`,
    parentId,
    kind: kind === "img" ? "image" : kind,
    name: item.name || "HTML layer",
    text: item.text || "",
    imageBase64: imageBase64FromCapture(item.imageSrc),
    style
  };
  if (svgBgText) {
    if (op.kind === "image") op.kind = "frame";
    op.children = [svgIconChildFromCapture(item, svgBgText)];
  }
  return op;
}

function makePatch(manifest, capture, options = {}) {
  const operations = [];
  const capturedNodes = capture && capture.nodes ? capture.nodes : {};
  for (const [id, original] of Object.entries(manifest.nodes || {})) {
    const current = capturedNodes[id];
    if (!current) continue;
    const op = { action: "update", id };
    if (original.type === "TEXT" && current.text !== original.text) op.text = current.text;
    const style = stylePatchFromCapture(original, current);
    stripUnbaselinedProps(style, op.text !== undefined);
    if (Object.keys(style).length) op.style = style;
    if (op.text !== undefined || op.style) operations.push(op);
  }
  for (const item of Array.isArray(capture.created) ? capture.created : []) {
    operations.push(createOperationFromCapture(item, manifest));
  }

  // Deletion detection: an exported node that is no longer present in the DOM
  // capture was removed in HTML. Only run on a full DOM capture (which carries
  // `created`), and skip originals that were never rendered (zero-size), to
  // avoid deleting nodes that are merely hidden/collapsed rather than removed.
  const detectDeletions = options.detectDeletions !== false;
  const isDomCapture = Array.isArray(capture.created) || typeof capture.source === "string";
  if (detectDeletions && isDomCapture) {
    // Never delete the exported selection roots: the root wrapper is not always
    // rendered with a data-figma-id, so its absence is not a real removal.
    const rootIds = new Set(Array.isArray(manifest.rootIds) ? manifest.rootIds.map(String) : []);
    for (const [id, original] of Object.entries(manifest.nodes || {})) {
      if (capturedNodes[id]) continue;
      if (rootIds.has(String(id))) continue;
      const layout = manifestLayout(original);
      const w = Number(layout.width || original.width || 0);
      const h = Number(layout.height || original.height || 0);
      if (w <= 0 && h <= 0) continue; // never a real, visible layer
      operations.push({ action: "delete", id });
    }
  }

  return {
    schemaVersion: "0.3.0",
    createdAt: new Date().toISOString(),
    sessionId: manifest.sessionId || null,
    operations
  };
}

// Convert captured rich-text segments (CSS colors) into patch form (Figma fills).
function convertSegments(segments) {
  if (!Array.isArray(segments) || !segments.length) return undefined;
  return segments.map((s) => {
    const out = { start: s.start, end: s.end };
    if (typeof s.fontSize === "number" && s.fontSize > 0) out.fontSize = s.fontSize;
    if (s.fontFamily) out.fontFamily = String(s.fontFamily);
    if (typeof s.fontWeight === "number") out.fontWeight = s.fontWeight;
    if (s.italic) out.italic = true;
    const fill = cssColorToFigma(s.color);
    if (fill && fill.a !== 0) out.fill = fill;
    return out;
  });
}

// Build a create-only patch that reconstructs a whole screen on a NEW Figma page,
// with no prior Figma manifest. Uses the capture's created[] tree (parentCreateId)
// to nest elements, so a card frame can contain its icon + label.
function buildPagePatch(capture, opts = {}) {
  const created = Array.isArray(capture && capture.created) ? capture.created : [];
  const byId = new Map();
  for (const it of created) if (it && it.createId) byId.set(String(it.createId), it);

  const childrenOf = new Map();
  const roots = [];
  for (const it of created) {
    const pid = it.parentCreateId && byId.has(String(it.parentCreateId)) ? String(it.parentCreateId) : "";
    if (pid) {
      if (!childrenOf.has(pid)) childrenOf.set(pid, []);
      childrenOf.get(pid).push(it);
    } else {
      roots.push(it);
    }
  }

  function specFor(it, parentBounds) {
    const b = it.bounds || {};
    const kids = childrenOf.get(String(it.createId)) || [];
    let kind = String(it.kind || "rectangle").toLowerCase();
    if (kind === "img") kind = "image";
    // A node with children must be a frame (rectangles/text cannot hold children).
    if (kids.length && kind !== "frame") kind = "frame";
    const isText = kind === "text";
    const style = cssToFigmaStyle(it.style || {}, isText, b);
    const px = parentBounds ? Number(parentBounds.x || 0) : 0;
    const py = parentBounds ? Number(parentBounds.y || 0) : 0;
    style.x = Math.round((Number(b.x || 0) - px) * 100) / 100;
    style.y = Math.round((Number(b.y || 0) - py) * 100) / 100;
    style.width = Math.max(1, Number(b.width || 1));
    style.height = Math.max(1, Number(b.height || 1));

    const spec = {
      action: "create",
      id: String(it.createId),
      kind,
      name: it.name || "HTML layer",
      text: it.text || "",
      style
    };
    const svgBgText = kind !== "svg" && it.imageSrc ? svgTextFromImageSrc(it.imageSrc) : "";
    if (svgBgText) {
      // vector background → child icon layer; container keeps fill/radius
      if (spec.kind === "image") spec.kind = "frame";
    } else if (kind === "image" || (kind !== "svg" && it.imageSrc)) {
      const id = cacheImageFromCapture(it.imageSrc);
      if (id) { spec.kind = "image"; spec.imageId = id; }
      else if (kind === "image") { spec.kind = "rectangle"; } // missing image → placeholder box
    }
    if (spec.kind === "text" && it.segments) {
      const segs = convertSegments(it.segments);
      if (segs) spec.segments = segs;
    }
    if (kind === "svg") {
      const svgStr = svgContentFromCapture(it);
      if (svgStr) { spec.kind = "svg"; spec.svgContent = svgStr; }
      else { spec.kind = "rectangle"; } // missing SVG → placeholder box
    }
    const childSpecs = kids.map((k) => specFor(k, b)).filter(Boolean);
    if (svgBgText) childSpecs.push(svgIconChildFromCapture(it, svgBgText));
    if (childSpecs.length) spec.children = childSpecs;

    // Single-line text hugs its content: with a fixed captured width, any
    // metric difference from Figma's CJK font fallback would wrap the line.
    if (spec.kind === "text") {
      const lineHeight = Number(spec.style.lineHeightPx) || (Number(spec.style.fontSize) || 14) * 1.6;
      if (Number(b.height || 0) < lineHeight * 1.5) spec.style.textAutoResize = "WIDTH_AND_HEIGHT";
    }

    // A container that positions any child absolutely is an overlay/positioning
    // context, not a flow layout. Auto-layout + absolute children is fragile, so
    // drop auto-layout here and keep all children at their captured x/y.
    if (spec.style.autoLayout && childSpecs.some((c) => c && c.style && c.style.absolutePos)) {
      delete spec.style.autoLayout;
    }
    if (spec.style.autoLayout) {
      const al = spec.style.autoLayout;
      // row/column-reverse: flip child order and mirror main-axis packing so
      // visual order and anchoring match the browser.
      if (al.reverse) {
        childSpecs.reverse();
        if (al.primaryAxisAlignItems === "MIN") al.primaryAxisAlignItems = "MAX";
        else if (al.primaryAxisAlignItems === "MAX") al.primaryAxisAlignItems = "MIN";
        delete al.reverse;
      }
      inferCounterAxisCenter(al, spec.style, childSpecs);
      inferTailGrow(al, spec.style, childSpecs);
    }
    // Hug inference: when the container's captured size equals its flow
    // children's extent (+gap/padding), the design intent is hug-content, so
    // the created frame reflows when its content changes later.
    if (spec.style.autoLayout && childSpecs.length && spec.style.autoLayout.layoutWrap !== "WRAP") {
      inferAutoLayoutSizing(spec.style.autoLayout, spec.style, childSpecs);
    }
    return spec;
  }

  // Normalize root positions so the screen sits near the page origin.
  let minX = Infinity, minY = Infinity;
  for (const r of roots) {
    const b = r.bounds || {};
    if (Number.isFinite(Number(b.x))) minX = Math.min(minX, Number(b.x));
    if (Number.isFinite(Number(b.y))) minY = Math.min(minY, Number(b.y));
  }
  if (!Number.isFinite(minX)) minX = 0;
  if (!Number.isFinite(minY)) minY = 0;

  const operations = roots.map((r) => specFor(r, { x: minX, y: minY }));

  // Batch multi-screen: arrange root frames in a tidy grid on the canvas.
  // Columns are uniform (max screen width); each row's height is its tallest screen.
  const cols = Math.max(0, Math.floor(Number(opts.cols) || 0));
  if (cols > 0 && operations.length > 1) {
    const gap = Number.isFinite(Number(opts.gap)) ? Number(opts.gap) : 48;
    const colWidth = Math.max.apply(null, operations.map((s) => Number(s.style.width) || 0));
    const rowCount = Math.ceil(operations.length / cols);
    const rowY = [];
    let acc = 0;
    for (let r = 0; r < rowCount; r++) {
      rowY[r] = acc;
      const rowSpecs = operations.slice(r * cols, r * cols + cols);
      const rowH = Math.max.apply(null, rowSpecs.map((s) => Number(s.style.height) || 0));
      acc += rowH + gap;
    }
    operations.forEach((s, idx) => {
      const c = idx % cols;
      const r = Math.floor(idx / cols);
      s.style.x = c * (colWidth + gap);
      s.style.y = rowY[r];
    });
  }

  return {
    schemaVersion: "0.3.0",
    createdAt: new Date().toISOString(),
    page: { create: true, name: String(opts.pageName || "HTML Import") },
    screens: operations.length,
    operations
  };
}

function kindToFigmaType(kind) {
  const k = String(kind || "").toLowerCase();
  if (k === "text") return "TEXT";
  if (k === "frame") return "FRAME";
  return "RECTANGLE"; // image / rectangle
}

// Escape a string for safe use inside a RegExp.
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Build a loop-manifest for freshly-created nodes, keyed by their new Figma id,
// using parent-relative layout so the next round-trip's `local` coords line up.
function writebackManifest(capture, map) {
  const created = Array.isArray(capture && capture.created) ? capture.created : [];
  const byCid = new Map();
  for (const it of created) if (it && it.createId) byCid.set(String(it.createId), it);
  const nodes = {};
  const rootIds = [];
  for (const it of created) {
    const fid = map[String(it.createId)];
    if (!fid) continue;
    const parent = it.parentCreateId ? byCid.get(String(it.parentCreateId)) : null;
    const b = it.bounds || {};
    const pb = parent ? (parent.bounds || {}) : null;
    const left = pb ? Number(b.x || 0) - Number(pb.x || 0) : Number(b.x || 0);
    const top = pb ? Number(b.y || 0) - Number(pb.y || 0) : Number(b.y || 0);
    const isText = String(it.kind || "").toLowerCase() === "text";
    nodes[fid] = {
      id: fid,
      name: it.name || "",
      type: kindToFigmaType(it.kind),
      text: it.text || "",
      layout: {
        left: Math.round(left * 100) / 100,
        top: Math.round(top * 100) / 100,
        width: Math.round(Number(b.width || 0) * 100) / 100,
        height: Math.round(Number(b.height || 0) * 100) / 100
      },
      style: cssToFigmaStyle(it.style || {}, isText)
    };
    if (!parent) rootIds.push(fid);
  }
  return {
    schemaVersion: "0.1.0",
    generatedBy: "writeback",
    createdAt: new Date().toISOString(),
    rootIds,
    nodes
  };
}

// Give every data-figma-create/new element a stable data-figma-create-id (the
// write-back anchor). Idempotent; handles self-closing tags (`<img .. />`).
function annotateCreateIds(html) {
  let n = (html.match(/data-figma-create-id\s*=/g) || []).length;
  let added = 0;
  const out = html.replace(/<([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>])*)>/g, (m, tag, attrs) => {
    if (!/data-figma-(create|new)\s*=/.test(attrs)) return m;
    if (/data-figma-create-id\s*=/.test(attrs)) return m;
    added += 1;
    const selfClose = /\/\s*$/.test(attrs);
    const cleanAttrs = attrs.replace(/\s*\/\s*$/, "");
    return `<${tag}${cleanAttrs} data-figma-create-id="ci_${++n}"${selfClose ? " />" : ">"}`;
  });
  return { html: out, added };
}

// Inject data-figma-id="<figmaId>" next to each data-figma-create-id="<createId>".
// Idempotent: replaces an existing data-figma-id if already present.
function injectFigmaIds(html, map) {
  let injected = 0;
  for (const createId of Object.keys(map)) {
    const fid = map[createId];
    if (!fid) continue;
    const re = new RegExp(`(data-figma-create-id="${escapeRegExp(createId)}")(\\s+data-figma-id="[^"]*")?`);
    if (re.test(html)) {
      html = html.replace(re, `$1 data-figma-id="${fid}"`);
      injected += 1;
    }
  }
  return { html, injected };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  if (req.method === "OPTIONS") return send(res, 204, "");
  if (req.method === "GET" && url.pathname === "/health") return send(res, 200, "ok", "text/plain");
  if (req.method === "GET" && url.pathname === "/figma-html-loop-capture.js") {
    return send(res, 200, captureClientScript(), "application/javascript; charset=utf-8");
  }
  if (req.method === "GET" && (url.pathname === "/export" || url.pathname.startsWith("/export/"))) {
    const rel = url.pathname === "/export" ? "index.html" : decodeURIComponent(url.pathname.replace(/^\/export\/?/, ""));
    const safeRel = path.normalize(rel).replace(/^(\.\.[/\\])+/, "");
    const filePath = path.join(defaultExportDir, safeRel);
    if (!filePath.startsWith(defaultExportDir)) return send(res, 403, { ok: false, message: "Forbidden." });
    return sendFile(res, filePath);
  }
  if (req.method === "GET" && url.pathname.startsWith("/api/asset/image/")) {
    const id = decodeURIComponent(url.pathname.slice("/api/asset/image/".length));
    if (!validAssetId(id)) return send(res, 400, { ok: false, message: "Bad image id." });
    return sendFile(res, path.join(imageCacheDir, id + ".png"));
  }

  if (req.method === "GET" && url.pathname === "/api/helper-info") {
    return send(res, 200, { ok: true, version: helperVersion, defaultExportDir, port });
  }

  if (req.method === "GET" && url.pathname === "/api/exports") {
    const outDir = path.resolve(url.searchParams.get("out") || defaultExportDir);
    const archives = listExportArchives(outDir);
    return send(res, 200, { ok: true, outDir, count: archives.length, archives });
  }

  if (req.method === "POST" && url.pathname === "/api/selection/confirm") {
    try {
      const payload = await readJson(req);
      const composition = payload && payload.composition;
      const selection = Array.isArray(payload && payload.selection) ? payload.selection : [];
      if (!composition && !selection.length) return send(res, 400, { ok: false, message: "No Figma selection received." });
      latestSelection = {
        ok: true,
        sessionId: `selection_${Date.now()}`,
        confirmedAt: new Date().toISOString(),
        page: payload.page || null,
        selection,
        composition
      };
      const outDir = path.resolve((payload && payload.out) || defaultExportDir);
      const shouldAutoExport = payload && payload.autoExport === false ? false : true;
      if (!shouldAutoExport || !composition) {
        return send(res, 200, latestSelection);
      }
      const exported = await exportSelection(latestSelection, outDir, { open: !!(payload && payload.open) });
      latestSelection.exported = {
        outDir: exported.outDir,
        indexPath: exported.indexPath,
        url: exported.url,
        opened: exported.opened,
        engine: exported.engine,
        fallbackReason: exported.fallbackReason,
        files: exported.files,
        fonts: exported.fonts,
        archived: exported.archived,
      };
      return send(res, 200, { ...latestSelection, export: latestSelection.exported });
    } catch (error) {
      return send(res, 400, { ok: false, message: error.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/images/check") {
    const body = await readJson(req).catch(() => ({}));
    return send(res, 200, { ok: true, missing: listMissingAssets(body && body.ids, imageCacheDir, "png") });
  }

  if (req.method === "POST" && url.pathname === "/api/images/batch") {
    const body = await readJson(req).catch(() => ({}));
    return send(res, 200, { ok: true, ...saveImageBatch(body && body.items) });
  }

  if (req.method === "POST" && url.pathname === "/api/svgs/check") {
    const body = await readJson(req).catch(() => ({}));
    return send(res, 200, { ok: true, missing: listMissingAssets(body && body.ids, svgCacheDir, "svg") });
  }

  if (req.method === "POST" && url.pathname === "/api/svgs/batch") {
    const body = await readJson(req).catch(() => ({}));
    return send(res, 200, { ok: true, ...saveSvgBatch(body && body.items) });
  }

  if (req.method === "GET" && url.pathname === "/api/selection/latest") {
    if (!latestSelection) return send(res, 404, { ok: false, message: "No confirmed selection yet." });
    return send(res, 200, latestSelection);
  }

  if (req.method === "POST" && url.pathname === "/api/export/html") {
    try {
      if (!latestSelection) return send(res, 404, { ok: false, message: "No confirmed selection yet." });
      const body = await readJson(req);
      const outDir = path.resolve((body && body.out) || path.join(process.cwd(), "figma-html-loop-export"));
      const exported = await exportSelection(latestSelection, outDir, { open: !!(body && body.open) });
      return send(res, 200, exported);
    } catch (error) {
      return send(res, 400, { ok: false, message: error.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/capture/html") {
    try {
      const body = await readJson(req);
      const target = body && body.target;
      if (!target) return send(res, 400, { ok: false, message: "Missing target." });
      const html = await readTarget(target);
      let css = "";
      const cssPath = body.css || (target.endsWith(".html") ? path.join(path.dirname(path.resolve(target)), "styles.css") : "");
      if (cssPath && fs.existsSync(cssPath)) css = fs.readFileSync(cssPath, "utf8");
      const capture = body && body.latest && latestCapture ? latestCapture : captureFromHtml(html, css);
      if (body.out) fs.writeFileSync(path.resolve(body.out), JSON.stringify(capture, null, 2), "utf8");
      return send(res, 200, { ok: true, capture, out: body.out || null });
    } catch (error) {
      return send(res, 400, { ok: false, message: error.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/capture/dom") {
    try {
      const body = await readJson(req);
      latestCapture = body && body.ok ? body : null;
      return send(res, 200, { ok: true, capturedAt: latestCapture && latestCapture.capturedAt, nodes: latestCapture && latestCapture.nodes ? Object.keys(latestCapture.nodes).length : 0, created: latestCapture && Array.isArray(latestCapture.created) ? latestCapture.created.length : 0 });
    } catch (error) {
      return send(res, 400, { ok: false, message: error.message });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/capture/latest") {
    if (!latestCapture) return send(res, 404, { ok: false, message: "No browser capture yet. Open the generated HTML once, then try again." });
    return send(res, 200, latestCapture);
  }

  if (req.method === "POST" && url.pathname === "/api/diff") {
    try {
      const body = await readJson(req);
      const manifest = JSON.parse(fs.readFileSync(path.resolve(body.manifest), "utf8"));
      const capture = body.capture ? JSON.parse(fs.readFileSync(path.resolve(body.capture), "utf8")) : latestCapture;
      if (!capture) return send(res, 400, { ok: false, message: "No capture found. Open the generated HTML once, or run capture first." });
      const patch = makePatch(manifest, capture, { detectDeletions: body.detectDeletions !== false });
      if (body.out) fs.writeFileSync(path.resolve(body.out), JSON.stringify(patch, null, 2), "utf8");
      return send(res, 200, { ok: true, patch, out: body.out || null });
    } catch (error) {
      return send(res, 400, { ok: false, message: error.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/build-page") {
    try {
      const body = await readJson(req);
      const capture = body && body.capture ? JSON.parse(fs.readFileSync(path.resolve(body.capture), "utf8")) : latestCapture;
      if (!capture) return send(res, 400, { ok: false, message: "No capture found. Open the annotated HTML once, then retry." });
      if (!Array.isArray(capture.created) || !capture.created.length) {
        return send(res, 400, { ok: false, message: "Capture has no created elements. Add data-figma-create markers to the HTML, then re-open it." });
      }
      const patch = buildPagePatch(capture, {
        pageName: (body && body.pageName) || "HTML Import",
        cols: body && body.cols,
        gap: body && body.gap
      });
      if (body && body.out) fs.writeFileSync(path.resolve(body.out), JSON.stringify(patch, null, 2), "utf8");
      return send(res, 200, { ok: true, patch, out: (body && body.out) || null, rootCount: patch.operations.length, screens: patch.screens });
    } catch (error) {
      return send(res, 400, { ok: false, message: error.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/apply/request") {
    try {
      const body = await readJson(req);
      const patch = body.patchFile ? JSON.parse(fs.readFileSync(path.resolve(body.patchFile), "utf8")) : body.patch;
      if (!patch || !Array.isArray(patch.operations)) return send(res, 400, { ok: false, message: "Invalid patch." });
      pendingPatch = { ...patch, queuedAt: new Date().toISOString() };
      return send(res, 200, { ok: true, queued: true, operations: pendingPatch.operations.length });
    } catch (error) {
      return send(res, 400, { ok: false, message: error.message });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/apply/pending") {
    return send(res, 200, { ok: true, patch: pendingPatch });
  }

  if (req.method === "POST" && url.pathname === "/api/apply/ack") {
    const body = await readJson(req).catch(() => null);
    lastApplied = { at: new Date().toISOString(), result: body || null, patch: pendingPatch };
    pendingPatch = null;
    return send(res, 200, { ok: true });
  }

  if (req.method === "GET" && url.pathname === "/api/apply/last") {
    return send(res, 200, { ok: true, lastApplied });
  }

  if (req.method === "POST" && url.pathname === "/api/writeback") {
    try {
      const body = await readJson(req);
      const htmlPath = body && body.html ? path.resolve(body.html) : "";
      if (!htmlPath || !fs.existsSync(htmlPath)) return send(res, 400, { ok: false, message: "Missing or unreadable --html file." });
      const map = (body && body.map && typeof body.map === "object")
        ? body.map
        : (lastApplied && lastApplied.result && lastApplied.result.created) || null;
      if (!map || !Object.keys(map).length) {
        return send(res, 400, { ok: false, message: "No createId→figmaId map. Apply a create/build-page patch first (the plugin returns it), or pass map." });
      }
      const raw = fs.readFileSync(htmlPath, "utf8");
      const { html, injected } = injectFigmaIds(raw, map);
      fs.writeFileSync(htmlPath, html, "utf8");

      let manifestOut = null;
      const capture = body && body.capture ? JSON.parse(fs.readFileSync(path.resolve(body.capture), "utf8")) : latestCapture;
      if (body && body.manifestOut && capture) {
        const manifest = writebackManifest(capture, map);
        manifestOut = path.resolve(body.manifestOut);
        fs.writeFileSync(manifestOut, JSON.stringify(manifest, null, 2), "utf8");
      }
      return send(res, 200, { ok: true, html: htmlPath, injected, mapped: Object.keys(map).length, manifestOut });
    } catch (error) {
      return send(res, 400, { ok: false, message: error.message });
    }
  }

  // ---- verify: side-by-side render loop (Figma PNG vs HTML PNG → pixel diff) ----

  if (req.method === "GET" && url.pathname === "/libs/html-to-image.min.js") {
    return sendFile(res, path.join(__dirname, "..", "vendor-figma-bridge", "public", "html-to-image.min.js"));
  }

  if (req.method === "POST" && url.pathname === "/api/render/request") {
    try {
      const body = await readJson(req).catch(() => ({}));
      let nodeId = body && body.nodeId ? String(body.nodeId) : "";
      const outDir = path.resolve((body && body.out) || defaultExportDir);
      if (!nodeId) {
        const manifestPath = path.join(outDir, "loop-manifest.json");
        if (fs.existsSync(manifestPath)) {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
          nodeId = Array.isArray(manifest.rootIds) && manifest.rootIds.length ? String(manifest.rootIds[0]) : "";
        }
      }
      if (!nodeId) return send(res, 400, { ok: false, message: "No nodeId given and no exported manifest to take a root from." });
      const dir = path.join(outDir, "verify");
      ensureDir(dir);
      renderJob = {
        id: `render_${Date.now()}`,
        nodeId,
        dir,
        requestedAt: new Date().toISOString(),
        figmaDone: false,
        htmlDone: false,
      };
      return send(res, 200, { ok: true, id: renderJob.id, nodeId, dir });
    } catch (error) {
      return send(res, 400, { ok: false, message: error.message });
    }
  }

  // Polled by the plugin UI (piggybacks on its 2s pending loop).
  if (req.method === "GET" && url.pathname === "/api/render/pending") {
    const job = renderJob && !renderJob.figmaDone ? { id: renderJob.id, nodeId: renderJob.nodeId } : null;
    return send(res, 200, { ok: true, job });
  }

  if (req.method === "POST" && url.pathname === "/api/render/figma") {
    try {
      const body = await readJson(req);
      if (!renderJob || !body || body.id !== renderJob.id) return send(res, 409, { ok: false, message: "No matching render job." });
      if (!body.base64) return send(res, 400, { ok: false, message: "Figma render came back empty (node not found or not exportable)." });
      fs.writeFileSync(path.join(renderJob.dir, "figma.png"), Buffer.from(String(body.base64), "base64"));
      renderJob.figmaDone = true;
      return send(res, 200, { ok: true });
    } catch (error) {
      return send(res, 400, { ok: false, message: error.message });
    }
  }

  // Polled by the capture client injected into the exported page.
  if (req.method === "GET" && url.pathname === "/api/render/html-pending") {
    const job = renderJob && !renderJob.htmlDone
      ? { id: renderJob.id, selector: `[data-figma-id="${renderJob.nodeId}"]` }
      : null;
    return send(res, 200, { ok: true, job });
  }

  if (req.method === "POST" && url.pathname === "/api/render/html") {
    try {
      const body = await readJson(req);
      if (!renderJob || !body || body.id !== renderJob.id) return send(res, 409, { ok: false, message: "No matching render job." });
      const dataUrl = String(body.dataUrl || "");
      const m = dataUrl.match(/^data:image\/png;base64,(.+)$/);
      if (!m) return send(res, 400, { ok: false, message: "Expected a data:image/png;base64 payload." });
      fs.writeFileSync(path.join(renderJob.dir, "html.png"), Buffer.from(m[1], "base64"));
      renderJob.htmlDone = true;
      return send(res, 200, { ok: true });
    } catch (error) {
      return send(res, 400, { ok: false, message: error.message });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/render/status") {
    if (!renderJob) return send(res, 404, { ok: false, message: "No render job. POST /api/render/request first." });
    return send(res, 200, {
      ok: true,
      id: renderJob.id,
      nodeId: renderJob.nodeId,
      figmaDone: renderJob.figmaDone,
      htmlDone: renderJob.htmlDone,
      dir: renderJob.dir,
    });
  }

  if (req.method === "POST" && url.pathname === "/api/verify/compare") {
    try {
      const body = await readJson(req).catch(() => ({}));
      if (!renderJob) return send(res, 404, { ok: false, message: "No render job. POST /api/render/request first." });
      const figmaPath = path.join(renderJob.dir, "figma.png");
      const htmlPath = path.join(renderJob.dir, "html.png");
      if (!fs.existsSync(figmaPath)) return send(res, 409, { ok: false, message: "Figma render not received yet. Keep the plugin panel open in Figma." });
      if (!fs.existsSync(htmlPath)) return send(res, 409, { ok: false, message: "HTML render not received yet. Keep the exported page open in the browser." });
      const result = comparePng(fs.readFileSync(figmaPath), fs.readFileSync(htmlPath), {
        threshold: body && Number.isFinite(Number(body.threshold)) ? Number(body.threshold) : undefined,
      });
      const diffPath = path.join(renderJob.dir, "diff.png");
      fs.writeFileSync(diffPath, result.diffPng);
      const { diffPng, ...metrics } = result;
      return send(res, 200, {
        ok: true,
        ...metrics,
        figma: figmaPath,
        html: htmlPath,
        diff: diffPath,
      });
    } catch (error) {
      return send(res, 400, { ok: false, message: error.message });
    }
  }

  return send(res, 404, { ok: false, message: "Not found." });
});

function start() {
  server.on("error", (error) => {
    console.error(JSON.stringify({ ok: false, message: "Local helper could not start.", port, error: error.message }, null, 2));
    process.exit(1);
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(JSON.stringify({ ok: true, message: "Figma HTML Loop local helper is running.", bridgeUrl: `http://localhost:${port}` }, null, 2));
  });
  return server;
}

// Run the helper when invoked directly; export pure helpers for unit tests / reuse.
if (require.main === module) start();

module.exports = {
  start,
  server,
  cssColorToFigma,
  parseBoxShadow,
  parseLinearGradient,
  parseGradient,
  parseGradientLayers,
  parseFilterEffects,
  parseBackdropBlur,
  gradientAngleFromDirection,
  perCornerRadii,
  cssToAutoLayout,
  cssToFigmaStyle,
  stylePatchFromCapture,
  createOperationFromCapture,
  makePatch,
  buildPagePatch,
  writebackManifest,
  injectFigmaIds,
  annotateCreateIds,
  convertSegments,
  compositionContentExtent,
  longScreenCss,
  slugifyName,
  exportStamp,
  exportDisplayName,
  archiveExport,
  listExportArchives
};
