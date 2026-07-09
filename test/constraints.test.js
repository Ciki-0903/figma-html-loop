// Figma constraints → responsive CSS positioning (bridge-engine export side).
// Geometry left/top/width/height must stay numeric and unchanged so the
// capture/diff loop is unaffected; only the CSS expression changes.
const { test } = require("node:test");
const assert = require("node:assert");
const { computeLayout } = require("../packages/bridge-engine/dist/utils/layout-calculator.js");

const parentAbs = [[1, 0, 0], [0, 1, 0]];
const layoutFor = (constraints, extra = {}) => computeLayout({
  id: "n1", type: "RECTANGLE", width: 100, height: 40,
  absoluteTransform: [[1, 0, 250], [0, 1, 700]],
  constraints, ...extra
}, parentAbs, { parentSize: { width: 375, height: 812 } }).layout;

test("constraints: MAX pins right/bottom and suppresses left/top", () => {
  const l = layoutFor({ horizontal: "MAX", vertical: "MAX" });
  assert.strictEqual(l.suppressLeft, true);
  assert.strictEqual(l.cssRight, "25px");   // 375 - 250 - 100
  assert.strictEqual(l.suppressTop, true);
  assert.strictEqual(l.cssBottom, "72px");  // 812 - 700 - 40
  assert.strictEqual(l.left, 250, "numeric geometry untouched");
});

test("constraints: CENTER anchors at 50% with a fixed margin offset", () => {
  const l = layoutFor({ horizontal: "CENTER", vertical: "MIN" });
  assert.strictEqual(l.cssLeft, "50%");
  assert.strictEqual(l.cssMarginLeft, "62.5px"); // 250 - 375/2
  assert.strictEqual(l.cssTop, undefined, "vertical MIN untouched");
});

test("constraints: STRETCH pins both edges with auto size; SCALE uses percentages", () => {
  const s = layoutFor({ horizontal: "STRETCH", vertical: "MIN" });
  assert.strictEqual(s.cssRight, "25px");
  assert.strictEqual(s.cssWidth, "auto");
  const p = layoutFor({ horizontal: "SCALE", vertical: "SCALE" });
  assert.strictEqual(p.cssLeft, "66.67%");
  assert.strictEqual(p.cssWidth, "26.67%");
});

test("constraints: rotated nodes and flex items keep plain positioning", () => {
  const cos = Math.cos(Math.PI / 6), sin = Math.sin(Math.PI / 6);
  const rotated = computeLayout({
    id: "r", type: "RECTANGLE", width: 100, height: 40,
    absoluteTransform: [[cos, -sin, 250], [sin, cos, 700]],
    constraints: { horizontal: "MAX", vertical: "MAX" }
  }, parentAbs, { parentSize: { width: 375, height: 812 } }).layout;
  assert.strictEqual(rotated.cssRight, undefined, "rotation → no constraint css");

  const flexItem = computeLayout({
    id: "f", type: "RECTANGLE", width: 100, height: 40,
    absoluteTransform: [[1, 0, 250], [0, 1, 700]],
    constraints: { horizontal: "MAX", vertical: "MIN" }
  }, parentAbs, { asFlexItem: true, parentSize: { width: 375, height: 812 } }).layout;
  assert.strictEqual(flexItem.cssRight, undefined, "flex items ignore constraints");
});
