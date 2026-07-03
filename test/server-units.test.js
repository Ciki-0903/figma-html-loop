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
