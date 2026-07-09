// Zero-dependency PNG decode/encode + pixel comparison for the verify loop.
// Uses node:zlib for IDAT inflate/deflate; supports the formats the loop
// actually produces (Figma exportAsync and html-to-image both emit 8-bit
// RGB/RGBA, non-interlaced). Grayscale and indexed are handled for safety.
const zlib = require("zlib");

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function decodePng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("Not a PNG file.");
  }
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  let palette = null, trns = null;
  const idat = [];
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "PLTE") palette = Buffer.from(data);
    else if (type === "tRNS") trns = Buffer.from(data);
    else if (type === "IDAT") idat.push(Buffer.from(data));
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  if (!width || !height) throw new Error("PNG missing IHDR.");
  if (interlace !== 0) throw new Error("Interlaced PNG is not supported.");
  if (bitDepth !== 8) throw new Error(`Unsupported PNG bit depth ${bitDepth} (only 8).`);
  const channelsByType = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const channels = channelsByType[colorType];
  if (!channels) throw new Error(`Unsupported PNG color type ${colorType}.`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = Buffer.from(line);
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? cur[i - channels] : 0;
      const up = prev[i];
      const upLeft = i >= channels ? prev[i - channels] : 0;
      if (filter === 1) cur[i] = (cur[i] + left) & 0xff;
      else if (filter === 2) cur[i] = (cur[i] + up) & 0xff;
      else if (filter === 3) cur[i] = (cur[i] + ((left + up) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft);
        const pred = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
        cur[i] = (cur[i] + pred) & 0xff;
      }
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const s = x * channels;
      if (colorType === 6) { out[o] = cur[s]; out[o + 1] = cur[s + 1]; out[o + 2] = cur[s + 2]; out[o + 3] = cur[s + 3]; }
      else if (colorType === 2) { out[o] = cur[s]; out[o + 1] = cur[s + 1]; out[o + 2] = cur[s + 2]; out[o + 3] = 255; }
      else if (colorType === 4) { out[o] = out[o + 1] = out[o + 2] = cur[s]; out[o + 3] = cur[s + 1]; }
      else if (colorType === 0) { out[o] = out[o + 1] = out[o + 2] = cur[s]; out[o + 3] = 255; }
      else if (colorType === 3) {
        const idx = cur[s] * 3;
        out[o] = palette ? palette[idx] : 0;
        out[o + 1] = palette ? palette[idx + 1] : 0;
        out[o + 2] = palette ? palette[idx + 2] : 0;
        out[o + 3] = trns && cur[s] < trns.length ? trns[cur[s]] : 255;
      }
    }
    prev = cur;
  }
  return { width, height, data: out };
}

function crc32(buf) {
  let crc = ~0;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), 0);
  return Buffer.concat([head, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// Compare two PNGs over their overlapping (top-left aligned) region.
// Returns mismatch stats and a diff PNG (red = mismatch, dimmed = match).
// `threshold` is the per-channel tolerance in 0-255 units (anti-aliasing and
// color-profile wiggle); default 25 ≈ 10%.
function comparePng(bufferA, bufferB, options = {}) {
  const threshold = Number.isFinite(options.threshold) ? options.threshold : 25;
  const a = decodePng(bufferA);
  const b = decodePng(bufferB);
  const width = Math.min(a.width, b.width);
  const height = Math.min(a.height, b.height);
  if (!width || !height) throw new Error("Images do not overlap.");
  const diff = Buffer.alloc(width * height * 4);
  let mismatched = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ia = (y * a.width + x) * 4;
      const ib = (y * b.width + x) * 4;
      const io = (y * width + x) * 4;
      // Composite both onto white so alpha differences compare fairly.
      const alphaA = a.data[ia + 3] / 255, alphaB = b.data[ib + 3] / 255;
      let maxDelta = 0;
      for (let c = 0; c < 3; c++) {
        const va = a.data[ia + c] * alphaA + 255 * (1 - alphaA);
        const vb = b.data[ib + c] * alphaB + 255 * (1 - alphaB);
        maxDelta = Math.max(maxDelta, Math.abs(va - vb));
      }
      if (maxDelta > threshold) {
        mismatched += 1;
        diff[io] = 255; diff[io + 1] = 0; diff[io + 2] = 0; diff[io + 3] = 255;
      } else {
        const g = Math.round((a.data[ia] * alphaA + 255 * (1 - alphaA)) * 0.2 + 204);
        diff[io] = diff[io + 1] = diff[io + 2] = Math.min(255, g); diff[io + 3] = 255;
      }
    }
  }
  const totalPixels = width * height;
  return {
    width,
    height,
    sizeA: { width: a.width, height: a.height },
    sizeB: { width: b.width, height: b.height },
    sizeMatch: a.width === b.width && a.height === b.height,
    totalPixels,
    mismatched,
    mismatchPct: Math.round((mismatched / totalPixels) * 10000) / 100,
    matchPct: Math.round((1 - mismatched / totalPixels) * 10000) / 100,
    diffPng: encodePng(width, height, diff),
  };
}

module.exports = { decodePng, encodePng, comparePng };
