#!/usr/bin/env node

const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const { spawn } = require("child_process");
const { URL } = require("url");
const { packageFontsForExport } = require("./font-packager");

const port = Number(process.env.FIGMA_HTML_LOOP_PORT || 7800);
const projectRoot = path.resolve(__dirname, "..", "..", "..");
const bridgeEngineDist = path.resolve(__dirname, "..", "..", "bridge-engine", "dist");
const cacheRoot = path.resolve(__dirname, "..", "..", "..", "temp");
const defaultExportDir = path.join(projectRoot, "figma-html-loop-export");
const imageCacheDir = path.join(cacheRoot, "images");
const svgCacheDir = path.join(cacheRoot, "svgs");
const helperVersion = "roundtrip-1.0";

let latestSelection = null;
let pendingPatch = null;
let lastApplied = null;
let latestCapture = null;

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
    ".figma-node{box-sizing:border-box;}"
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
  const shellCss = [
    `.figma-export{position:relative;width:${width}px;height:${height}px;overflow:visible;background:transparent;}`,
    `.figma-export>.content-layer{position:relative;width:${width}px;height:${height}px;}`
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
      // Flex layout → Figma auto-layout
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
    const nodes = {};
    const created = [];
    const selector = "[data-figma-id], [data-figma-create], [data-figma-new]";
    document.querySelectorAll(selector).forEach((el, index) => {
      if (!(el instanceof HTMLElement)) return;
      const cs = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 && rect.height <= 0) return;
      const bounds = {
        x: round(rect.left - rootRect.left + root.scrollLeft),
        y: round(rect.top - rootRect.top + root.scrollTop),
        width: round(rect.width),
        height: round(rect.height)
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
          local = { x: round(rect.left - pr.left), y: round(rect.top - pr.top) };
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

function imageBase64FromCapture(src) {
  const raw = String(src || "").trim();
  if (!raw) return "";
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

// Convert a CSS linear-gradient direction keyword or angle into a CSS-degrees value.
function gradientAngleFromDirection(token) {
  const t = String(token || "").trim().toLowerCase();
  const deg = t.match(/^(-?\d+(?:\.\d+)?)deg$/);
  if (deg) return Number(deg[1]);
  if (t.startsWith("to ")) {
    const dir = t.slice(3).trim();
    const map = {
      "top": 0, "right": 90, "bottom": 180, "left": 270,
      "top right": 45, "right top": 45,
      "bottom right": 135, "right bottom": 135,
      "bottom left": 225, "left bottom": 225,
      "top left": 315, "left top": 315
    };
    if (map[dir] != null) return map[dir];
  }
  return null;
}

// Extract color stops from gradient argument parts (skips non-color args like
// shape/size/position/angle that may precede the stops in radial/conic).
function parseGradientStops(args) {
  const stops = [];
  const colorParts = args.filter((sp) => extractColorToken(sp).color);
  colorParts.forEach((sp, idx) => {
    const { color, rest } = extractColorToken(sp);
    const fill = cssColorToFigma(color);
    if (!fill) return;
    const pct = rest.match(/(-?\d+(?:\.\d+)?)%/);
    let position = pct ? Number(pct[1]) / 100 : (colorParts.length > 1 ? idx / (colorParts.length - 1) : 0);
    position = Math.max(0, Math.min(1, position));
    stops.push({ position, r: fill.r, g: fill.g, b: fill.b, a: fill.a == null ? 1 : fill.a });
  });
  return stops;
}

// Parse any CSS gradient into a Figma gradient descriptor.
// { type:'GRADIENT_LINEAR'|'GRADIENT_RADIAL'|'GRADIENT_ANGULAR', angle?, stops }
function parseGradient(value) {
  const raw = String(value || "").trim();
  let m = raw.match(/linear-gradient\(([\s\S]*)\)/i);
  if (m) {
    const args = splitTopLevel(m[1]);
    if (!args.length) return null;
    let angle = 180, start = 0;
    const maybeAngle = gradientAngleFromDirection(args[0]);
    if (maybeAngle != null && !/rgba?\(|#[0-9a-f]/i.test(args[0])) { angle = maybeAngle; start = 1; }
    const stops = parseGradientStops(args.slice(start));
    return stops.length >= 2 ? { type: "GRADIENT_LINEAR", angle, stops } : null;
  }
  m = raw.match(/radial-gradient\(([\s\S]*)\)/i);
  if (m) {
    const stops = parseGradientStops(splitTopLevel(m[1]));
    return stops.length >= 2 ? { type: "GRADIENT_RADIAL", stops } : null;
  }
  m = raw.match(/conic-gradient\(([\s\S]*)\)/i);
  if (m) {
    const stops = parseGradientStops(splitTopLevel(m[1]));
    return stops.length >= 2 ? { type: "GRADIENT_ANGULAR", stops } : null;
  }
  return null;
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

// Translate CSS flexbox into a Figma auto-layout descriptor, or null if not flex.
function cssToAutoLayout(css) {
  const disp = String((css && css.display) || "").trim();
  if (disp !== "flex" && disp !== "inline-flex") return null;
  const dir = String(css.flexDirection || "row").trim();
  const isColumn = dir.indexOf("column") === 0;
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
  return al;
}

// The single source of truth for turning captured CSS into a Figma style patch.
// Shared by both update (stylePatchFromCapture) and create (createOperationFromCapture).
function cssToFigmaStyle(css, isText) {
  const style = {};
  css = css || {};
  const get = (camel, kebab) => (css[camel] != null ? css[camel] : css[kebab]);

  // Fills: text uses color; shapes prefer gradient, then background color.
  if (isText) {
    const fill = cssColorToFigma(css.color);
    if (fill && fill.a !== 0) style.fill = fill;
  } else {
    const bgImage = get("backgroundImage", "background-image");
    const gradient = bgImage ? parseGradient(bgImage) : null;
    if (gradient) {
      const f = { type: gradient.type, stops: gradient.stops };
      if (gradient.angle != null) f.angle = gradient.angle;
      style.fills = [f];
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
  const filterFx = parseFilterEffects(get("filter", "filter"));
  if (filterFx) effects = effects.concat(filterFx);
  const backdropFx = parseBackdropBlur(get("backdropFilter", "backdrop-filter"));
  if (backdropFx) effects = effects.concat([backdropFx]);
  if (effects.length) style.effects = effects;

  // Visibility.
  const visibility = get("visibility", "visibility");
  if (visibility === "hidden") style.visible = false;

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

// Remove captured style properties that match the exported baseline, so an
// update only carries what actually changed (no whole-page re-emission).
const NON_BOX_TYPES = ["ELLIPSE", "VECTOR", "STAR", "POLYGON", "LINE", "BOOLEAN_OPERATION"];
function dropUnchangedStyle(style, original) {
  const orig = normManifestStyle(original && original.style);
  if (style.fill && orig.fill && colorEq(style.fill, orig.fill)) delete style.fill;

  // Gradient fill. Drop when it matches a gradient baseline stop-for-stop, or when
  // the baseline is a solid and every captured stop is that same colour (a uniform
  // gradient the browser renders for what Figma stores as a plain solid fill).
  if (Array.isArray(style.fills) && style.fills.length) {
    const g = style.fills.find((f) => f && Array.isArray(f.stops)) || style.fills[0];
    const stops = g && Array.isArray(g.stops) ? g.stops : null;
    if (stops) {
      if (orig.isGradient && Array.isArray(orig.gradStops)) {
        const sig = stops.map((s) => [Number(s.position) || 0, s.r, s.g, s.b, s.a == null ? 1 : s.a]);
        if (gradientStopsEq(sig, orig.gradStops)) delete style.fills;
      } else if (orig.fill && stops.every((s) => colorEq({ r: s.r, g: s.g, b: s.b, a: s.a }, orig.fill))) {
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
  return style;
}

// Properties the manifest cannot baseline (font metadata; effects) so they can't
// be diffed. Re-applying identical values is a pure no-op. Emit them only when
// the layer shows an independently-verified change (text edited, or a
// baseline-backed property like fill/opacity/radius/layout actually differs);
// otherwise an unchanged layer would re-emit them on every reflow.
const UNBASELINED_PROPS = ["fontSize", "fontWeight", "fontFamily", "fontStyle", "textAlign", "lineHeightPx", "letterSpacing", "textDecoration", "effects"];
function stripUnbaselinedProps(style, textChanged) {
  if (textChanged) return style;
  const keys = Object.keys(style);
  const hasBaselineChange = keys.some((k) => UNBASELINED_PROPS.indexOf(k) === -1);
  if (!hasBaselineChange) for (const k of keys) if (UNBASELINED_PROPS.indexOf(k) !== -1) delete style[k];
  return style;
}

function stylePatchFromCapture(original, current) {
  const bounds = current && current.bounds ? current.bounds : {};
  const originalLayout = manifestLayout(original);
  const isText = String(original && original.type || "").toUpperCase() === "TEXT";

  // Only emit visual properties that actually changed from the exported baseline.
  const css = current && current.style ? current.style : {};
  const style = cssToFigmaStyle(css, isText);
  // Auto-layout is a create-only concern; never restructure an existing node.
  delete style.autoLayout;
  delete style.layoutGrow;
  delete style.absolutePos;
  // Keep only properties that actually changed vs the exported baseline.
  dropUnchangedStyle(style, original);

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
    // Only fontSize / metrics that come with a real size change survive.
    if (!(wChanged || hChanged)) {
      delete style.fontSize;
      delete style.lineHeightPx;
      delete style.letterSpacing;
    }
  } else {
    if (wChanged) style.width = width;
    if (hChanged) style.height = height;
    if (isAbsolute) {
      if (Number.isFinite(x) && Math.abs(x - Number(originalLayout.left ?? original.x ?? 0)) > 0.5) style.x = x;
      if (Number.isFinite(y) && Math.abs(y - Number(originalLayout.top ?? original.y ?? 0)) > 0.5) style.y = y;
    }
  }

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
  const style = Object.assign(cssToFigmaStyle(css, isText), {
    x: Math.max(0, Number(bounds.x || 0) - parentX),
    y: Math.max(0, Number(bounds.y || 0) - parentY),
    width: Math.max(1, Number(bounds.width || 1)),
    height: Math.max(1, Number(bounds.height || 1)),
  });
  return {
    action: "create",
    id: item.createId || `html_${Date.now()}`,
    parentId,
    kind: kind === "img" ? "image" : kind,
    name: item.name || "HTML layer",
    text: item.text || "",
    imageBase64: imageBase64FromCapture(item.imageSrc),
    style
  };
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
    const style = cssToFigmaStyle(it.style || {}, isText);
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
    if (kind === "image" || (kind !== "svg" && it.imageSrc)) {
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
    if (childSpecs.length) spec.children = childSpecs;

    // A container that positions any child absolutely is an overlay/positioning
    // context, not a flow layout. Auto-layout + absolute children is fragile, so
    // drop auto-layout here and keep all children at their captured x/y.
    if (spec.style.autoLayout && childSpecs.some((c) => c && c.style && c.style.absolutePos)) {
      delete spec.style.autoLayout;
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
  slugifyName,
  exportStamp,
  exportDisplayName,
  archiveExport,
  listExportArchives
};
