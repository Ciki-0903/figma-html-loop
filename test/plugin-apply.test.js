// Tests for the Figma plugin's apply pipeline, run against the in-memory mock.
const { test } = require("node:test");
const assert = require("node:assert");
const { makeFigmaEnv, loadPlugin, countTree, findByName } = require("./figma-mock.js");

test("gradientTransformFromAngle: 90/0/180deg", () => {
  const { figma } = makeFigmaEnv();
  const { gradientTransformFromAngle } = loadPlugin(figma);
  const approx = (a, b) => Math.abs(a - b) < 1e-9;
  const g90 = gradientTransformFromAngle(90);
  assert.ok(approx(g90[0][0], 1) && approx(g90[0][1], 0) && approx(g90[0][2], 0));
  const g0 = gradientTransformFromAngle(0);
  assert.ok(approx(g0[0][0], 0) && approx(g0[0][1], -1) && approx(g0[0][2], 1));
});

test("paintsFromStyle: solid fallback + linear gradient", () => {
  const { figma } = makeFigmaEnv();
  const { paintsFromStyle } = loadPlugin(figma);
  const solid = paintsFromStyle({ fill: { r: 0.5, g: 0.5, b: 0.5, a: 0.8 } });
  assert.strictEqual(solid[0].type, "SOLID");
  assert.ok(Math.abs(solid[0].opacity - 0.8) < 1e-9);
  const grad = paintsFromStyle({ fills: [{ type: "GRADIENT_LINEAR", angle: 90, stops: [{ position: 0, r: 1, g: 0, b: 0, a: 1 }, { position: 1, r: 0, g: 0, b: 1, a: 1 }] }] });
  assert.strictEqual(grad[0].type, "GRADIENT_LINEAR");
  assert.strictEqual(grad[0].gradientStops.length, 2);
});

test("weightToStyleNames: numeric weight → Figma style", () => {
  const { figma } = makeFigmaEnv();
  const { weightToStyleNames } = loadPlugin(figma);
  assert.strictEqual(weightToStyleNames(700, false)[0], "Bold");
  assert.strictEqual(weightToStyleNames(600, false)[0], "Semi Bold");
  assert.ok(weightToStyleNames(400, true).includes("Italic"));
});

test("applyPatch: new page + nested create + createId→figmaId mapping", async () => {
  const { figma, pages } = makeFigmaEnv();
  const { applyPatch } = loadPlugin(figma);
  const patch = {
    page: { create: true, name: "PAGE-X" },
    operations: [{
      action: "create", id: "root", kind: "frame", name: "Root",
      style: { x: 0, y: 0, width: 200, height: 100, cornerRadius: 12 },
      children: [
        { action: "create", id: "t", kind: "text", name: "Label", text: "Hi", style: { x: 16, y: 16, width: 100, height: 20 } }
      ]
    }]
  };
  const res = await applyPatch(patch);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(pages.length, 1);
  assert.strictEqual(pages[0].name, "PAGE-X");
  const root = pages[0].children[0];
  assert.strictEqual(root.name, "Root");
  assert.strictEqual(countTree(root), 2);
  // mapping present for root + nested child
  assert.ok(res.created.root && res.created.t);
  assert.strictEqual(res.page.name, "PAGE-X");
});

test("applyPatch: auto-layout frame configured; children flow", async () => {
  const { figma, pages } = makeFigmaEnv();
  const { applyPatch } = loadPlugin(figma);
  const patch = {
    page: { create: true, name: "AL" },
    operations: [{
      action: "create", id: "card", kind: "frame", name: "Card",
      style: {
        x: 0, y: 0, width: 200, height: 90,
        autoLayout: { mode: "VERTICAL", itemSpacing: 12, paddingTop: 16, paddingRight: 16, paddingBottom: 16, paddingLeft: 16, primaryAxisAlignItems: "MIN", counterAxisAlignItems: "MIN", counterStretch: true }
      },
      children: [
        { action: "create", id: "t1", kind: "text", name: "T1", text: "A", style: { x: 0, y: 0, width: 100, height: 20 } }
      ]
    }]
  };
  const res = await applyPatch(patch);
  assert.strictEqual(res.ok, true);
  const card = findByName(pages[0], "Card");
  assert.strictEqual(card.layoutMode, "VERTICAL");
  assert.strictEqual(card.itemSpacing, 12);
  assert.strictEqual(card.paddingLeft, 16);
  assert.strictEqual(card.primaryAxisSizingMode, "FIXED");
  assert.strictEqual(card.width, 200);
  // align-items stretch → child layoutAlign STRETCH
  const t1 = findByName(pages[0], "T1");
  assert.strictEqual(t1.layoutAlign, "STRETCH");
});

test("applyPatch: rich-text segments applied + textAutoResize NONE", async () => {
  const { figma, pages } = makeFigmaEnv();
  const { applyPatch } = loadPlugin(figma);
  const patch = {
    page: { create: true, name: "RT" },
    operations: [{
      action: "create", id: "amt", kind: "text", name: "amount", text: "¥520/5000",
      style: { x: 0, y: 0, width: 120, height: 24 },
      segments: [
        { start: 0, end: 1, fontSize: 16, fontWeight: 400, fill: { r: 1, g: 0, b: 0, a: 1 } },
        { start: 1, end: 4, fontSize: 24, fontWeight: 700, fill: { r: 0, g: 0, b: 0, a: 1 } },
        { start: 4, end: 9, fontSize: 14, fontWeight: 400, fill: { r: 0.5, g: 0.5, b: 0.5, a: 1 } }
      ]
    }]
  };
  const res = await applyPatch(patch);
  assert.strictEqual(res.ok, true);
  const amt = findByName(pages[0], "amount");
  assert.strictEqual(amt.characters, "¥520/5000");
  assert.strictEqual(amt.textAutoResize, "NONE");
  // per-range calls happened (font+size+fills for 3 segments)
  const sizes = amt._ranges.filter((r) => r.kind === "size");
  const fills = amt._ranges.filter((r) => r.kind === "fills");
  assert.strictEqual(sizes.length, 3);
  assert.strictEqual(fills.length, 3);
  assert.ok(sizes.some((r) => r.s === 24), "middle run is 24px");
});

test("applyPatch: svg node created from svgContent", async () => {
  const { figma, pages } = makeFigmaEnv();
  const { applyPatch } = loadPlugin(figma);
  const svg = '<svg width="16" height="16"><path d="M0 0h16v16H0z"/></svg>';
  const res = await applyPatch({
    page: { create: true, name: "SVG" },
    operations: [{ action: "create", id: "ic", kind: "svg", name: "icon", svgContent: svg, style: { x: 5, y: 5, width: 16, height: 16 } }]
  });
  assert.strictEqual(res.ok, true);
  const icon = findByName(pages[0], "icon");
  assert.ok(icon, "svg node created");
  assert.strictEqual(icon._svg, svg);
  assert.strictEqual(icon.width, 16);
});

test("applyPatch: new-page build rolls back on failure (transactional)", async () => {
  const { figma, pages } = makeFigmaEnv();
  const { applyPatch } = loadPlugin(figma);
  const res = await applyPatch({
    page: { create: true, name: "RB" },
    operations: [
      { action: "create", id: "a", kind: "frame", name: "Card", style: { x: 0, y: 0, width: 100, height: 50 } },
      { action: "update", id: "missing", style: { fill: { r: 1, g: 0, b: 0, a: 1 } } } // fails: node not found
    ]
  });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.rolledBack, true);
  assert.strictEqual(res.page, null);
  assert.ok(res.counts.failed >= 1);
  assert.ok(pages[0].removed, "new page removed on rollback — no half-built page");
});

test("applyPatch: counts reported (created/deleted)", async () => {
  const { figma } = makeFigmaEnv();
  const { applyPatch } = loadPlugin(figma);
  const victim = figma.createRectangle();
  const res = await applyPatch({
    operations: [
      { action: "create", id: "n1", kind: "frame", name: "F", style: { x: 0, y: 0, width: 10, height: 10 } },
      { action: "delete", id: victim.id }
    ]
  });
  assert.strictEqual(res.counts.created, 1);
  assert.strictEqual(res.counts.deleted, 1);
  assert.strictEqual(res.counts.failed, 0);
});

test("applyPatch: delete removes a node", async () => {
  const { figma } = makeFigmaEnv();
  const { applyPatch } = loadPlugin(figma);
  const victim = figma.createRectangle();
  const res = await applyPatch({ operations: [{ action: "delete", id: victim.id }] });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(victim.removed, true);
  // deleting an already-gone node is treated as success
  const res2 = await applyPatch({ operations: [{ action: "delete", id: "nonexistent" }] });
  assert.strictEqual(res2.ok, true);
});
