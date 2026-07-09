// In-process integration test for the verify render loop: request → plugin
// PNG → browser PNG → pixel compare. Drives the HTTP handler directly (no
// port binding) so it runs in sandboxed CI.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const S = require("../packages/local-helper/src/server.js");
const { encodePng } = require("../packages/local-helper/src/pixel-diff.js");

const handler = S.server.listeners("request")[0];

function call(method, url, body) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? "" : JSON.stringify(body);
    const req = Readable.from(payload ? [payload] : []);
    req.method = method;
    req.url = url;
    req.headers = { "content-type": "application/json" };
    req.setEncoding = () => {};
    const chunks = [];
    const res = {
      statusCode: 0,
      writeHead(status) { this.statusCode = status; },
      setHeader() {},
      end(data) {
        let parsed = data;
        try { parsed = JSON.parse(data); } catch (_) {}
        resolve({ status: this.statusCode, data: parsed, raw: data });
      },
      on() {},
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

test("verify loop: render request → figma/html posts → pixel compare", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-loop-"));
  try {
    fs.writeFileSync(path.join(dir, "loop-manifest.json"), JSON.stringify({ rootIds: ["9:1"], nodes: {} }));

    const jobRes = await call("POST", "/api/render/request", { out: dir });
    assert.strictEqual(jobRes.status, 200);
    assert.strictEqual(jobRes.data.nodeId, "9:1", "nodeId taken from manifest rootIds");
    const id = jobRes.data.id;

    const pluginPending = await call("GET", "/api/render/pending");
    assert.strictEqual(pluginPending.data.job.id, id);
    const htmlPending = await call("GET", "/api/render/html-pending");
    assert.strictEqual(htmlPending.data.job.selector, '[data-figma-id="9:1"]');

    // figma: solid white; html: white with a 2px red stripe → 10% mismatch
    const w = 20, h = 20;
    const solid = Buffer.alloc(w * h * 4, 255);
    const striped = Buffer.from(solid);
    for (let y = 0; y < h; y++) for (let x = 0; x < 2; x++) {
      const o = (y * w + x) * 4; striped[o + 1] = 0; striped[o + 2] = 0;
    }
    const figmaPost = await call("POST", "/api/render/figma", { id, base64: encodePng(w, h, solid).toString("base64") });
    assert.strictEqual(figmaPost.status, 200);
    const htmlPost = await call("POST", "/api/render/html", { id, dataUrl: "data:image/png;base64," + encodePng(w, h, striped).toString("base64") });
    assert.strictEqual(htmlPost.status, 200);

    const status = await call("GET", "/api/render/status");
    assert.ok(status.data.figmaDone && status.data.htmlDone);

    const cmp = await call("POST", "/api/verify/compare", {});
    assert.strictEqual(cmp.status, 200);
    assert.strictEqual(cmp.data.mismatchPct, 10);
    assert.strictEqual(cmp.data.matchPct, 90);
    assert.ok(fs.existsSync(cmp.data.diff), "diff.png written");

    // stale job id is rejected
    const stale = await call("POST", "/api/render/figma", { id: "render_nope", base64: "AAAA" });
    assert.strictEqual(stale.status, 409);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("verify loop: capture client script carries the html render poller", () => {
  // The injected page script must poll for html renders and load html-to-image.
  const src = fs.readFileSync(path.join(__dirname, "..", "packages", "local-helper", "src", "server.js"), "utf8");
  assert.ok(src.includes("/api/render/html-pending"), "page script polls html-pending");
  assert.ok(src.includes("/libs/html-to-image.min.js"), "html-to-image served and loaded");
});
