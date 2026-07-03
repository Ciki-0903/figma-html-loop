const http = require("http");

const port = Number(process.env.FIGMA_HTML_LOOP_PORT || 7799);
const host = "127.0.0.1";

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? "" : JSON.stringify(body);
    const req = http.request({
      host,
      port,
      path,
      method,
      timeout: 5000,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload)
      }
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => {
        let data = text;
        try { data = JSON.parse(text); } catch (_) {}
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
        else reject(Object.assign(new Error(data && data.message ? data.message : `HTTP ${res.statusCode}`), { data, status: res.statusCode }));
      });
    });
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timed out."));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

function print(data) {
  console.log(JSON.stringify(data, null, 2));
}

module.exports = { request, print };
