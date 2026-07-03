const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const FONT_EXTENSIONS = new Set([".ttf", ".otf", ".ttc", ".woff", ".woff2"]);
const STYLE_WEIGHTS = [
  ["ultralight", 200],
  ["extralight", 200],
  ["thin", 100],
  ["light", 300],
  ["regular", 400],
  ["normal", 400],
  ["medium", 500],
  ["semibold", 600],
  ["demibold", 600],
  ["bold", 700],
  ["extrabold", 800],
  ["heavy", 900],
  ["black", 900],
];

function normalizeName(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
}

function cssString(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function inferWeight(styleOrName, fallback = 400) {
  const raw = normalizeName(styleOrName);
  for (const [needle, weight] of STYLE_WEIGHTS) {
    if (raw.includes(needle)) return weight;
  }
  return fallback;
}

function fontFormat(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".woff2") return "woff2";
  if (ext === ".woff") return "woff";
  if (ext === ".otf") return "opentype";
  if (ext === ".ttf") return "truetype";
  if (ext === ".ttc") return "truetype-collection";
  return "truetype";
}

function safeFontFileName(file, used) {
  const ext = path.extname(file);
  const base = path.basename(file, ext).replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "font";
  let name = `${base}${ext}`;
  let i = 2;
  while (used.has(name)) {
    name = `${base}-${i}${ext}`;
    i += 1;
  }
  used.add(name);
  return name;
}

function scanFontFiles() {
  const roots = [
    path.join(process.env.HOME || "", "Library", "Fonts"),
    "/Library/Fonts",
    "/System/Library/Fonts",
    "/System/Library/Fonts/Supplemental",
    "/System/Library/PrivateFrameworks/FontServices.framework/Resources/Reserved",
  ];
  const out = [];
  const seen = new Set();

  function walk(dir, depth = 0) {
    if (!dir || seen.has(dir) || depth > 4) return;
    seen.add(dir);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile() && FONT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        out.push(full);
      }
    }
  }

  roots.forEach((root) => walk(root));
  return out;
}

function systemFontRecords() {
  try {
    const raw = execFileSync("system_profiler", ["SPFontsDataType", "-json"], {
      encoding: "utf8",
      timeout: 20000,
      maxBuffer: 30 * 1024 * 1024,
    });
    const data = JSON.parse(raw);
    const records = [];
    for (const font of data.SPFontsDataType || []) {
      const filePath = font.path;
      if (!filePath || !fs.existsSync(filePath)) continue;
      for (const face of font.typefaces || []) {
        records.push({
          path: filePath,
          postscript: face._name || "",
          family: face.family || face.fullname || "",
          style: face.style || face._name || "",
          embeddable: face.embeddable !== "no",
        });
      }
      records.push({
        path: filePath,
        postscript: font._name || "",
        family: font._name || "",
        style: font._name || "",
        embeddable: font.copy_protected !== "yes",
      });
    }
    return records;
  } catch {
    return [];
  }
}

function buildFontIndex() {
  const records = systemFontRecords();
  const known = new Set(records.map((record) => record.path));
  for (const filePath of scanFontFiles()) {
    if (known.has(filePath)) continue;
    const base = path.basename(filePath, path.extname(filePath));
    records.push({
      path: filePath,
      postscript: base,
      family: base,
      style: base,
      embeddable: true,
    });
  }
  return records;
}

function weightDistance(record, requestedWeight) {
  const weight = inferWeight(`${record.postscript} ${record.style}`, requestedWeight || 400);
  return Math.abs(weight - (requestedWeight || 400));
}

function familyAliases(family) {
  const familyNorm = normalizeName(family);
  const aliases = new Set([familyNorm]);
  if (familyNorm.startsWith("sfpro") || familyNorm.startsWith("sanfrancisco")) {
    aliases.add("sfns");
    aliases.add("sfui");
  }
  if (familyNorm === "pingfangsc") {
    aliases.add("pingfang");
    aliases.add("苹方简");
  }
  return Array.from(aliases).filter(Boolean);
}

function findFontFile(index, request) {
  const familyNorms = familyAliases(request.family);
  const styleNorm = normalizeName(request.style);
  const candidates = index
    .filter((record) => {
      if (!record.embeddable || !record.path || !fs.existsSync(record.path)) return false;
      const haystack = normalizeName(`${record.postscript} ${record.family} ${path.basename(record.path)}`);
      return familyNorms.some((familyNorm) => haystack.includes(familyNorm) || familyNorm.includes(haystack));
    })
    .map((record) => {
      const styleHaystack = normalizeName(`${record.postscript} ${record.style} ${path.basename(record.path)}`);
      let score = weightDistance(record, request.weight);
      if (styleNorm && styleHaystack.includes(styleNorm)) score -= 20;
      const requestNorm = normalizeName(request.family);
      if (!requestNorm.includes("mono") && styleHaystack.includes("mono")) score += 100;
      if (!requestNorm.includes("rounded") && styleHaystack.includes("rounded")) score += 80;
      if (!requestNorm.includes("compact") && styleHaystack.includes("compact")) score += 60;
      if (requestNorm.startsWith("sfpro") && normalizeName(path.basename(record.path)) === "sfnsttf") score -= 50;
      if (path.extname(record.path).toLowerCase() === ".woff2") score -= 8;
      if (path.extname(record.path).toLowerCase() === ".ttf") score -= 4;
      if (familyNorms.some((familyNorm) => normalizeName(path.basename(record.path)).includes(familyNorm))) score -= 3;
      return { record, score };
    })
    .sort((a, b) => a.score - b.score);
  return candidates[0] ? candidates[0].record.path : null;
}

function addRequest(map, family, weight, style) {
  if (!family) return;
  const cleanedFamily = String(family).replace(/^['"]|['"]$/g, "").trim();
  if (!cleanedFamily || /^(sans-serif|serif|monospace|system-ui|-apple-system)$/i.test(cleanedFamily)) return;
  const key = `${cleanedFamily}|${weight || inferWeight(style)}|${style || ""}`;
  map.set(key, {
    family: cleanedFamily,
    weight: Number(weight || inferWeight(style) || 400),
    style: /italic/i.test(String(style || "")) ? "italic" : "normal",
    originalStyle: style || "",
  });
}

function collectRequestedFonts(manifest, html = "", css = "") {
  const requests = new Map();
  const manifestFonts = manifest && manifest.fonts && Array.isArray(manifest.fonts.used) ? manifest.fonts.used : [];
  for (const font of manifestFonts) {
    const styles = Array.isArray(font.styles) && font.styles.length ? font.styles : [""];
    const weights = Array.isArray(font.weights) && font.weights.length ? font.weights : [400];
    for (const style of styles) {
      for (const weight of weights) addRequest(requests, font.family, weight, style);
    }
  }

  const source = `${html}\n${css}`;
  const re = /font-family\s*:\s*([^;"']+|'[^']+'|"[^"]+")/gi;
  let match;
  while ((match = re.exec(source))) {
    const family = match[1].split(",")[0].trim();
    [400, 500, 600, 700].forEach((weight) => addRequest(requests, family, weight, ""));
  }
  return Array.from(requests.values());
}

function stripExistingFontFace(css) {
  return String(css || "")
    .replace(/\/\* figma-html-loop-fonts:start \*\/[\s\S]*?\/\* figma-html-loop-fonts:end \*\/\n?/g, "")
    .replace(/@font-face\s*\{[^}]*fonts\/[^}]*\}\n?/g, "");
}

function packageFontsForExport(outDir, manifest, options = {}) {
  const htmlPath = path.join(outDir, "index.html");
  const cssPath = path.join(outDir, "styles.css");
  if (!fs.existsSync(cssPath)) return { embedded: [], missing: [], cssInjected: false };

  const html = fs.existsSync(htmlPath) ? fs.readFileSync(htmlPath, "utf8") : "";
  const css = fs.readFileSync(cssPath, "utf8");
  const requests = collectRequestedFonts(manifest, html, css);
  if (!requests.length) return { embedded: [], missing: [], cssInjected: false };

  const index = buildFontIndex();
  const fontsDir = path.join(outDir, "fonts");
  fs.mkdirSync(fontsDir, { recursive: true });
  for (const entry of fs.readdirSync(fontsDir, { withFileTypes: true })) {
    if (entry.isFile() && FONT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      fs.rmSync(path.join(fontsDir, entry.name), { force: true });
    }
  }
  const usedNames = new Set();
  const bySource = new Map();
  const embedded = [];
  const missing = [];
  const cssBlocks = [];

  for (const request of requests) {
    const source = findFontFile(index, request);
    if (!source) {
      missing.push(request);
      continue;
    }
    let fileName = bySource.get(source);
    if (!fileName) {
      fileName = safeFontFileName(source, usedNames);
      fs.copyFileSync(source, path.join(fontsDir, fileName));
      bySource.set(source, fileName);
    }
    embedded.push({ ...request, file: `fonts/${fileName}`, source });
    cssBlocks.push(
      `@font-face{font-family:'${cssString(request.family)}';src:url('fonts/${cssString(fileName)}') format('${fontFormat(fileName)}');font-weight:${request.weight};font-style:${request.style};font-display:block;}`
    );
  }

  const nextCss = `${cssBlocks.length ? `/* figma-html-loop-fonts:start */\n${cssBlocks.join("\n")}\n/* figma-html-loop-fonts:end */\n` : ""}${stripExistingFontFace(css)}`;
  if (nextCss !== css) fs.writeFileSync(cssPath, nextCss, "utf8");

  if (manifest) {
    manifest.fonts = {
      ...(manifest.fonts || {}),
      embedded: embedded.map(({ source, ...font }) => font),
      missing,
    };
    const manifestPath = path.join(outDir, "loop-manifest.json");
    if (fs.existsSync(manifestPath) && options.writeManifest !== false) {
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    }
  }

  return { embedded: embedded.map(({ source, ...font }) => font), missing, cssInjected: cssBlocks.length > 0 };
}

module.exports = {
  collectRequestedFonts,
  packageFontsForExport,
};
