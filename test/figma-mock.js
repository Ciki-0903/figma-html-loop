// Minimal in-memory Figma Plugin API mock + a loader that evaluates the real
// plugin code.js against it. Lets tests exercise applyPatch/buildNodeFromSpec
// without a running Figma. The mock records the properties we assert on; it does
// not perform real layout (auto-layout props are recorded, not computed).

const fs = require("fs");
const path = require("path");
const vm = require("vm");

function makeFigmaEnv() {
  let idc = 0;
  const pages = [];
  const registry = new Map();

  function mk(type) {
    const n = {
      type,
      id: "n" + (++idc),
      name: "",
      children: [],
      fills: [],
      strokes: [],
      effects: [],
      opacity: 1,
      visible: true,
      cornerRadius: 0,
      topLeftRadius: 0, topRightRadius: 0, bottomRightRadius: 0, bottomLeftRadius: 0,
      strokeWeight: 1,
      clipsContent: false,
      layoutMode: "NONE", layoutWrap: "NO_WRAP",
      itemSpacing: 0, counterAxisSpacing: 0,
      paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0,
      primaryAxisAlignItems: "MIN", counterAxisAlignItems: "MIN",
      primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO",
      layoutAlign: "INHERIT", layoutGrow: 0, layoutPositioning: "AUTO",
      width: 1, height: 1, x: 0, y: 0, removed: false,
      resize(w, h) { this.width = w; this.height = h; },
      appendChild(c) {
        if (c.parent && c.parent.children) {
          const i = c.parent.children.indexOf(c);
          if (i >= 0) c.parent.children.splice(i, 1);
        }
        c.parent = this;
        this.children.push(c);
      },
      remove() { this.removed = true; registry.delete(this.id); }
    };
    if (type === "TEXT") {
      n.characters = "";
      n.fontName = { family: "Inter", style: "Regular" };
      n.fontSize = 12;
      n.lineHeight = { unit: "AUTO" };
      n.letterSpacing = { unit: "PERCENT", value: 0 };
      n.textAlignHorizontal = "LEFT";
      n.textDecoration = "NONE";
      n.textAutoResize = "WIDTH_AND_HEIGHT";
      n._ranges = [];
      n.setRangeFontName = function (a, b, f) { this._ranges.push({ kind: "font", a, b, f }); };
      n.setRangeFontSize = function (a, b, s) { this._ranges.push({ kind: "size", a, b, s }); };
      n.setRangeFills = function (a, b, fills) { this._ranges.push({ kind: "fills", a, b, fills }); };
    }
    registry.set(n.id, n);
    return n;
  }

  const figma = {
    showUI() {}, on() {}, mixed: Symbol("mixed"),
    currentPage: { selection: [], children: [], id: "p0", name: "Page 1" },
    ui: { postMessage() {}, onmessage: null },
    viewport: { scrollAndZoomIntoView() {} },
    createPage() { const p = mk("PAGE"); p.name = "Page"; pages.push(p); return p; },
    async setCurrentPageAsync(p) { this.currentPage = p; },
    createFrame() { return mk("FRAME"); },
    createText() { return mk("TEXT"); },
    createRectangle() { return mk("RECTANGLE"); },
    createNodeFromSvg(svg) { const n = mk("FRAME"); n._svg = String(svg || ""); return n; },
    createImage() { return { hash: "imghash" + (++idc) }; },
    base64Decode() { return new Uint8Array(4); },
    async loadFontAsync() {},
    async getNodeByIdAsync(id) { return registry.get(String(id)) || null; }
  };

  return { figma, pages, registry };
}

function loadPlugin(figma) {
  const code = fs.readFileSync(
    path.resolve(__dirname, "..", "packages", "plugin", "figma-plugin", "code.js"),
    "utf8"
  );
  const ctx = {
    figma, __html__: "", console, Math, Array, Object, Number, String,
    Symbol, Set, Map, Promise, setTimeout, JSON, Uint8Array
  };
  vm.createContext(ctx);
  vm.runInContext(
    code + "\n;globalThis.__exports={applyPatch, gradientTransformFromAngle, paintsFromStyle, effectsFromStyle, weightToStyleNames, applyCornerRadius};",
    ctx
  );
  return ctx.__exports;
}

// Recursively count nodes under a parent.
function countTree(node) {
  let c = 1;
  for (const k of node.children || []) c += countTree(k);
  return c;
}

function findByName(node, name) {
  if (node.name === name) return node;
  for (const c of node.children || []) {
    const r = findByName(c, name);
    if (r) return r;
  }
  return null;
}

module.exports = { makeFigmaEnv, loadPlugin, countTree, findByName };
