// Unit tests for the local helper's pure CSS→Figma translation functions.
const { test } = require("node:test");
const assert = require("node:assert");
const S = require("../packages/local-helper/src/server.js");

test("cssColorToFigma: hex6 / hex3 / rgba / transparent", () => {
  assert.deepStrictEqual(S.cssColorToFigma("#ff0000"), { r: 1, g: 0, b: 0, a: 1 });
  const c3 = S.cssColorToFigma("#abc");
  assert.ok(Math.abs(c3.r - 0xaa / 255) < 1e-9 && Math.abs(c3.b - 0xcc / 255) < 1e-9);
  const rgba = S.cssColorToFigma("rgba(0, 0, 0, 0.5)");
  assert.strictEqual(rgba.a, 0.5);
  assert.deepStrictEqual(S.cssColorToFigma("transparent"), { r: 0, g: 0, b: 0, a: 0 });
  assert.strictEqual(S.cssColorToFigma("nonsense"), null);
});

test("parseLinearGradient: angle + stops", () => {
  const g = S.parseLinearGradient("linear-gradient(90deg, rgb(255,0,0) 0%, rgb(0,0,255) 100%)");
  assert.strictEqual(g.angle, 90);
  assert.strictEqual(g.stops.length, 2);
  assert.deepStrictEqual([g.stops[0].position, g.stops[1].position], [0, 1]);
  assert.strictEqual(g.stops[0].r, 1);
  assert.strictEqual(g.stops[1].b, 1);
  // keyword direction
  assert.strictEqual(S.parseLinearGradient("linear-gradient(to right, #000, #fff)").angle, 90);
});

test("parseGradient: linear / radial / conic", () => {
  const lin = S.parseGradient("linear-gradient(98deg, #FF6986 0%, #FE2C55 45%)");
  assert.strictEqual(lin.type, "GRADIENT_LINEAR");
  assert.strictEqual(lin.angle, 98);
  const rad = S.parseGradient("radial-gradient(135% 85% at 60% -5%, #FFEAA3 0%, #FFF6D8 50%, rgba(248,248,248,0) 100%)");
  assert.strictEqual(rad.type, "GRADIENT_RADIAL");
  assert.strictEqual(rad.stops.length, 3);
  const con = S.parseGradient("conic-gradient(from 90deg, #f00, #0f0, #00f)");
  assert.strictEqual(con.type, "GRADIENT_ANGULAR");
  assert.strictEqual(con.stops.length, 3);
});

test("filter drop-shadow (nested rgba) + backdrop blur → effects", () => {
  const fx = S.parseFilterEffects("drop-shadow(0 8px 14px rgba(0,0,0,.12))");
  assert.strictEqual(fx.length, 1);
  assert.strictEqual(fx[0].type, "DROP_SHADOW");
  assert.ok(Math.abs(fx[0].color.a - 0.12) < 1e-9, "nested rgba alpha not truncated");
  const bb = S.parseBackdropBlur("blur(20px)");
  assert.deepStrictEqual(bb, { type: "BACKGROUND_BLUR", blur: 20 });
  const st = S.cssToFigmaStyle({ backgroundImage: "radial-gradient(circle, #fff 0%, #000 100%)" }, false);
  assert.strictEqual(st.fills[0].type, "GRADIENT_RADIAL");
});

test("parseBoxShadow: drop + inset", () => {
  const drop = S.parseBoxShadow("rgba(0,0,0,0.3) 2px 4px 10px 1px");
  assert.strictEqual(drop.length, 1);
  assert.strictEqual(drop[0].type, "DROP_SHADOW");
  assert.deepStrictEqual([drop[0].x, drop[0].y, drop[0].blur, drop[0].spread], [2, 4, 10, 1]);
  assert.ok(Math.abs(drop[0].color.a - 0.3) < 1e-9);
  const inset = S.parseBoxShadow("inset 0 0 0 0.5px rgba(22,24,35,0.08)");
  assert.strictEqual(inset[0].type, "INNER_SHADOW");
  assert.strictEqual(S.parseBoxShadow("none"), null);
});

test("cssToAutoLayout: flex mapping, null for non-flex", () => {
  assert.strictEqual(S.cssToAutoLayout({ display: "block" }), null);
  const col = S.cssToAutoLayout({
    display: "flex", flexDirection: "column", rowGap: "12px",
    paddingTop: "16px", paddingRight: "16px", paddingBottom: "16px", paddingLeft: "16px",
    justifyContent: "flex-start", alignItems: "stretch"
  });
  assert.strictEqual(col.mode, "VERTICAL");
  assert.strictEqual(col.itemSpacing, 12);
  assert.strictEqual(col.paddingLeft, 16);
  assert.strictEqual(col.primaryAxisAlignItems, "MIN");
  assert.strictEqual(col.counterStretch, true);
  const row = S.cssToAutoLayout({
    display: "flex", flexDirection: "row", columnGap: "8px",
    justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", rowGap: "6px"
  });
  assert.strictEqual(row.mode, "HORIZONTAL");
  assert.strictEqual(row.itemSpacing, 8);
  assert.strictEqual(row.primaryAxisAlignItems, "SPACE_BETWEEN");
  assert.strictEqual(row.counterAxisAlignItems, "CENTER");
  assert.strictEqual(row.layoutWrap, "WRAP");
  assert.strictEqual(row.counterAxisSpacing, 6);
});

test("cssToFigmaStyle: text vs frame, autoLayout only on non-text; update strips autoLayout", () => {
  const txt = S.cssToFigmaStyle({ color: "rgb(20,40,60)", fontSize: "18px", fontWeight: "700", textAlign: "center" }, true);
  assert.ok(txt.fill && txt.fill.r > 0);
  assert.strictEqual(txt.fontSize, 18);
  assert.strictEqual(txt.fontWeight, 700);
  assert.strictEqual(txt.textAlign, "center");
  assert.strictEqual(txt.autoLayout, undefined);

  const frame = S.cssToFigmaStyle({ display: "flex", flexDirection: "row", columnGap: "10px", backgroundColor: "#ffffff" }, false);
  assert.ok(frame.autoLayout && frame.autoLayout.mode === "HORIZONTAL");

  // update path must not carry auto-layout (never restructure an existing node)
  const upd = S.stylePatchFromCapture(
    { type: "FRAME", layout: { left: 0, top: 0, width: 100, height: 50 } },
    { local: { x: 0, y: 0 }, bounds: { x: 0, y: 0, width: 100, height: 50 }, style: { display: "flex", flexDirection: "row", columnGap: "10px" } }
  );
  assert.strictEqual(upd.autoLayout, undefined);
});

test("perCornerRadii: null when uniform, array when mixed", () => {
  assert.strictEqual(S.perCornerRadii({ borderTopLeftRadius: "8px", borderTopRightRadius: "8px", borderBottomRightRadius: "8px", borderBottomLeftRadius: "8px" }), null);
  assert.deepStrictEqual(
    S.perCornerRadii({ borderTopLeftRadius: "8px", borderTopRightRadius: "4px", borderBottomRightRadius: "8px", borderBottomLeftRadius: "12px" }),
    [8, 4, 8, 12]
  );
});

test("buildPagePatch: nested tree + page directive + grid", () => {
  const capture = {
    source: "file://x",
    created: [
      { createId: "a", parentCreateId: "", name: "Card", kind: "frame", bounds: { x: 10, y: 10, width: 200, height: 100 }, style: { backgroundColor: "#fff" } },
      { createId: "b", parentCreateId: "a", name: "Title", kind: "text", text: "Hi", bounds: { x: 26, y: 26, width: 100, height: 20 }, style: { color: "#111" } },
      { createId: "c", parentCreateId: "", name: "Card2", kind: "frame", bounds: { x: 10, y: 150, width: 200, height: 60 }, style: { backgroundColor: "#eee" } }
    ]
  };
  const patch = S.buildPagePatch(capture, { pageName: "P", cols: 2, gap: 40 });
  assert.deepStrictEqual(patch.page, { create: true, name: "P" });
  assert.strictEqual(patch.screens, 2); // two roots
  const [card, card2] = patch.operations;
  assert.strictEqual(card.kind, "frame");
  assert.strictEqual(card.children.length, 1);
  assert.strictEqual(card.children[0].kind, "text");
  // child position relative to parent
  assert.deepStrictEqual([card.children[0].style.x, card.children[0].style.y], [16, 16]);
  // grid: col width = max width (200), second root at x = 200+40
  assert.strictEqual(card.style.x, 0);
  assert.strictEqual(card2.style.x, 240);
});

test("buildPagePatch: container with an absolute child drops auto-layout", () => {
  const capture = { source: "x", created: [
    { createId: "body", parentCreateId: "", name: "body", kind: "frame",
      bounds: { x: 0, y: 0, width: 390, height: 800 },
      style: { display: "flex", flexDirection: "column", rowGap: "0px" } },
    { createId: "flow", parentCreateId: "body", name: "nav", kind: "text", text: "T",
      bounds: { x: 0, y: 0, width: 390, height: 48 }, style: { color: "#000", position: "static" } },
    { createId: "overlay", parentCreateId: "body", name: "sheet", kind: "frame",
      bounds: { x: 0, y: 100, width: 390, height: 700 }, style: { position: "absolute", backgroundColor: "#fff" } }
  ] };
  const patch = S.buildPagePatch(capture, { pageName: "P" });
  const body = patch.operations[0];
  assert.strictEqual(body.style.autoLayout, undefined, "body drops auto-layout (has absolute child)");
  const overlay = body.children.find((c) => c.name === "sheet");
  assert.strictEqual(overlay.style.absolutePos, true);
  // children keep captured positions
  assert.strictEqual(overlay.style.y, 100);
});

test("image → imageId (cached) instead of inline base64", () => {
  const png1x1 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const capture = { source: "x", created: [
    { createId: "a", parentCreateId: "", name: "img", kind: "image", bounds: { x: 0, y: 0, width: 10, height: 10 }, imageSrc: png1x1, style: {} }
  ] };
  const patch = S.buildPagePatch(capture, { pageName: "P" });
  const op = patch.operations[0];
  assert.strictEqual(op.kind, "image");
  assert.ok(op.imageId && op.imageId.indexOf("img_") === 0, "has content-hash imageId");
  assert.strictEqual(op.imageBase64, undefined, "no inline base64 (patch stays small)");
});

test("makePatch: update via local coords, delete detection", () => {
  const manifest = {
    rootIds: ["A"],
    nodes: {
      A: { id: "A", type: "FRAME", layout: { left: 30, top: 40, width: 200, height: 200 } },
      B: { id: "B", type: "RECTANGLE", layout: { left: 20, top: 20, width: 100, height: 40 } },
      C: { id: "C", type: "RECTANGLE", layout: { left: 20, top: 80, width: 50, height: 50 } } // will be deleted
    }
  };
  const capture = {
    source: "file://x",
    created: [],
    nodes: {
      A: { local: { x: 30, y: 40 }, bounds: { x: 30, y: 40, width: 200, height: 200 }, style: {} },
      // B absolute bounds differ from local; only local matches manifest → NO move
      B: { local: { x: 20, y: 20 }, bounds: { x: 50, y: 60, width: 100, height: 40 }, style: { backgroundColor: "#eee" } }
      // C absent → delete
    }
  };
  const patch = S.makePatch(manifest, capture);
  const b = patch.operations.find((o) => o.id === "B");
  assert.ok(b, "B present");
  assert.strictEqual(b.style && b.style.x, undefined, "B not falsely moved (local coords)");
  const del = patch.operations.find((o) => o.action === "delete");
  assert.strictEqual(del.id, "C");
});

test("convertSegments: css colors → fills, fields preserved", () => {
  const segs = S.convertSegments([
    { start: 0, end: 2, fontSize: 16, fontWeight: 700, color: "rgb(0,0,0)" },
    { start: 2, end: 8, fontSize: 13, fontWeight: 400, italic: true, color: "rgba(100,100,100,0.5)" }
  ]);
  assert.strictEqual(segs.length, 2);
  assert.deepStrictEqual([segs[0].start, segs[0].end], [0, 2]);
  assert.strictEqual(segs[0].fontSize, 16);
  assert.strictEqual(segs[0].fontWeight, 700);
  assert.ok(segs[0].fill && segs[0].fill.r === 0);
  assert.strictEqual(segs[1].italic, true);
  assert.ok(Math.abs(segs[1].fill.a - 0.5) < 1e-9);
});

test("annotateCreateIds: injects stable ids, handles self-closing, idempotent", () => {
  const html = `<div data-figma-create="frame"><span data-figma-create="text">x</span><img data-figma-create="image" src="a.png" /></div>`;
  const r1 = S.annotateCreateIds(html);
  assert.strictEqual(r1.added, 3);
  assert.ok(/data-figma-create-id="ci_1"/.test(r1.html));
  // self-closing img: id goes BEFORE the "/>", not after the slash
  assert.ok(/data-figma-create="image" src="a.png" data-figma-create-id="ci_3" \/>/.test(r1.html));
  assert.ok(!/\/ data-figma-create-id/.test(r1.html));
  // idempotent
  const r2 = S.annotateCreateIds(r1.html);
  assert.strictEqual(r2.added, 0);
});

test("writebackManifest + injectFigmaIds", () => {
  const capture = {
    created: [
      { createId: "a", parentCreateId: "", name: "Card", kind: "frame", text: "", bounds: { x: 20, y: 20, width: 200, height: 80 }, style: {} },
      { createId: "b", parentCreateId: "a", name: "Title", kind: "text", text: "标题", bounds: { x: 36, y: 36, width: 100, height: 20 }, style: { color: "#111" } }
    ]
  };
  const map = { a: "111:1", b: "111:2" };
  const m = S.writebackManifest(capture, map);
  assert.deepStrictEqual(m.rootIds, ["111:1"]);
  assert.strictEqual(m.nodes["111:2"].type, "TEXT");
  assert.strictEqual(m.nodes["111:2"].text, "标题");
  // parent-relative layout: 36-20 = 16
  assert.deepStrictEqual([m.nodes["111:2"].layout.left, m.nodes["111:2"].layout.top], [16, 16]);

  const html = `<div data-figma-create-id="a"><span data-figma-create-id="b">标题</span></div>`;
  const out = S.injectFigmaIds(html, map);
  assert.strictEqual(out.injected, 2);
  assert.ok(out.html.includes('data-figma-create-id="a" data-figma-id="111:1"'));
  assert.ok(out.html.includes('data-figma-create-id="b" data-figma-id="111:2"'));
  // idempotent
  const again = S.injectFigmaIds(out.html, map);
  assert.ok(again.html.includes('data-figma-id="111:1"'));
  assert.ok(!again.html.includes('data-figma-id="111:1" data-figma-id="111:1"'));
});

test("export archive: saves timestamped copy, never overwrites, lists newest-first", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exp-arch-"));
  try {
    fs.writeFileSync(path.join(dir, "index.html"), "<h1>a</h1>");
    fs.mkdirSync(path.join(dir, "images"));
    fs.writeFileSync(path.join(dir, "images", "x.png"), "x");

    // frame name preferred over page name; CJK + unsafe chars slugified
    assert.strictEqual(S.exportDisplayName({ page: { name: "P" }, composition: { children: [{ name: "银行卡" }] } }), "银行卡");
    assert.strictEqual(S.slugifyName("a / b?"), "a-b");

    const a1 = S.archiveExport(dir, { composition: { children: [{ name: "银行卡" }] } });
    assert.ok(a1.ok && /__银行卡$/.test(a1.slug), "archived under frame name");
    assert.ok(fs.existsSync(path.join(a1.dir, "index.html")), "html copied");
    assert.ok(fs.existsSync(path.join(a1.dir, "images", "x.png")), "assets copied");

    const a2 = S.archiveExport(dir, { composition: { children: [{ name: "信用卡" }] } });
    assert.notStrictEqual(a1.slug, a2.slug, "second export does not overwrite the first");

    const list = S.listExportArchives(dir);
    assert.strictEqual(list.length, 2, "both copies retained");
    // never touches the live export
    assert.ok(fs.existsSync(path.join(dir, "index.html")), "current export intact");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("long screen: wrapper grows and root un-clips only when content extends below frame", () => {
  const composition = {
    absOrigin: { x: 100, y: 200 },
    bounds: { x: 0, y: 0, width: 375, height: 812 },
    children: [{
      id: "r1", width: 375, height: 812,
      absoluteTransform: [[1, 0, 100], [0, 1, 200]],
      children: [
        { id: "c1", width: 375, height: 34, absoluteTransform: [[1, 0, 100], [0, 1, 1456]] },
        { id: "hidden", visible: false, width: 999, height: 9999, absoluteTransform: [[1, 0, 100], [0, 1, 200]] }
      ]
    }]
  };
  assert.deepStrictEqual(S.compositionContentExtent(composition), { maxRight: 375, maxBottom: 1290 });

  const rules = S.longScreenCss({ composition }, 812, ['[data-figma-id="r1"]']);
  assert.ok(rules.some((r) => r.includes("height:1290px")), "wrapper grows to content height");
  assert.ok(rules.some((r) => r.includes("html,body{overflow:auto")), "page scroll unlocked");
  assert.ok(rules.some((r) => r.includes('[data-figma-id="r1"]') && r.includes("overflow:visible")), "root un-clipped");

  const short = {
    absOrigin: { x: 0, y: 0 },
    children: [{ id: "r", width: 375, height: 812, absoluteTransform: [[1, 0, 0], [0, 1, 0]] }]
  };
  assert.deepStrictEqual(S.longScreenCss({ composition: short }, 812, ['[data-figma-id="r"]']), [], "no rules for short screens");
});

test("pixel-diff: PNG encode/decode round-trips and compare scores mismatches", () => {
  const { decodePng, encodePng, comparePng } = require("../packages/local-helper/src/pixel-diff.js");
  const w = 10, h = 10;
  const solid = (r, g, b) => {
    const buf = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i++) { buf[i * 4] = r; buf[i * 4 + 1] = g; buf[i * 4 + 2] = b; buf[i * 4 + 3] = 255; }
    return buf;
  };
  const white = encodePng(w, h, solid(255, 255, 255));
  const decoded = decodePng(white);
  assert.strictEqual(decoded.width, 10);
  assert.strictEqual(decoded.data[0], 255);

  // identical images → 100% match
  const same = comparePng(white, white);
  assert.strictEqual(same.mismatched, 0);
  assert.strictEqual(same.matchPct, 100);

  // paint a 5x10 red half on one side → 50% mismatch
  const halfRed = solid(255, 255, 255);
  for (let y = 0; y < h; y++) for (let x = 0; x < 5; x++) {
    const o = (y * w + x) * 4; halfRed[o] = 255; halfRed[o + 1] = 0; halfRed[o + 2] = 0;
  }
  const diff = comparePng(white, encodePng(w, h, halfRed));
  assert.strictEqual(diff.mismatchPct, 50);
  assert.ok(diff.diffPng.length > 8, "diff png produced");

  // small anti-aliasing wiggle below threshold → still a match
  const wiggle = solid(250, 252, 248);
  const soft = comparePng(white, encodePng(w, h, wiggle));
  assert.strictEqual(soft.mismatched, 0);

  // different sizes compare over the intersection and report sizeMatch=false
  const small = encodePng(6, 6, Buffer.alloc(6 * 6 * 4, 255));
  const cross = comparePng(white, small);
  assert.strictEqual(cross.width, 6);
  assert.strictEqual(cross.sizeMatch, false);
});

test("gradient rewrite: multi-layer backgrounds parse independently", () => {
  const layers = S.parseGradientLayers(
    "radial-gradient(circle, rgba(249,136,73,0.15) 0%, rgba(255,153,196,0) 100%), linear-gradient(0deg, rgb(255,255,255) 0%, rgb(255,255,255) 100%)",
    { width: 100, height: 100 }
  );
  assert.strictEqual(layers.length, 2, "both layers parsed");
  assert.strictEqual(layers[0].type, "GRADIENT_RADIAL");
  assert.strictEqual(layers[1].type, "GRADIENT_LINEAR");
  assert.ok(Math.abs(layers[0].stops[0].a - 0.15) < 1e-9, "first layer stops not corrupted by second");
  // url() layers are skipped, gradients still parse
  const mixed = S.parseGradientLayers("url('images/x.png'), linear-gradient(90deg, #000 0%, #fff 100%)");
  assert.strictEqual(mixed.length, 1);
  assert.strictEqual(mixed[0].type, "GRADIENT_LINEAR");
});

test("gradient rewrite: conic deg stops + from angle; radial center; corner angle uses box", () => {
  const con = S.parseGradient("conic-gradient(from 90deg at 25% 75%, #f00 0deg, #0f0 90deg, #00f 360deg)");
  assert.strictEqual(con.type, "GRADIENT_ANGULAR");
  assert.strictEqual(con.from, 90);
  assert.deepStrictEqual(con.center, { x: 0.25, y: 0.75 });
  assert.deepStrictEqual(con.stops.map((s) => s.position), [0, 0.25, 1], "deg stops → fractions of 360");

  const rad = S.parseGradient("radial-gradient(135% 85% at 60% -5%, #FFEAA3 0%, #FFF6D8 50%, rgba(248,248,248,0) 100%)");
  assert.deepStrictEqual(rad.center, { x: 0.6, y: -0.05 });
  assert.ok(Math.abs(rad.radius.x - 1.35) < 1e-9 && Math.abs(rad.radius.y - 0.85) < 1e-9, "explicit % radii");

  // corner keyword: 200x100 box → atan2(200,100) ≈ 63.43°, not 45°
  const corner = S.parseGradient("linear-gradient(to top right, #000, #fff)", { width: 200, height: 100 });
  assert.ok(Math.abs(corner.angle - 63.43) < 0.1, "corner angle from aspect, got " + corner.angle);
  // without a box the legacy 45° fallback stays
  assert.strictEqual(S.parseGradient("linear-gradient(to top right, #000, #fff)").angle, 45);
});

test("gradient rewrite: implicit stops interpolate; px stops use gradient line length", () => {
  const g = S.parseGradient("linear-gradient(180deg, #000 0%, #111, #222, #fff 100%)");
  assert.deepStrictEqual(g.stops.map((s) => Math.round(s.position * 100)), [0, 33, 67, 100]);
  // 180deg on a 100px-tall box → line length 100px, so 25px = 0.25
  const px = S.parseGradient("linear-gradient(180deg, #000 25px, #fff 75px)", { width: 50, height: 100 });
  assert.deepStrictEqual(px.stops.map((s) => s.position), [0.25, 0.75]);
});

test("grid → auto-layout: multi-track grid maps to wrapping horizontal layout", () => {
  const al = S.cssToAutoLayout({
    display: "grid",
    gridTemplateColumns: "96px 96px 96px",
    columnGap: "12px",
    rowGap: "8px",
    paddingTop: "16px", paddingRight: "16px", paddingBottom: "16px", paddingLeft: "16px"
  });
  assert.ok(al, "grid recognized");
  assert.strictEqual(al.mode, "HORIZONTAL");
  assert.strictEqual(al.layoutWrap, "WRAP");
  assert.strictEqual(al.itemSpacing, 12);
  assert.strictEqual(al.counterAxisSpacing, 8);
  assert.strictEqual(al.paddingLeft, 16);
  // single-track "grid" is not a grid worth mapping
  assert.strictEqual(S.cssToAutoLayout({ display: "grid", gridTemplateColumns: "300px" }), null);
});

test("hug inference: build-page containers sized by their content become AUTO", () => {
  const capture = { source: "x", created: [
    // row: padding 12, gap 8, children 60+40 wide, 20 tall → hug both axes: w=12+60+8+40+12=132, h=12+20+12=44
    { createId: "row", parentCreateId: "", name: "Row", kind: "frame", text: "",
      bounds: { x: 0, y: 0, width: 132, height: 44 },
      style: { display: "flex", flexDirection: "row", columnGap: "8px", rowGap: "8px",
               paddingTop: "12px", paddingRight: "12px", paddingBottom: "12px", paddingLeft: "12px",
               justifyContent: "flex-start", alignItems: "center" } },
    { createId: "a", parentCreateId: "row", name: "A", kind: "rectangle", text: "", bounds: { x: 12, y: 12, width: 60, height: 20 }, style: {} },
    { createId: "b", parentCreateId: "row", name: "B", kind: "rectangle", text: "", bounds: { x: 80, y: 12, width: 40, height: 20 }, style: {} },
    // fixed: same children but container much wider → stays FIXED
    { createId: "fixed", parentCreateId: "", name: "Fixed", kind: "frame", text: "",
      bounds: { x: 0, y: 100, width: 300, height: 44 },
      style: { display: "flex", flexDirection: "row", columnGap: "8px",
               paddingTop: "12px", paddingRight: "12px", paddingBottom: "12px", paddingLeft: "12px",
               justifyContent: "space-between", alignItems: "center" } },
    { createId: "c", parentCreateId: "fixed", name: "C", kind: "rectangle", text: "", bounds: { x: 12, y: 112, width: 60, height: 20 }, style: {} },
    { createId: "d", parentCreateId: "fixed", name: "D", kind: "rectangle", text: "", bounds: { x: 228, y: 112, width: 60, height: 20 }, style: {} }
  ] };
  const patch = S.buildPagePatch(capture, { pageName: "Hug" });
  const row = patch.operations.find((o) => o.id === "row");
  assert.strictEqual(row.style.autoLayout.primaryAxisSizingMode, "AUTO", "content-sized main axis hugs");
  assert.strictEqual(row.style.autoLayout.counterAxisSizingMode, "AUTO", "content-sized cross axis hugs");
  const fixed = patch.operations.find((o) => o.id === "fixed");
  assert.notStrictEqual(fixed.style.autoLayout.primaryAxisSizingMode, "AUTO", "space-between container stays fixed on main axis");
});

// CSS background SVGs must become vector child layers, never raster fills.
test("svg background: data-URI svg → vector child layer placed by size/position", () => {
  const svgDataUri = "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='16'%20height='16'%3E%3Cpath%20d='M2%202L14%2014'/%3E%3C/svg%3E";
  const capture = { source: "x", created: [
    { createId: "btn", parentCreateId: "", name: "关闭按钮", kind: "frame", text: "",
      bounds: { x: 10, y: 10, width: 28, height: 28 },
      style: { backgroundColor: "rgba(22,24,35,0.05)", backgroundSize: "16px 16px", backgroundPosition: "50% 50%" },
      imageSrc: svgDataUri }
  ] };
  const patch = S.buildPagePatch(capture, { pageName: "SvgBg" });
  const btn = patch.operations.find((o) => o.id === "btn");
  assert.strictEqual(btn.kind, "frame", "container stays a frame with its own fill");
  assert.ok(Array.isArray(btn.children) && btn.children.length === 1, "icon child synthesized");
  const icon = btn.children[0];
  assert.strictEqual(icon.kind, "svg");
  assert.ok(icon.svgContent.includes("<svg"), "decoded svg text");
  assert.strictEqual(icon.style.width, 16);
  assert.strictEqual(icon.style.x, 6, "(28-16)*50% = 6, centered");
  assert.strictEqual(icon.style.y, 6);
});

test("svg background: base64 svg is never cached as a raster image", () => {
  const b64svg = "data:image/svg+xml;base64," + Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>").toString("base64");
  // previously this regex matched and cached svg bytes as a broken .png
  const capture = { source: "x", created: [
    { createId: "n1", parentCreateId: "", name: "N", kind: "frame", text: "",
      bounds: { x: 0, y: 0, width: 20, height: 20 },
      style: { backgroundSize: "auto" }, imageSrc: b64svg }
  ] };
  const patch = S.buildPagePatch(capture, { pageName: "B64" });
  const op = patch.operations.find((o) => o.id === "n1");
  assert.strictEqual(op.imageId, undefined, "no raster image cached");
  assert.ok(op.children && op.children[0].kind === "svg", "routed to vector child instead");
  assert.ok(op.children[0].svgContent.includes("<svg"), "base64 decoded to svg text");
});

// Screenshot-diff round: margin-auto centering, margin-left:auto tails,
// row-reverse rows, and single-line text hug.
test("build-page heuristics: centering / tail-grow / row-reverse / text hug", () => {
  const capture = { source: "x", created: [
    // sheet: column flex, grab bar centered via margin auto, full-width head
    { createId: "sheet", parentCreateId: "", name: "弹层", kind: "frame", text: "",
      bounds: { x: 0, y: 0, width: 390, height: 591 },
      style: { display: "flex", flexDirection: "column" } },
    { createId: "grab", parentCreateId: "sheet", name: "抓手", kind: "frame", text: "",
      bounds: { x: 177, y: 8, width: 36, height: 4 }, style: {} },
    { createId: "head", parentCreateId: "sheet", name: "标题栏", kind: "frame", text: "",
      bounds: { x: 0, y: 20, width: 390, height: 56 }, style: {} },

    // card: row flex, chevron pushed to the right edge by margin-left:auto
    { createId: "card", parentCreateId: "", name: "卡片", kind: "frame", text: "",
      bounds: { x: 0, y: 700, width: 340, height: 72 },
      style: { display: "flex", flexDirection: "row", columnGap: "12px", paddingRight: "14px" } },
    { createId: "emo", parentCreateId: "card", name: "图标", kind: "frame", text: "",
      bounds: { x: 14, y: 710, width: 52, height: 52 }, style: {} },
    { createId: "body", parentCreateId: "card", name: "文案", kind: "frame", text: "",
      bounds: { x: 78, y: 712, width: 180, height: 48 }, style: {} },
    { createId: "chev", parentCreateId: "card", name: "箭头", kind: "text", text: "›",
      bounds: { x: 320, y: 724, width: 6, height: 24 }, style: { fontSize: "20px", lineHeight: "24px" } },

    // reversed message row: DOM order av,bubble but rendered bubble-first at right
    { createId: "row", parentCreateId: "", name: "消息行", kind: "frame", text: "",
      bounds: { x: 0, y: 800, width: 390, height: 40 },
      style: { display: "flex", flexDirection: "row-reverse", justifyContent: "flex-start", alignItems: "center", columnGap: "8px" } },
    { createId: "av", parentCreateId: "row", name: "头像", kind: "frame", text: "",
      bounds: { x: 346, y: 804, width: 32, height: 32 }, style: {} },
    { createId: "bubble", parentCreateId: "row", name: "气泡", kind: "frame", text: "",
      bounds: { x: 200, y: 804, width: 138, height: 32 }, style: {} }
  ] };
  const patch = S.buildPagePatch(capture, { pageName: "H" });

  const sheet = patch.operations.find((o) => o.id === "sheet");
  assert.strictEqual(sheet.style.autoLayout.counterAxisAlignItems, "CENTER", "margin-auto grab → container centers cross axis");

  const card = patch.operations.find((o) => o.id === "card");
  const bodySpec = card.children.find((c) => c.id === "body");
  assert.strictEqual(bodySpec.style.layoutGrow, 1, "flush-right tail → preceding child grows");
  const chevSpec = card.children.find((c) => c.id === "chev");
  assert.strictEqual(chevSpec.style.textAutoResize, "WIDTH_AND_HEIGHT", "single-line text hugs");

  const row = patch.operations.find((o) => o.id === "row");
  assert.deepStrictEqual(row.children.map((c) => c.id), ["bubble", "av"], "row-reverse flips child order");
  assert.strictEqual(row.style.autoLayout.primaryAxisAlignItems, "MAX", "packing mirrored to the right");
  assert.strictEqual(row.style.autoLayout.reverse, undefined, "internal flag stripped");
});
