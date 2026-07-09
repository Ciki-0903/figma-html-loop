// Regression tests locking in the two hardest fixes:
//  ② position coordinate-system (local vs absolute)
//  ③ create → write-back → update closed loop
const { test } = require("node:test");
const assert = require("node:assert");
const S = require("../packages/local-helper/src/server.js");
const { makeFigmaEnv, loadPlugin } = require("./figma-mock.js");

test("② nested node with absolute≠local coords is not falsely moved", () => {
  const manifest = { rootIds: ["A"], nodes: {
    A: { id: "A", type: "FRAME", layout: { left: 30, top: 40, width: 200, height: 200 } },
    B: { id: "B", type: "RECTANGLE", layout: { position: "absolute", left: 20, top: 20, width: 100, height: 40 } }
  } };
  const capture = { source: "x", created: [], nodes: {
    A: { local: { x: 30, y: 40 }, bounds: { x: 30, y: 40, width: 200, height: 200 }, style: {} },
    // a fill so an op exists; absolute bounds (50,60) differ from local (20,20)
    B: { local: { x: 20, y: 20 }, bounds: { x: 50, y: 60, width: 100, height: 40 }, style: { backgroundColor: "#eeeeee" } }
  } };
  const patch = S.makePatch(manifest, capture);
  const b = patch.operations.find((o) => o.id === "B");
  assert.ok(b && b.style && b.style.fill, "B has a fill update");
  assert.strictEqual(b.style.x, undefined, "B not moved on x (local coords)");
  assert.strictEqual(b.style.y, undefined, "B not moved on y (local coords)");
});

test("② a genuinely moved node emits local x/y", () => {
  const manifest = { rootIds: ["A"], nodes: {
    A: { id: "A", type: "FRAME", layout: { left: 0, top: 0, width: 200, height: 200 } },
    C: { id: "C", type: "RECTANGLE", layout: { position: "absolute", left: 20, top: 80, width: 100, height: 40 } }
  } };
  const capture = { source: "x", created: [], nodes: {
    A: { local: { x: 0, y: 0 }, bounds: { x: 0, y: 0, width: 200, height: 200 }, style: {} },
    C: { local: { x: 40, y: 90 }, bounds: { x: 40, y: 90, width: 100, height: 40 }, style: {} }
  } };
  const patch = S.makePatch(manifest, capture);
  const c = patch.operations.find((o) => o.id === "C");
  assert.strictEqual(c.style.x, 40);
  assert.strictEqual(c.style.y, 90);
});

test("③ closed loop: create → apply(map) → writeback manifest → re-diff yields UPDATE not create", async () => {
  // 1) capture of freshly-annotated HTML (stable createIds)
  const capture1 = { source: "x", created: [
    { createId: "ci_1", parentCreateId: "", name: "Card", kind: "frame", text: "", bounds: { x: 20, y: 20, width: 200, height: 80 }, style: { backgroundColor: "#ffffff" } },
    { createId: "ci_2", parentCreateId: "ci_1", name: "Title", kind: "text", text: "标题", bounds: { x: 36, y: 36, width: 168, height: 22 }, style: { color: "#111111", fontSize: "16px" } }
  ] };

  // 2) build-page patch, 3) apply in the mock to obtain createId→figmaId
  const patch = S.buildPagePatch(capture1, { pageName: "WB" });
  const { figma } = makeFigmaEnv();
  const { applyPatch } = loadPlugin(figma);
  const res = await applyPatch(patch);
  const map = res.created;
  assert.ok(map["ci_1"] && map["ci_2"], "mapping has both nodes");

  // 4) manifest generated from capture + map
  const manifest = S.writebackManifest(capture1, map);
  const titleFid = map["ci_2"];
  assert.strictEqual(manifest.nodes[titleFid].type, "TEXT");

  // 5) re-capture after write-back: elements now carry data-figma-id, so they
  //    appear as `nodes` (parent-relative local coords), created is empty.
  //    The title's colour changed to red.
  const byCid = new Map(capture1.created.map((it) => [it.createId, it]));
  const nodes = {};
  for (const it of capture1.created) {
    const fid = map[it.createId];
    const parent = it.parentCreateId ? byCid.get(it.parentCreateId) : null;
    const pb = parent ? parent.bounds : null;
    const style = it.createId === "ci_2" ? { color: "#ff0000", fontSize: "16px" } : it.style;
    nodes[fid] = {
      local: { x: pb ? it.bounds.x - pb.x : it.bounds.x, y: pb ? it.bounds.y - pb.y : it.bounds.y },
      bounds: it.bounds,
      text: it.text,
      style
    };
  }
  const capture2 = { source: "x", created: [], nodes };

  // 6) diff against generated manifest
  const patch2 = S.makePatch(manifest, capture2);
  const creates = patch2.operations.filter((o) => o.action === "create");
  assert.strictEqual(creates.length, 0, "no re-creation");
  const upd = patch2.operations.find((o) => o.id === titleFid);
  assert.ok(upd && upd.action === "update", "title updated, not created");
  assert.ok(upd.style.fill.r > 0.9 && upd.style.fill.g < 0.1, "title fill is red");
});

// True-diff: an unedited page must reflow to ZERO operations, and a single
// colour edit must reflow to exactly one op carrying only the changed fill.
test("true-diff: unchanged nodes emit no ops; one colour edit emits one op", () => {
  const manifest = { rootIds: ["A"], nodes: {
    A: { id: "A", type: "FRAME", layout: { position: "absolute", left: 0, top: 0, width: 200, height: 120 },
         style: { fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 } }], radii: { corners: [12, 12, 12, 12] } } },
    // solid-red heading in an auto-layout row (position relative, radius none)
    T: { id: "T", type: "TEXT", text: "Hi", layout: { position: "relative", left: 0, top: 0, width: 80, height: 20 },
         style: { fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 } }] } },
    // a rounded button with a gradient fill
    B: { id: "B", type: "FRAME", layout: { position: "relative", left: 0, top: 0, width: 160, height: 44 },
         style: { fills: [{ type: "GRADIENT_LINEAR", gradientStops: [
           { position: 0, color: { r: 1, g: 0.4, b: 0.5, a: 1 } }, { position: 1, color: { r: 1, g: 0.1, b: 0.3, a: 1 } } ] }],
         radii: { corners: [22, 22, 22, 22] } } }
  } };
  // baseline capture: every node reports its exported values verbatim
  const base = { source: "x", created: [], nodes: {
    A: { local: { x: 0, y: 0 }, bounds: { x: 0, y: 0, width: 200, height: 120 }, style: { backgroundColor: "rgb(255,255,255)", borderRadius: "12px" } },
    T: { local: { x: 0, y: 0 }, bounds: { x: 0, y: 0, width: 80, height: 20 }, text: "Hi",
         style: { color: "rgb(255,0,0)", fontSize: "16px", fontWeight: "700", fontFamily: "Inter", textAlign: "left" } },
    B: { local: { x: 0, y: 0 }, bounds: { x: 0, y: 0, width: 160, height: 44 },
         style: { backgroundImage: "linear-gradient(180deg, rgb(255,102,128) 0%, rgb(255,26,77) 100%)", borderRadius: "22px" } }
  } };
  base.nodes.T.text = "Hi";
  const p0 = S.makePatch(manifest, base);
  assert.strictEqual(p0.operations.length, 0, "unchanged page → zero ops, got " + JSON.stringify(p0.operations));

  // now recolour only the heading to blue
  const edited = JSON.parse(JSON.stringify(base));
  edited.nodes.T.style.color = "rgb(0,0,255)";
  const p1 = S.makePatch(manifest, edited);
  assert.strictEqual(p1.operations.length, 1, "one edit → one op");
  const op = p1.operations[0];
  assert.strictEqual(op.id, "T");
  assert.ok(op.style.fill && op.style.fill.b > 0.9 && op.style.fill.r < 0.1, "carries the new blue fill");
});

// Baseline-backed font diff: a weight-only edit must survive on its own, and
// the emitted patch must carry the full font identity (family + weight +
// italic) so the plugin's Inter fallback can't clobber the family.
test("font baseline: weight-only edit emits a patch with full font identity", () => {
  const manifest = { rootIds: ["A"], nodes: {
    A: { id: "A", type: "FRAME", layout: { position: "absolute", left: 0, top: 0, width: 200, height: 120 }, style: { effects: [] } },
    T: { id: "T", type: "TEXT", text: "Hi", layout: { position: "relative", left: 0, top: 0, width: 80, height: 20 },
         style: {
           fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 } }],
           effects: [],
           textStyle: { fontSize: 16, fontWeight: 400, fontFamily: "PingFang SC", italic: false, lineHeightPx: 22, textAlign: "LEFT", textDecoration: "NONE" }
         } }
  } };
  const base = { source: "x", created: [], nodes: {
    A: { local: { x: 0, y: 0 }, bounds: { x: 0, y: 0, width: 200, height: 120 }, style: {} },
    T: { local: { x: 0, y: 0 }, bounds: { x: 0, y: 0, width: 80, height: 20 }, text: "Hi",
         style: { color: "rgb(0,0,0)", fontSize: "16px", fontWeight: "400", fontFamily: "'PingFang SC', sans-serif", lineHeight: "22px", textAlign: "left" } }
  } };
  assert.strictEqual(S.makePatch(manifest, base).operations.length, 0, "unchanged text → zero ops");

  const edited = JSON.parse(JSON.stringify(base));
  edited.nodes.T.style.fontWeight = "600";
  const patch = S.makePatch(manifest, edited);
  assert.strictEqual(patch.operations.length, 1, "weight-only edit → one op");
  const op = patch.operations[0];
  assert.strictEqual(op.style.fontWeight, 600);
  assert.strictEqual(op.style.fontFamily, "PingFang SC", "family carried so plugin keeps the font");
  assert.strictEqual(op.style.fontStyle, "normal");
});

// A fixed-width text box swallows font-size edits in its geometry; the
// baseline comparison must let them through anyway.
test("font baseline: font-size edit on fixed-width text emits without a bounds change", () => {
  const manifest = { rootIds: ["A"], nodes: {
    A: { id: "A", type: "FRAME", layout: { position: "absolute", left: 0, top: 0, width: 200, height: 120 }, style: { effects: [] } },
    T: { id: "T", type: "TEXT", text: "Hi", layout: { position: "relative", left: 0, top: 0, width: 80, height: 20 },
         style: { effects: [], textStyle: { fontSize: 12, fontWeight: 400, fontFamily: "Inter", italic: false } } }
  } };
  const capture = { source: "x", created: [], nodes: {
    A: { local: { x: 0, y: 0 }, bounds: { x: 0, y: 0, width: 200, height: 120 }, style: {} },
    T: { local: { x: 0, y: 0 }, bounds: { x: 0, y: 0, width: 80, height: 20 }, text: "Hi",
         style: { fontSize: "14px", fontWeight: "400", fontFamily: "Inter" } }
  } };
  const patch = S.makePatch(manifest, capture);
  assert.strictEqual(patch.operations.length, 1);
  assert.strictEqual(patch.operations[0].style.fontSize, 14);
});

// Effects baseline: shadow-only edits emit on their own; unchanged shadows
// stay silent; capture-invisible layer blur survives emission.
test("effects baseline: shadow-only edit emits; unchanged shadow is silent; layer blur preserved", () => {
  const shadow = { type: "DROP_SHADOW", offset: { x: 0, y: 2 }, radius: 8, spread: 0, color: { r: 0, g: 0, b: 0, a: 0.25 }, visible: true };
  const manifest = { rootIds: ["A"], nodes: {
    A: { id: "A", type: "FRAME", layout: { position: "absolute", left: 0, top: 0, width: 200, height: 120 }, style: { effects: [] } },
    B: { id: "B", type: "FRAME", layout: { position: "relative", left: 0, top: 0, width: 100, height: 40 },
         style: { effects: [shadow, { type: "LAYER_BLUR", radius: 6, visible: true }] } }
  } };
  const unchanged = { source: "x", created: [], nodes: {
    A: { local: { x: 0, y: 0 }, bounds: { x: 0, y: 0, width: 200, height: 120 }, style: {} },
    B: { local: { x: 0, y: 0 }, bounds: { x: 0, y: 0, width: 100, height: 40 },
         style: { boxShadow: "rgba(0, 0, 0, 0.25) 0px 2px 8px 0px" } }
  } };
  assert.strictEqual(S.makePatch(manifest, unchanged).operations.length, 0, "matching shadow → zero ops");

  const edited = JSON.parse(JSON.stringify(unchanged));
  edited.nodes.B.style.boxShadow = "rgba(255, 0, 0, 0.5) 0px 4px 12px 0px";
  const patch = S.makePatch(manifest, edited);
  assert.strictEqual(patch.operations.length, 1, "shadow-only edit → one op");
  const fx = patch.operations[0].style.effects;
  assert.ok(Array.isArray(fx), "carries effects");
  const drop = fx.find((e) => e.type === "DROP_SHADOW");
  assert.ok(drop && drop.y === 4 && drop.blur === 12 && drop.color.r > 0.9, "new shadow values");
  const blur = fx.find((e) => e.type === "LAYER_BLUR");
  assert.ok(blur && blur.blur === 6, "capture-invisible layer blur re-attached");
});

// Backdrop blur is exported at radius/2 in CSS; the diff must compare and
// emit in Figma units so blur does not drift across round trips.
test("effects baseline: backdrop blur round-trips without drift", () => {
  const manifest = { rootIds: ["A"], nodes: {
    A: { id: "A", type: "FRAME", layout: { position: "absolute", left: 0, top: 0, width: 200, height: 120 },
         style: { effects: [{ type: "BACKGROUND_BLUR", radius: 20, visible: true }] } }
  } };
  const unchanged = { source: "x", created: [], nodes: {
    A: { local: { x: 0, y: 0 }, bounds: { x: 0, y: 0, width: 200, height: 120 },
         style: { backdropFilter: "blur(10px)" } }
  } };
  assert.strictEqual(S.makePatch(manifest, unchanged).operations.length, 0, "css blur(10px) matches figma radius 20");

  const edited = JSON.parse(JSON.stringify(unchanged));
  edited.nodes.A.style.backdropFilter = "blur(15px)";
  const patch = S.makePatch(manifest, edited);
  assert.strictEqual(patch.operations.length, 1);
  const blur = patch.operations[0].style.effects.find((e) => e.type === "BACKGROUND_BLUR");
  assert.strictEqual(blur.blur, 30, "emitted in Figma units (css 15px → radius 30)");
});

// Batch-2 baselines: blend mode, image scale mode, rotation, auto-layout.
test("blendMode baseline: only a real mix-blend-mode change emits; removal emits 'normal'", () => {
  const manifest = { rootIds: ["A"], nodes: {
    A: { id: "A", type: "FRAME", layout: { position: "absolute", left: 0, top: 0, width: 100, height: 100 }, style: { effects: [] } },
    M: { id: "M", type: "RECTANGLE", layout: { position: "relative", left: 0, top: 0, width: 50, height: 50 },
         style: { effects: [], blendMode: "multiply" } }
  } };
  const unchanged = { source: "x", created: [], nodes: {
    A: { local: { x: 0, y: 0 }, bounds: { x: 0, y: 0, width: 100, height: 100 }, style: {} },
    M: { local: { x: 0, y: 0 }, bounds: { x: 0, y: 0, width: 50, height: 50 }, style: { mixBlendMode: "multiply" } }
  } };
  assert.strictEqual(S.makePatch(manifest, unchanged).operations.length, 0, "matching blend mode → zero ops");

  const removed = JSON.parse(JSON.stringify(unchanged));
  removed.nodes.M.style.mixBlendMode = "normal";
  const p = S.makePatch(manifest, removed);
  assert.strictEqual(p.operations.length, 1);
  assert.strictEqual(p.operations[0].style.blendMode, "normal", "removal emits explicit normal");

  const changed = JSON.parse(JSON.stringify(unchanged));
  changed.nodes.A.style.mixBlendMode = "screen";
  const p2 = S.makePatch(manifest, changed);
  assert.strictEqual(p2.operations.length, 1);
  assert.strictEqual(p2.operations[0].style.blendMode, "screen");
});

test("scaleMode baseline: cover↔contain transitions emit; CROP baselines are protected", () => {
  const manifest = { rootIds: ["A"], nodes: {
    A: { id: "A", type: "FRAME", layout: { position: "absolute", left: 0, top: 0, width: 100, height: 100 }, style: { effects: [] } },
    I: { id: "I", type: "RECTANGLE", kind: "image", layout: { position: "relative", left: 0, top: 0, width: 60, height: 40 },
         style: { effects: [], fills: [{ type: "IMAGE", imageId: "img1", scaleMode: "FILL" }] } },
    C: { id: "C", type: "RECTANGLE", kind: "image", layout: { position: "relative", left: 0, top: 0, width: 60, height: 40 },
         style: { effects: [], fills: [{ type: "IMAGE", imageId: "img2", scaleMode: "CROP" }] } }
  } };
  const unchanged = { source: "x", created: [], nodes: {
    A: { local: { x: 0, y: 0 }, bounds: { x: 0, y: 0, width: 100, height: 100 }, style: {} },
    I: { local: { x: 0, y: 0 }, bounds: { x: 0, y: 0, width: 60, height: 40 }, style: { backgroundSize: "cover" } },
    C: { local: { x: 0, y: 0 }, bounds: { x: 0, y: 0, width: 60, height: 40 }, style: { backgroundSize: "137% 100%" } }
  } };
  assert.strictEqual(S.makePatch(manifest, unchanged).operations.length, 0, "cover matches FILL; crop sizes ignored");

  const edited = JSON.parse(JSON.stringify(unchanged));
  edited.nodes.I.style.backgroundSize = "contain";
  const p = S.makePatch(manifest, edited);
  assert.strictEqual(p.operations.length, 1);
  assert.strictEqual(p.operations[0].style.scaleMode, "FIT");

  // cover on a CROP baseline must NOT downgrade the crop
  const cropTouch = JSON.parse(JSON.stringify(unchanged));
  cropTouch.nodes.C.style.backgroundSize = "cover";
  assert.strictEqual(S.makePatch(manifest, cropTouch).operations.length, 0, "CROP baseline protected");
});

test("rotation baseline: unchanged rotation silent; rotation edit emits Figma-space degrees and skips bbox geometry", () => {
  // baseline: rotated -30° CSS (transform2x2 for cos30/sin30), Figma rotation = +30... css cw 30 → figma -30.
  const cos = Math.cos(Math.PI / 6), sin = Math.sin(Math.PI / 6);
  const manifest = { rootIds: ["A"], nodes: {
    A: { id: "A", type: "FRAME", layout: { position: "absolute", left: 0, top: 0, width: 200, height: 200 }, style: { effects: [] } },
    R: { id: "R", type: "RECTANGLE", layout: { position: "absolute", left: 20, top: 20, width: 80, height: 40, transform2x2: { a: cos, b: sin, c: -sin, d: cos } },
         style: { effects: [] } }
  } };
  const unchanged = { source: "x", created: [], nodes: {
    A: { local: { x: 0, y: 0 }, bounds: { x: 0, y: 0, width: 200, height: 200 }, style: {} },
    // captured matrix(a,b,...) with b=sin30 → css 30° cw; bbox differs from layout (rotated envelope)
    R: { local: { x: 12, y: 8 }, bounds: { x: 12, y: 8, width: 89.3, height: 74.6 },
         style: { transform: `matrix(${cos}, ${sin}, ${-sin}, ${cos}, 0, 0)` } }
  } };
  assert.strictEqual(S.makePatch(manifest, unchanged).operations.length, 0, "same rotation → zero ops (bbox envelope ignored)");

  const edited = JSON.parse(JSON.stringify(unchanged));
  const cos45 = Math.cos(Math.PI / 4), sin45 = Math.sin(Math.PI / 4);
  edited.nodes.R.style.transform = `matrix(${cos45}, ${sin45}, ${-sin45}, ${cos45}, 0, 0)`;
  const p = S.makePatch(manifest, edited);
  assert.strictEqual(p.operations.length, 1);
  assert.ok(Math.abs(p.operations[0].style.rotation - (-45)) < 0.1, "css 45° cw → figma -45°, got " + p.operations[0].style.rotation);
  assert.strictEqual(p.operations[0].style.width, undefined, "no bbox width on rotated node");
});

test("auto-layout baseline: gap/padding edit reflows onto existing frame; direction flips never emit", () => {
  const manifest = { rootIds: ["A"], nodes: {
    A: { id: "A", type: "FRAME", layout: { position: "absolute", left: 0, top: 0, width: 300, height: 100 },
         style: { effects: [], autoLayout: { mode: "HORIZONTAL", itemSpacing: 8, paddingTop: 12, paddingRight: 16, paddingBottom: 12, paddingLeft: 16, primaryAxisAlignItems: "MIN", counterAxisAlignItems: "CENTER" } } }
  } };
  const flexCss = {
    display: "flex", flexDirection: "row", justifyContent: "flex-start", alignItems: "center",
    gap: "8px", rowGap: "8px", columnGap: "8px",
    paddingTop: "12px", paddingRight: "16px", paddingBottom: "12px", paddingLeft: "16px"
  };
  const unchanged = { source: "x", created: [], nodes: {
    A: { local: { x: 0, y: 0 }, bounds: { x: 0, y: 0, width: 300, height: 100 }, style: flexCss }
  } };
  assert.strictEqual(S.makePatch(manifest, unchanged).operations.length, 0, "matching auto-layout → zero ops");

  const edited = JSON.parse(JSON.stringify(unchanged));
  edited.nodes.A.style.columnGap = "24px";
  edited.nodes.A.style.gap = "24px";
  const p = S.makePatch(manifest, edited);
  assert.strictEqual(p.operations.length, 1, "gap edit → one op");
  assert.strictEqual(p.operations[0].style.autoLayout.itemSpacing, 24);
  assert.strictEqual(p.operations[0].style.autoLayout.mode, "HORIZONTAL");

  // direction flip is a structural change → never emitted on update
  const flipped = JSON.parse(JSON.stringify(unchanged));
  flipped.nodes.A.style.flexDirection = "column";
  assert.strictEqual(S.makePatch(manifest, flipped).operations.length, 0, "direction flip suppressed");
});

// An INSIDE stroke renders as a zero-blur zero-offset inset box-shadow in the
// export; it must never be misread as an INNER_SHADOW effect (which made every
// stroked card emit a bogus effects op on each reflow).
test("effects baseline: stroke-emulating inset shadow is not an effect", () => {
  const manifest = { rootIds: ["A"], nodes: {
    A: { id: "A", type: "FRAME", layout: { position: "absolute", left: 0, top: 0, width: 390, height: 844 },
         style: { effects: [
           { type: "DROP_SHADOW", offset: { x: 0, y: 14 }, radius: 32, spread: -16, color: { r: 0.12, g: 0.12, b: 0.13, a: 0.1 }, visible: true },
           { type: "DROP_SHADOW", offset: { x: 0, y: 1 }, radius: 2, spread: 0, color: { r: 0.12, g: 0.12, b: 0.13, a: 0.03 }, visible: true }
         ] } }
  } };
  const capture = { source: "x", created: [], nodes: {
    A: { local: { x: 0, y: 0 }, bounds: { x: 0, y: 0, width: 390, height: 844 },
         style: { boxShadow: "rgba(31, 31, 34, 0.1) 0px 14px 32px -16px, rgba(31, 31, 34, 0.03) 0px 1px 2px 0px, rgb(236, 238, 240) 0px 0px 0px 0.555556px inset" } }
  } };
  const patch = S.makePatch(manifest, capture);
  assert.strictEqual(patch.operations.length, 0, "inset stroke emulation → no effects op, got " + JSON.stringify(patch.operations));
});
