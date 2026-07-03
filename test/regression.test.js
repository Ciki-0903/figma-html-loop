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
