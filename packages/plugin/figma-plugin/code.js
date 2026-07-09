// Bump this on every plugin (code.js/ui.html) change so an import can be verified
// as up to date. The UI compares its own expected version against this.
const PLUGIN_VERSION = 'roundtrip-1.4';

figma.showUI(__html__, { width: 320, height: 300, themeColors: true });
figma.ui.postMessage({ type: 'plugin-version', version: PLUGIN_VERSION });

function sanitizeImageId(hash) {
  if (!hash || typeof hash !== 'string') return null;
  const cleaned = hash.replace(/[^a-zA-Z0-9_-]/g, '_');
  return cleaned || null;
}

// SVG hash utilities (single source of truth)
function fnv1a(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(36);
}

function sanitizeSvgId(raw) {
  return String(raw || '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

const IGNORED_TYPES = [
  'VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'POLYGON', 'LINE',
  'REGULAR_POLYGON', 'ELLIPSE', 'ARROW', 'TRIANGLE'
];
const VECTOR_TYPES = [
  'VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'POLYGON', 'LINE',
  'REGULAR_POLYGON', 'ELLIPSE', 'ARROW', 'TRIANGLE'
];

function isVectorType(node) {
  return VECTOR_TYPES.includes(node.type);
}

function isPureVectorContainer(node) {
  if (!node || !('children' in node) || !Array.isArray(node.children) || node.children.length === 0) return false;
  for (const child of node.children) {
    if (!child || child.visible === false) continue;
    if ('children' in child && Array.isArray(child.children) && child.children.length > 0) {
      if (!isPureVectorContainer(child)) return false;
      continue;
    }
    if (!isVectorType(child)) return false;
  }
  return true;
}

function sortByDocumentOrder(nodes) {
  if (!nodes.length) return nodes;
  
  const parent = nodes[0].parent;
  if (!parent || !nodes.every(n => n.parent === parent)) {
    return nodes;
  }
  
  const indexMap = new Map();
  parent.children.forEach((child, i) => {
    indexMap.set(child.id, i);
  });
  
  return nodes.slice().sort((a, b) => {
    const idxA = indexMap.has(a.id) ? indexMap.get(a.id) : Infinity;
    const idxB = indexMap.has(b.id) ? indexMap.get(b.id) : Infinity;
    return idxA - idxB;
  });
}

function expandGroupsWithAncestors(nodes) {
  // Preserve selection as-is; no flattening.
  return nodes
    .filter(n => !!n && n.visible !== false)
    .map(n => ({ node: n, ancestors: [] }));
}

function computeBoundsFromRenderables(renderables) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  function transformPoint(M, x, y) {
    const a = M[0][0], b = M[0][1], tx = M[0][2];
    const c = M[1][0], d = M[1][1], ty = M[1][2];
    return { x: a * x + b * y + tx, y: c * x + d * y + ty };
  }

  for (const entry of renderables) {
    const node = entry && entry.node;
    const M = node && node.absoluteTransform;
    const w = node && node.width;
    const h = node && node.height;

    const validMatrix = Array.isArray(M) && M.length >= 2 && Array.isArray(M[0]) && Array.isArray(M[1]) && M[0].length >= 3 && M[1].length >= 3;
    if (!validMatrix || typeof w !== 'number' || typeof h !== 'number') continue;

    const p00 = transformPoint(M, 0, 0);
    const p10 = transformPoint(M, w, 0);
    const p01 = transformPoint(M, 0, h);
    const p11 = transformPoint(M, w, h);

    const xs = [p00.x, p10.x, p01.x, p11.x];
    const ys = [p00.y, p10.y, p01.y, p11.y];

    const lminX = Math.min(xs[0], xs[1], xs[2], xs[3]);
    const lminY = Math.min(ys[0], ys[1], ys[2], ys[3]);
    const lmaxX = Math.max(xs[0], xs[1], xs[2], xs[3]);
    const lmaxY = Math.max(ys[0], ys[1], ys[2], ys[3]);

    minX = Math.min(minX, lminX);
    minY = Math.min(minY, lminY);
    maxX = Math.max(maxX, lmaxX);
    maxY = Math.max(maxY, lmaxY);
  }

  if (!isFinite(minX) || !isFinite(minY) || !isFinite(maxX) || !isFinite(maxY)) {
    return { x: 0, y: 0, width: 0, height: 0, offsetX: 0, offsetY: 0 };
  }

  const width = Math.max(0, maxX - minX);
  const height = Math.max(0, maxY - minY);
  return { x: 0, y: 0, width, height, offsetX: minX, offsetY: minY };
}

function pickAutoLayoutContainerProps(n) {
  if (!n || typeof n.layoutMode !== 'string' || n.layoutMode === 'NONE') return null;
  const out = {
    layoutMode: n.layoutMode,
    itemSpacing: n.itemSpacing,
    paddingTop: n.paddingTop,
    paddingRight: n.paddingRight,
    paddingBottom: n.paddingBottom,
    paddingLeft: n.paddingLeft,
    primaryAxisAlignItems: n.primaryAxisAlignItems,
    counterAxisAlignItems: n.counterAxisAlignItems,
    primaryAxisSizingMode: n.primaryAxisSizingMode,
    counterAxisSizingMode: n.counterAxisSizingMode,
    layoutWrap: n.layoutWrap,
    counterAxisAlignContent: n.counterAxisAlignContent,
    counterAxisSpacing: (typeof n.counterAxisSpacing === 'number' ? n.counterAxisSpacing : null),
    strokesIncludedInLayout: n.strokesIncludedInLayout,
    itemReverseZIndex: n.itemReverseZIndex
  };
  return out;
}

function pickAutoLayoutChildProps(n, parentIsAutoLayout) {
  if (!parentIsAutoLayout || !n) return null;
  return {
    layoutAlign: n.layoutAlign,
    layoutGrow: typeof n.layoutGrow === 'number' ? n.layoutGrow : undefined,
    layoutPositioning: n.layoutPositioning
  };
}

function extractFills(n) {
  const fills = Array.isArray(n && n.fills) ? n.fills : null;
  if (!fills || fills.length === 0) return undefined;
  const out = [];
  
  for (const p of fills) {
    if (!p || p.visible === false) continue;
    const paintOpacity = typeof p.opacity === 'number' ? p.opacity : 1;
    
    if (p.type === 'SOLID' && p.color) {
      out.push({ 
        type: 'SOLID', 
        color: { r: p.color.r, g: p.color.g, b: p.color.b, a: paintOpacity },
        blendMode: typeof p.blendMode === 'string' ? p.blendMode : undefined
      });
    } 
    else if (p.type === 'IMAGE' && typeof p.imageHash === 'string') {
      const safeId = sanitizeImageId(p.imageHash);
      if (safeId) {
        const img = {
          type: 'IMAGE',
          imageId: safeId,
          imageHash: p.imageHash,
          scaleMode: p.scaleMode,
          opacity: paintOpacity,
          blendMode: typeof p.blendMode === 'string' ? p.blendMode : undefined
        };
        // Preserve crop/tiling/stretched transforms when available (best-effort)
        try {
          if (p && p.imageTransform && Array.isArray(p.imageTransform) && p.imageTransform.length >= 2) {
            const m0 = p.imageTransform[0];
            const m1 = p.imageTransform[1];
            if (Array.isArray(m0) && Array.isArray(m1) && m0.length >= 3 && m1.length >= 3) {
              img.imageTransform = [
                [Number(m0[0]) || 0, Number(m0[1]) || 0, Number(m0[2]) || 0],
                [Number(m1[0]) || 0, Number(m1[1]) || 0, Number(m1[2]) || 0]
              ];
            }
          }
          if (p && typeof p.scalingFactor === 'number') {
            img.scalingFactor = p.scalingFactor;
          }
        } catch (_) {}
        out.push(img);
      }
    }
    else if (p.type === 'GRADIENT_LINEAR' || p.type === 'GRADIENT_RADIAL' || p.type === 'GRADIENT_ANGULAR' || p.type === 'GRADIENT_DIAMOND') {
      const stops = Array.isArray(p.gradientStops) ? p.gradientStops : [];
      if (stops.length < 2) continue;
      
      const gradientStops = stops.map(stop => ({
        position: stop.position,
        color: { r: stop.color.r, g: stop.color.g, b: stop.color.b, a: stop.color.a }
      }));
      
      const handles = Array.isArray(p.gradientHandlePositions) && p.gradientHandlePositions.length === 3
        ? [
            { x: p.gradientHandlePositions[0].x, y: p.gradientHandlePositions[0].y },
            { x: p.gradientHandlePositions[1].x, y: p.gradientHandlePositions[1].y },
            { x: p.gradientHandlePositions[2].x, y: p.gradientHandlePositions[2].y }
          ]
        : null;
      const transform = (p && p.gradientTransform && Array.isArray(p.gradientTransform)) ? p.gradientTransform : null;
      
      out.push({ 
        type: p.type, 
        gradientStops, 
        gradientHandlePositions: handles,
        gradientTransform: transform,
        opacity: paintOpacity,
        blendMode: typeof p.blendMode === 'string' ? p.blendMode : undefined
      });
    }
  }
  
  return out.length ? { fills: out } : undefined;
}

function extractRadii(n) {
  const tl = Number(n && n.topLeftRadius);
  const tr = Number(n && n.topRightRadius);
  const br = Number(n && n.bottomRightRadius);
  const bl = Number(n && n.bottomLeftRadius);
  const hasCorners = [tl, tr, br, bl].every(v => Number.isFinite(v)) && (tl || tr || br || bl);
  if (hasCorners) return { radii: { corners: [tl || 0, tr || 0, br || 0, bl || 0] } };
  const uniform = typeof (n && n.cornerRadius) === 'number' ? n.cornerRadius : 0;
  return uniform > 0 ? { radii: { uniform } } : undefined;
}

function extractStrokes(n) {
  const strokes = Array.isArray(n && n.strokes) ? n.strokes : null;
  if (!strokes || strokes.length === 0) return undefined;
  const strokesOut = [];
  for (const s of strokes) {
    if (!s || s.visible === false) continue;
    if (s.type === 'SOLID' && s.color) {
      const a = (typeof s.opacity === 'number' ? s.opacity : 1);
      strokesOut.push({ type: 'SOLID', color: { r: s.color.r, g: s.color.g, b: s.color.b, a }, visible: true });
      continue;
    }
    if (s.type === 'GRADIENT_LINEAR') {
      const stops = Array.isArray(s.gradientStops) ? s.gradientStops : [];
      if (stops.length < 2) continue;
      const gradientStops = stops.map(stop => ({
        position: stop.position,
        color: { r: stop.color.r, g: stop.color.g, b: stop.color.b, a: stop.color.a }
      }));
      const handles = Array.isArray(s.gradientHandlePositions) && s.gradientHandlePositions.length === 3
        ? [
            { x: s.gradientHandlePositions[0].x, y: s.gradientHandlePositions[0].y },
            { x: s.gradientHandlePositions[1].x, y: s.gradientHandlePositions[1].y },
            { x: s.gradientHandlePositions[2].x, y: s.gradientHandlePositions[2].y }
          ]
        : null;
      const transform = (s && s.gradientTransform && Array.isArray(s.gradientTransform)) ? s.gradientTransform : null;
      const paintOpacity = typeof s.opacity === 'number' ? s.opacity : 1;
      strokesOut.push({ type: 'GRADIENT_LINEAR', gradientStops, gradientHandlePositions: handles, gradientTransform: transform, opacity: paintOpacity, visible: true });
      continue;
    }
  }
  return strokesOut.length ? { strokes: strokesOut } : undefined;
}

function extractStrokeWeights(n) {
  if (!n) return undefined;

  const hasVisibleStroke = Array.isArray(n.strokes)
    && n.strokes.some(s => s && s.visible !== false && (s.type === 'SOLID' || s.type === 'GRADIENT_LINEAR'));
  if (!hasVisibleStroke) return undefined;

  const base = { top: 0, right: 0, bottom: 0, left: 0 };
  if (typeof n.strokeWeight === 'number') {
    base.top = base.right = base.bottom = base.left = n.strokeWeight;
  }
  const sw = n && n.individualStrokeWeights;
  if (sw && typeof sw === 'object') {
    if (typeof sw.top === 'number') base.top = sw.top;
    if (typeof sw.right === 'number') base.right = sw.right;
    if (typeof sw.bottom === 'number') base.bottom = sw.bottom;
    if (typeof sw.left === 'number') base.left = sw.left;
  }
  if (typeof n.strokeTopWeight === 'number') base.top = n.strokeTopWeight;
  if (typeof n.strokeRightWeight === 'number') base.right = n.strokeRightWeight;
  if (typeof n.strokeBottomWeight === 'number') base.bottom = n.strokeBottomWeight;
  if (typeof n.strokeLeftWeight === 'number') base.left = n.strokeLeftWeight;

  const t = base.top, r = base.right, b = base.bottom, l = base.left;
  const allZero = !(t || r || b || l);
  const align = n && n.strokeAlign ? n.strokeAlign : null;
  const out = {};
  if (!allZero) out.strokeWeights = { t, r, b, l };
  if (align) out.strokeAlign = align;
  return Object.keys(out).length ? out : undefined;
}

function extractEffects(n) {
  const effects = Array.isArray(n && n.effects) ? n.effects : null;
  if (!effects || effects.length === 0) return undefined;

  const out = [];
  for (const e of effects) {
    if (!e || e.visible === false || !e.type) continue;
    if (e.type === 'BACKGROUND_BLUR' || e.type === 'LAYER_BLUR') {
      const radius = typeof e.radius === 'number' ? e.radius : 0;
      out.push({ type: e.type, radius, visible: true });
      continue;
    }
    if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
      const offset = e.offset && typeof e.offset.x === 'number' && typeof e.offset.y === 'number'
        ? { x: e.offset.x, y: e.offset.y }
        : { x: 0, y: 0 };
      const radius = typeof e.radius === 'number' ? e.radius : 0;
      const spread = typeof e.spread === 'number' ? e.spread : 0;
      const color = e.color ? { r: e.color.r, g: e.color.g, b: e.color.b, a: (typeof e.color.a === 'number' ? e.color.a : 1) } : null;
      out.push({ type: e.type, offset, radius, spread, color, visible: true });
      continue;
    }
  }
  return out.length ? { effects: out } : undefined;
}

function extractNodeStyle(n) {
  const parts = [
    extractFills(n),
    extractRadii(n),
    extractStrokes(n),
    extractStrokeWeights(n),
    (function extractDash(n){
      try {
        const dp = (n && 'dashPattern' in n) ? n.dashPattern : undefined;
        if (Array.isArray(dp) && dp.length > 0 && dp.every(v => typeof v === 'number' && isFinite(v))) {
          return { dashPattern: dp.slice(0, 16) };
        }
      } catch (_) {}
      return undefined;
    })(n),
    extractEffects(n)
  ].filter(Boolean);
  const nodeOpacity = (n && typeof n.opacity === 'number') ? n.opacity : 1;
  if (nodeOpacity !== 1) parts.push({ opacity: nodeOpacity });
  if (n && n.blendMode && n.blendMode !== 'NORMAL' && n.blendMode !== 'PASS_THROUGH') {
    parts.push({ blendMode: String(n.blendMode).toLowerCase().replace(/_/g, '-') });
  }
  return parts.length ? Object.assign({}, ...parts) : undefined;
}


function collectTextSegments(n) {
  const fields = ['fontSize', 'fontName', 'fontWeight', 'fills', 'letterSpacing', 'lineHeight', 'textDecoration', 'textCase'];
  try {
    const raw = n.getStyledTextSegments(fields);
    return raw.map(seg => {
      const out = { start: seg.start, end: seg.end };
      if (typeof seg.fontSize === 'number') out.fontSize = seg.fontSize;
      if (seg.fontName && typeof seg.fontName.family === 'string') out.fontName = { family: seg.fontName.family, style: seg.fontName.style || 'Regular' };
      if (typeof seg.fontWeight === 'number') out.fontWeight = seg.fontWeight;
      if (Array.isArray(seg.fills) && seg.fills.length > 0) {
        const solid = seg.fills.find(f => f && f.visible !== false && f.type === 'SOLID' && f.color);
        if (solid && solid.color) {
          const a = (typeof solid.opacity === 'number' ? solid.opacity : 1);
          out.fills = [{ type: 'SOLID', color: { r: solid.color.r, g: solid.color.g, b: solid.color.b }, opacity: a }];
        }
      }
      if (seg.letterSpacing && typeof seg.letterSpacing.value === 'number') out.letterSpacing = { unit: seg.letterSpacing.unit || 'PERCENT', value: seg.letterSpacing.value };
      if (seg.lineHeight) {
        const lh = { unit: seg.lineHeight.unit || 'AUTO' };
        if (typeof seg.lineHeight.value === 'number') lh.value = seg.lineHeight.value;
        out.lineHeight = lh;
      }
      if (seg.textDecoration && seg.textDecoration !== 'NONE') out.textDecoration = seg.textDecoration;
      if (seg.textCase && seg.textCase !== 'ORIGINAL') out.textCase = seg.textCase;
      return out;
    });
  } catch (e) {
    return [];
  }
}

function collectTextData(n) {
  if (n.type !== 'TEXT') return null;
  const chars = typeof n.characters === 'string' ? n.characters : '';
  if (!chars) return null;
  const segments = collectTextSegments(n);
  return {
    characters: chars,
    textAutoResize: n.textAutoResize || 'NONE',
    textAlignHorizontal: n.textAlignHorizontal || 'LEFT',
    textAlignVertical: n.textAlignVertical || 'TOP',
    paragraphIndent: typeof n.paragraphIndent === 'number' ? n.paragraphIndent : 0,
    paragraphSpacing: typeof n.paragraphSpacing === 'number' ? n.paragraphSpacing : 0,
    segments
  };
}

function computeTopLevelRenderBounds(n, rootOffsetX, rootOffsetY) {
  const rb = n && n.absoluteRenderBounds;
  if (
    rb && typeof rb.x === 'number' && typeof rb.y === 'number' &&
    typeof rb.width === 'number' && typeof rb.height === 'number'
  ) {
    return { x: rb.x - rootOffsetX, y: rb.y - rootOffsetY, width: rb.width, height: rb.height };
  }

  const M = Array.isArray(n && n.absoluteTransform) ? n.absoluteTransform : null;
  const w = (n && typeof n.width === 'number') ? n.width : 0;
  const h = (n && typeof n.height === 'number') ? n.height : 0;
  if (M && w > 0 && h > 0) {
    const a = M[0][0], b = M[0][1], tx = M[0][2];
    const c = M[1][0], d = M[1][1], ty = M[1][2];
    const p = (x, y) => ({ x: a * x + b * y + tx, y: c * x + d * y + ty });
    const p00 = p(0, 0);
    const p10 = p(w, 0);
    const p01 = p(0, h);
    const p11 = p(w, h);
    const minX = Math.min(p00.x, p10.x, p01.x, p11.x);
    const minY = Math.min(p00.y, p10.y, p01.y, p11.y);
    const maxX = Math.max(p00.x, p10.x, p01.x, p11.x);
    const maxY = Math.max(p00.y, p10.y, p01.y, p11.y);
    return { x: minX - rootOffsetX, y: minY - rootOffsetY, width: Math.max(0, maxX - minX), height: Math.max(0, maxY - minY) };
  }

  const hasTx = Array.isArray(M) && Array.isArray(M[0]) && Array.isArray(M[1]) && typeof M[0][2] === 'number' && typeof M[1][2] === 'number';
  if (hasTx) {
    const absX = M[0][2];
    const absY = M[1][2];
    const x = absX - rootOffsetX;
    const y = absY - rootOffsetY;
    const width = typeof n.width === 'number' ? n.width : 0;
    const height = typeof n.height === 'number' ? n.height : 0;
    return { x, y, width, height };
  }

  return { x: 0, y: 0, width: 0, height: 0 };
}

async function collectNode(n, opts) {
  if (!n) return null;
  const {
    isTopLevel = false,
    parentIsAutoLayout = false,
    rootOffsetX = 0,
    rootOffsetY = 0,
    groupAncestors = []
  } = (opts || {});

  const visible = n.visible !== false;
  const style = extractNodeStyle(n);

  const entry = {
    id: n.id,
    type: n.type,
    name: typeof n.name === 'string' ? n.name : '',
    visible,
    width: n.width,
    height: n.height,
    absoluteTransform: Array.isArray(n.absoluteTransform) ? n.absoluteTransform : undefined,
    isTopLevel: !!isTopLevel,
  };
  // Subtree compatibility: include absoluteRenderBounds snapshot when present
  if (!isTopLevel && n.absoluteRenderBounds) {
    entry.absoluteRenderBounds = {
      x: n.absoluteRenderBounds.x,
      y: n.absoluteRenderBounds.y,
      width: n.absoluteRenderBounds.width,
      height: n.absoluteRenderBounds.height
    };
  }
  entry.clipsContent = n.clipsContent === true;
  // Component-instance semantics: main component name, variant set + props.
  // Read-only metadata for the export (data-figma-component / manifest).
  if (n.type === 'INSTANCE') {
    try {
      const main = typeof n.getMainComponentAsync === 'function'
        ? await n.getMainComponentAsync()
        : n.mainComponent;
      if (main) {
        const meta = { name: main.name || '' };
        if (main.parent && main.parent.type === 'COMPONENT_SET') {
          meta.setName = main.parent.name || '';
          const variant = {};
          String(main.name || '').split(',').forEach((pair) => {
            const eq = pair.indexOf('=');
            if (eq > 0) variant[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
          });
          if (Object.keys(variant).length) meta.variant = variant;
        }
        entry.componentMeta = meta;
      }
    } catch (_) {}
    try {
      if (n.componentProperties && typeof n.componentProperties === 'object') {
        const variant = {};
        for (const key of Object.keys(n.componentProperties)) {
          const prop = n.componentProperties[key];
          if (prop && prop.type === 'VARIANT') variant[key.split('#')[0]] = String(prop.value);
        }
        if (Object.keys(variant).length) {
          entry.componentMeta = entry.componentMeta || {};
          entry.componentMeta.variant = Object.assign({}, entry.componentMeta.variant || {}, variant);
        }
      }
    } catch (_) {}
  }
  if (n && n.parent && n.parent.type === 'FRAME' && n.constraints && typeof n.constraints === 'object') {
    const h = n.constraints.horizontal;
    const v = n.constraints.vertical;
    if (typeof h === 'string' && typeof v === 'string') {
      entry.constraints = { horizontal: h, vertical: v };
    }
  }
  if ('isMask' in n && n.isMask) {
    entry.isMask = true;
    if ('maskType' in n) entry.maskType = n.maskType;
  }
  if (style) entry.style = style;

  if (n.type === 'TEXT') {
    const textData = collectTextData(n);
    if (textData) entry.text = textData;
  }

  if (!entry.svgId && !entry._svgContent && VECTOR_TYPES.includes(n.type) && typeof n.exportAsync === 'function') {
    // Decide if this vector should export as SVG. For ELLIPSE with dashed + INSIDE/OUTSIDE
    // we skip SVG so downstream stroke pipeline can render true INSIDE/OUTSIDE.
    let allowSvg = true;
    try {
      const s = style || (entry && entry.style);
      const dash = s && Array.isArray(s.dashPattern) ? s.dashPattern : undefined;
      const align = s && typeof s.strokeAlign === 'string' ? s.strokeAlign : undefined;
      const alignUp = align ? align.toUpperCase() : undefined;
      if (n.type === 'ELLIPSE' && dash && dash.length > 0 && (alignUp === 'INSIDE' || alignUp === 'OUTSIDE')) {
        allowSvg = false;
        console.log(`[SVG] Skip export for ELLIPSE ${n.id}: dashed ${alignUp} stroke handled by CSS pipeline.`);
      }
      // For other vector shapes with dashed and non-center align, we warn once: SVG will center strokes.
      if (allowSvg && n.type !== 'ELLIPSE') {
        if (dash && dash.length > 0 && alignUp && alignUp !== 'CENTER') {
          console.warn(`[SVG] ${n.type} ${n.id}: dashed stroke align=${alignUp} will render centered in SVG.`);
        }
      }
    } catch (_) {}

    if (allowSvg) {
      try {
        const svgString = await n.exportAsync({ format: 'SVG_STRING', svgOutlineText: true, svgSimplifyStroke: true });
        if (svgString && typeof svgString === 'string') {
          const svgId = sanitizeSvgId(fnv1a(svgString));
          entry.svgId = svgId;                  // 稳定 ID，用于服务端引用 /svgs/{svgId}
          entry._svgContent = svgString;        // 临时字段，仅供 UI 侧上传，渲染前会被清理
        } else {
          console.warn(`[SVG] Export returned non-string for ${n.type} node ${n.id}:`, typeof svgString);
        }
      } catch (e) {
        console.error(`[SVG] Export failed for ${n.type} node ${n.id}:`, e);
      }
    }
  }

  if (isTopLevel) {
    const absX = n.absoluteTransform[0][2];
    const absY = n.absoluteTransform[1][2];
    entry.x = absX - rootOffsetX;
    entry.y = absY - rootOffsetY;
    entry.renderBounds = computeTopLevelRenderBounds(n, rootOffsetX, rootOffsetY);

    if (Array.isArray(groupAncestors) && groupAncestors.length) {
      const path = groupAncestors.slice().reverse().map(g => (g.name && g.name.trim()) || g.id).join('/');
      entry.meta = {
        groupAncestors: groupAncestors.map(g => ({ id: g.id, name: g.name })),
        groupRootId: groupAncestors[0].id,
        groupPath: path
      };
    }
  } else {
    if ((entry.svgId || entry._svgContent) && n.absoluteRenderBounds && typeof rootOffsetX === 'number' && typeof rootOffsetY === 'number') {
      const rb = n.absoluteRenderBounds;
      entry.renderBounds = { x: rb.x - rootOffsetX, y: rb.y - rootOffsetY, width: rb.width, height: rb.height };
    }
  }

  const containerProps = pickAutoLayoutContainerProps(n);
  if (containerProps) Object.assign(entry, containerProps);
  const childProps = pickAutoLayoutChildProps(n, parentIsAutoLayout);
  if (childProps) Object.assign(entry, childProps);

  const kids = Array.isArray(n.children) ? n.children : [];
  const selfIsAutoLayout = !!(containerProps && containerProps.layoutMode && containerProps.layoutMode !== 'NONE');
  if (kids.length && !(entry.svgId || entry._svgContent)) {
    const childPromises = kids.map(k => collectNode(k, { isTopLevel: false, parentIsAutoLayout: selfIsAutoLayout, rootOffsetX, rootOffsetY }));
    const collected = (await Promise.all(childPromises)).filter(Boolean);
    if (collected.length) entry.children = collected;
  }

  return entry;
}

async function buildCompositionFromSelection() {
  const selection = figma.currentPage.selection || [];
  if (!selection.length) return null;

  const sorted = sortByDocumentOrder(selection);
  let renderables = expandGroupsWithAncestors(sorted);
  if (!renderables.length) return null;

  const boundsInfo = computeBoundsFromRenderables(renderables);

  let offsetX = boundsInfo.offsetX;
  let offsetY = boundsInfo.offsetY;
  let boundsWidth = boundsInfo.width;
  let boundsHeight = boundsInfo.height;

  const single = renderables.length === 1 ? renderables[0] : null;
  if (single && single.node && single.node.type === 'FRAME') {
    const M = single.node.absoluteTransform;
    const a = M && M[0] && typeof M[0][0] === 'number' ? M[0][0] : 1;
    const c = M && M[0] && typeof M[0][1] === 'number' ? M[0][1] : 0;
    const b = M && M[1] && typeof M[1][0] === 'number' ? M[1][0] : 0;
    const d = M && M[1] && typeof M[1][1] === 'number' ? M[1][1] : 1;
    const tx = M && M[0] && typeof M[0][2] === 'number' ? M[0][2] : 0;
    const ty = M && M[1] && typeof M[1][2] === 'number' ? M[1][2] : 0;
    const EPS = 1e-6;
    const isUnrotated = Math.abs(b) < EPS && Math.abs(c) < EPS && Math.abs(a - 1) < EPS && Math.abs(d - 1) < EPS;
    if (isUnrotated) {
      offsetX = tx;
      offsetY = ty;
      boundsWidth = typeof single.node.width === 'number' ? single.node.width : boundsInfo.width;
      boundsHeight = typeof single.node.height === 'number' ? single.node.height : boundsInfo.height;
    }
  }
  const children = await Promise.all(renderables.map(async (entry) => {
    const node = entry.node;
    const groupAncestors = Array.isArray(entry.ancestors) ? entry.ancestors : [];
    return collectNode(node, { isTopLevel: true, parentIsAutoLayout: false, rootOffsetX: offsetX, rootOffsetY: offsetY, groupAncestors });
  }));

  const root = {
    schemaVersion: '1.0',
    kind: 'composition',
    name: `Composition (${children.length} items)`,
    absOrigin: { x: offsetX, y: offsetY },
    bounds: { x: 0, y: 0, width: boundsWidth, height: boundsHeight },
    children
  };

  return root;
}

function collectImageIdsFromComposition(comp) {
  const ids = [];
  const seen = new Set();

  function takeFills(style) {
    if (!style || !Array.isArray(style.fills)) return;
    for (const f of style.fills) {
      if (f && f.type === 'IMAGE' && typeof f.imageId === 'string') {
        if (!seen.has(f.imageId)) {
          seen.add(f.imageId);
          ids.push(f.imageId);
        }
      }
    }
  }
  function walkNode(n) {
    if (!n || n.visible === false) return;
    if (n.style) takeFills(n.style);
    if (Array.isArray(n.children)) n.children.forEach(walkNode);
  }

  const children = (comp && Array.isArray(comp.children)) ? comp.children : [];
  for (const c of children) {
    walkNode(c);
  }
  return ids;
}

async function notifyComposition() {
  const composition = await buildCompositionFromSelection();
  const imageIds = composition ? collectImageIdsFromComposition(composition) : [];
  figma.ui.postMessage({ type: 'send-composition', composition, imageIds });
}

function selectionSummary() {
  const selection = figma.currentPage.selection || [];
  return selection.map((node) => ({
    id: node.id,
    name: node.name || '',
    type: node.type,
    width: typeof node.width === 'number' ? node.width : null,
    height: typeof node.height === 'number' ? node.height : null
  }));
}

function postSelectionPreview() {
  figma.ui.postMessage({ type: 'selection-preview', selection: selectionSummary() });
}

function solidPaintFromPatch(fill) {
  if (!fill || typeof fill.r !== 'number' || typeof fill.g !== 'number' || typeof fill.b !== 'number') return null;
  return {
    type: 'SOLID',
    color: { r: fill.r, g: fill.g, b: fill.b },
    opacity: typeof fill.a === 'number' ? fill.a : 1
  };
}

// Build a Figma gradientTransform (2x3) that runs the gradient along a CSS angle.
// CSS angle: 0deg = to top, 90deg = to right, clockwise, screen coords (y down).
function gradientTransformFromAngle(angleDeg) {
  const rad = (Number(angleDeg) || 0) * Math.PI / 180;
  const dx = Math.sin(rad);
  const dy = -Math.cos(rad);
  return [
    [dx, dy, 0.5 - 0.5 * dx - 0.5 * dy],
    [-dy, dx, 0.5 + 0.5 * dy - 0.5 * dx]
  ];
}

// Map node space → gradient space so the unit gradient circle lands at
// center (cx,cy) with radii (rx,ry), all as fractions of the node box.
function gradientTransformForRadial(center, radius) {
  const cx = center && typeof center.x === 'number' ? center.x : 0.5;
  const cy = center && typeof center.y === 'number' ? center.y : 0.5;
  const rx = radius && typeof radius.x === 'number' && radius.x > 0 ? radius.x : 0.5;
  const ry = radius && typeof radius.y === 'number' && radius.y > 0 ? radius.y : 0.5;
  return [
    [1 / (2 * rx), 0, 0.5 - cx / (2 * rx)],
    [0, 1 / (2 * ry), 0.5 - cy / (2 * ry)]
  ];
}

// Rotate the angular sweep to start at the CSS `from` angle around the given
// center. CSS conic 0deg starts at 12 o'clock; Figma's sweep starts at
// 3 o'clock, hence the -90° offset.
function gradientTransformForAngular(center, fromDeg) {
  const cx = center && typeof center.x === 'number' ? center.x : 0.5;
  const cy = center && typeof center.y === 'number' ? center.y : 0.5;
  const rad = ((Number(fromDeg) || 0) - 90) * Math.PI / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  // g = R(-rad) · (p - c) + (0.5, 0.5)
  return [
    [cos, sin, 0.5 - cos * cx - sin * cy],
    [-sin, cos, 0.5 + sin * cx - cos * cy]
  ];
}

function gradientPaintFromPatch(g) {
  const stops = Array.isArray(g && g.stops) ? g.stops : [];
  if (stops.length < 2) return null;
  const gradientStops = stops.map((s) => ({
    position: Math.max(0, Math.min(1, Number(s.position) || 0)),
    color: {
      r: Number(s.r) || 0,
      g: Number(s.g) || 0,
      b: Number(s.b) || 0,
      a: typeof s.a === 'number' ? s.a : 1
    }
  }));
  const type = (g.type === 'GRADIENT_RADIAL' || g.type === 'GRADIENT_ANGULAR') ? g.type : 'GRADIENT_LINEAR';
  let gradientTransform;
  if (type === 'GRADIENT_LINEAR') gradientTransform = gradientTransformFromAngle(g.angle);
  else if (type === 'GRADIENT_RADIAL') gradientTransform = gradientTransformForRadial(g.center, g.radius);
  else gradientTransform = gradientTransformForAngular(g.center, g.from);
  return { type, gradientTransform, gradientStops };
}

// Turn a patch style into an array of Figma paints (solid + linear gradient).
function paintsFromStyle(style) {
  if (!style) return null;
  if (Array.isArray(style.fills) && style.fills.length) {
    const out = [];
    for (const f of style.fills) {
      if (!f) continue;
      if (typeof f.type === 'string' && f.type.indexOf('GRADIENT') === 0) {
        const paint = gradientPaintFromPatch(f);
        if (paint) out.push(paint);
      } else {
        const paint = solidPaintFromPatch(f);
        if (paint) out.push(paint);
      }
    }
    if (out.length) return out;
  }
  if (style.fill) {
    const paint = solidPaintFromPatch(style.fill);
    if (paint) return [paint];
  }
  return null;
}

function effectsFromStyle(style) {
  const list = Array.isArray(style && style.effects) ? style.effects : null;
  if (!list) return null;
  const out = [];
  for (const e of list) {
    if (!e || !e.type) continue;
    const type = String(e.type).toUpperCase();
    if (type === 'DROP_SHADOW' || type === 'INNER_SHADOW') {
      out.push({
        type,
        color: e.color
          ? { r: Number(e.color.r) || 0, g: Number(e.color.g) || 0, b: Number(e.color.b) || 0, a: typeof e.color.a === 'number' ? e.color.a : 1 }
          : { r: 0, g: 0, b: 0, a: 0.25 },
        offset: { x: Number(e.x) || 0, y: Number(e.y) || 0 },
        radius: Math.max(0, Number(e.blur) || 0),
        spread: Number(e.spread) || 0,
        visible: true,
        blendMode: 'NORMAL'
      });
    } else if (type === 'LAYER_BLUR' || type === 'BACKGROUND_BLUR') {
      out.push({ type, radius: Math.max(0, Number(e.blur) || 0), visible: true });
    }
  }
  return out.length ? out : null;
}

function applyCornerRadius(node, style) {
  if (!node) return;
  const radii = Array.isArray(style.cornerRadii) ? style.cornerRadii : null;
  if (radii && radii.length === 4 && 'topLeftRadius' in node) {
    node.topLeftRadius = Math.max(0, Number(radii[0]) || 0);
    node.topRightRadius = Math.max(0, Number(radii[1]) || 0);
    node.bottomRightRadius = Math.max(0, Number(radii[2]) || 0);
    node.bottomLeftRadius = Math.max(0, Number(radii[3]) || 0);
    return;
  }
  if (typeof style.cornerRadius === 'number' && 'cornerRadius' in node) {
    node.cornerRadius = Math.max(0, style.cornerRadius);
  }
}

function applyStroke(node, style) {
  if (!node || !('strokes' in node)) return;
  if (style.strokeColor && typeof style.strokeColor.r === 'number') {
    const paint = solidPaintFromPatch(style.strokeColor);
    if (paint) node.strokes = [paint];
  }
  if (typeof style.strokeWeight === 'number' && style.strokeWeight >= 0 && 'strokeWeight' in node) {
    node.strokeWeight = style.strokeWeight;
  }
}

// Map a numeric CSS weight (+ italic flag) to the closest Figma font style name.
function weightToStyleNames(weight, italic) {
  const w = Number(weight) || 400;
  const table = [
    [100, 'Thin'], [200, 'Extra Light'], [300, 'Light'], [400, 'Regular'],
    [500, 'Medium'], [600, 'Semi Bold'], [700, 'Bold'], [800, 'Extra Bold'], [900, 'Black']
  ];
  let best = 'Regular';
  let bestDiff = Infinity;
  for (const [num, name] of table) {
    const diff = Math.abs(num - w);
    if (diff < bestDiff) { bestDiff = diff; best = name; }
  }
  const names = [];
  if (italic) {
    names.push(`${best} Italic`);
    if (best === 'Regular') names.push('Italic');
  }
  names.push(best);
  if (best !== 'Regular') names.push('Regular');
  return Array.from(new Set(names));
}

async function resolveFont(family, weight, italic) {
  const fam = family && String(family).trim() ? String(family).trim() : 'Inter';
  const candidates = weightToStyleNames(weight, italic);
  for (const fam2 of [fam, 'Inter']) {
    for (const style of candidates) {
      try {
        await figma.loadFontAsync({ family: fam2, style });
        return { family: fam2, style };
      } catch (_) {}
    }
  }
  const fallback = { family: 'Inter', style: 'Regular' };
  try { await figma.loadFontAsync(fallback); } catch (_) {}
  return fallback;
}

async function setTextSafely(node, text) {
  if (!node || node.type !== 'TEXT') return;
  try {
    const fontName = node.fontName && node.fontName !== figma.mixed
      ? node.fontName
      : { family: 'Inter', style: 'Regular' };
    await figma.loadFontAsync(fontName);
  } catch (_) {}
  node.characters = String(text);
}

async function loadTextFont(style) {
  return resolveFont(
    style && style.fontFamily,
    style && style.fontWeight,
    style && String(style.fontStyle || '').toLowerCase() === 'italic'
  );
}

// Rebuild a text node's per-run styling (font/size/weight/italic/color) from
// captured rich-text segments. Fonts are loaded before any setRange* call.
async function applyTextSegments(node, segments) {
  if (!node || node.type !== 'TEXT' || !Array.isArray(segments) || !segments.length) return;
  const len = node.characters.length;
  const resolved = [];
  for (const s of segments) resolved.push(await resolveFont(s.fontFamily, s.fontWeight, s.italic));
  try { node.fontName = resolved[0]; } catch (_) {}
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const start = Math.max(0, s.start | 0);
    const end = Math.min(len, s.end | 0);
    if (end <= start) continue;
    try { node.setRangeFontName(start, end, resolved[i]); } catch (_) {}
    if (typeof s.fontSize === 'number' && s.fontSize > 0) { try { node.setRangeFontSize(start, end, s.fontSize); } catch (_) {} }
    if (s.fill) { const p = solidPaintFromPatch(s.fill); if (p) { try { node.setRangeFills(start, end, [p]); } catch (_) {} } }
  }
}

// Apply text-only properties (font, size, alignment, spacing, decoration).
async function applyTextStyle(node, style) {
  if (!node || node.type !== 'TEXT' || !style) return;
  const wantsFont = style.fontFamily || style.fontWeight != null || style.fontStyle;
  if (wantsFont) {
    const fontName = await loadTextFont(style);
    try { node.fontName = fontName; } catch (_) {}
  }
  if (typeof style.fontSize === 'number' && style.fontSize > 0) {
    try { node.fontSize = style.fontSize; } catch (_) {}
  }
  if (typeof style.lineHeightPx === 'number' && style.lineHeightPx > 0) {
    try { node.lineHeight = { unit: 'PIXELS', value: style.lineHeightPx }; } catch (_) {}
  }
  if (typeof style.letterSpacing === 'number') {
    try { node.letterSpacing = { unit: 'PIXELS', value: style.letterSpacing }; } catch (_) {}
  }
  if (style.textAlign) {
    const map = { left: 'LEFT', center: 'CENTER', right: 'RIGHT', justify: 'JUSTIFIED' };
    const align = map[String(style.textAlign).toLowerCase()];
    if (align) { try { node.textAlignHorizontal = align; } catch (_) {} }
  }
  if (style.textDecoration) {
    const dec = String(style.textDecoration).toLowerCase();
    const val = dec.includes('underline') ? 'UNDERLINE' : dec.includes('line-through') ? 'STRIKETHROUGH' : 'NONE';
    try { node.textDecoration = val; } catch (_) {}
  }
}

const CSS_BLEND_TO_FIGMA = {
  'normal': 'NORMAL', 'multiply': 'MULTIPLY', 'screen': 'SCREEN', 'overlay': 'OVERLAY',
  'darken': 'DARKEN', 'lighten': 'LIGHTEN', 'color-dodge': 'COLOR_DODGE', 'color-burn': 'COLOR_BURN',
  'hard-light': 'HARD_LIGHT', 'soft-light': 'SOFT_LIGHT', 'difference': 'DIFFERENCE',
  'exclusion': 'EXCLUSION', 'hue': 'HUE', 'saturation': 'SATURATION', 'color': 'COLOR',
  'luminosity': 'LUMINOSITY'
};

// Rewrite the scale mode of existing image fills (patch carries FILL/FIT).
function applyImageScaleMode(node, style) {
  const mode = String(style && style.scaleMode || '').toUpperCase();
  if (!mode || ['FILL', 'FIT', 'CROP', 'TILE'].indexOf(mode) === -1) return;
  if (!node || !('fills' in node) || !Array.isArray(node.fills)) return;
  let touched = false;
  const fills = node.fills.map((p) => {
    if (p && p.type === 'IMAGE' && p.scaleMode !== mode) { touched = true; return { ...p, scaleMode: mode }; }
    return p;
  });
  if (touched) { try { node.fills = fills; } catch (_) {} }
}

// Apply visuals shared by TEXT and shape nodes. Async because fonts must load.
async function applyStyle(node, style) {
  if (!node || !style) return;
  const paints = paintsFromStyle(style);
  if (paints && 'fills' in node) {
    if (node.type === 'TEXT') {
      // Text color comes from a single solid fill; ignore gradients on text for safety.
      const solid = paints.find((p) => p.type === 'SOLID');
      if (solid) node.fills = [solid];
    } else {
      node.fills = paints;
    }
  }
  applyImageScaleMode(node, style);
  applyStroke(node, style);
  applyCornerRadius(node, style);
  const effects = effectsFromStyle(style);
  if (effects && 'effects' in node) node.effects = effects;
  if (typeof style.opacity === 'number' && 'opacity' in node) node.opacity = Math.max(0, Math.min(1, style.opacity));
  if (typeof style.visible === 'boolean' && 'visible' in node) node.visible = style.visible;
  if (typeof style.blendMode === 'string' && 'blendMode' in node) {
    const blend = CSS_BLEND_TO_FIGMA[style.blendMode.toLowerCase()];
    if (blend) { try { node.blendMode = blend; } catch (_) {} }
  }
  await applyTextStyle(node, style);
}

function resizeAndPlaceNode(node, style) {
  if (!node || !style) return;
  if ((typeof style.width === 'number' || typeof style.height === 'number') && typeof node.resize === 'function') {
    let width = typeof style.width === 'number' ? Math.max(1, style.width) : node.width;
    let height = typeof style.height === 'number' ? Math.max(1, style.height) : node.height;
    // Hug text sizes itself from content — never force the captured box back.
    if (node.type === 'TEXT' && node.textAutoResize === 'WIDTH_AND_HEIGHT') { width = node.width; height = node.height; }
    else if (node.type === 'TEXT' && node.textAutoResize === 'HEIGHT') height = node.height;
    // Never fight hug-content axes on auto-layout frames.
    if (node.layoutMode === 'HORIZONTAL' || node.layoutMode === 'VERTICAL') {
      const isRow = node.layoutMode === 'HORIZONTAL';
      const primaryAuto = node.primaryAxisSizingMode === 'AUTO';
      const counterAuto = node.counterAxisSizingMode === 'AUTO';
      if (isRow ? primaryAuto : counterAuto) width = node.width;
      if (isRow ? counterAuto : primaryAuto) height = node.height;
    }
    if (width !== node.width || height !== node.height) node.resize(width, height);
  }
  if (typeof style.x === 'number' && 'x' in node) node.x = style.x;
  if (typeof style.y === 'number' && 'y' in node) node.y = style.y;
  if (typeof style.rotation === 'number' && 'rotation' in node) {
    try { node.rotation = style.rotation; } catch (_) {}
  }
}

// When a patch creates a fresh page, root-level creates go here instead of the
// current selection, so importing a whole screen never touches existing layers.
let importTargetParent = null;

async function findPatchParent(parentId) {
  if (parentId) {
    try {
      const node = await figma.getNodeByIdAsync(String(parentId));
      if (node && 'appendChild' in node) return node;
    } catch (_) {}
  }
  if (importTargetParent && 'appendChild' in importTargetParent) return importTargetParent;
  const selection = figma.currentPage.selection || [];
  const first = selection[0];
  if (first && 'appendChild' in first) return first;
  return figma.currentPage;
}

// Turn a frame into a Figma auto-layout frame that mirrors the source CSS flexbox,
// so its children flow (and stay editable) instead of being absolutely pinned.
function applyAutoLayout(node, al, childPairs, style) {
  if (!node || !al || !('layoutMode' in node)) return;
  try {
    node.layoutMode = al.mode === 'VERTICAL' ? 'VERTICAL' : 'HORIZONTAL';
    if (al.layoutWrap === 'WRAP' && node.layoutMode === 'HORIZONTAL' && 'layoutWrap' in node) {
      node.layoutWrap = 'WRAP';
      if (typeof al.counterAxisSpacing === 'number') { try { node.counterAxisSpacing = al.counterAxisSpacing; } catch (_) {} }
    }
    if (typeof al.itemSpacing === 'number') node.itemSpacing = al.itemSpacing;
    if (typeof al.paddingTop === 'number') node.paddingTop = al.paddingTop;
    if (typeof al.paddingRight === 'number') node.paddingRight = al.paddingRight;
    if (typeof al.paddingBottom === 'number') node.paddingBottom = al.paddingBottom;
    if (typeof al.paddingLeft === 'number') node.paddingLeft = al.paddingLeft;
    if (al.primaryAxisAlignItems) { try { node.primaryAxisAlignItems = al.primaryAxisAlignItems; } catch (_) {} }
    if (al.counterAxisAlignItems) { try { node.counterAxisAlignItems = al.counterAxisAlignItems; } catch (_) {} }

    // Per-child sizing/positioning hints.
    for (const { node: child, style: cst } of childPairs) {
      if (!child) continue;
      if (cst && cst.absolutePos && 'layoutPositioning' in child) {
        try { child.layoutPositioning = 'ABSOLUTE'; } catch (_) {}
        continue;
      }
      if (al.counterStretch && 'layoutAlign' in child) { try { child.layoutAlign = 'STRETCH'; } catch (_) {} }
      if (cst && cst.layoutGrow && 'layoutGrow' in child) { try { child.layoutGrow = 1; } catch (_) {} }
    }

    // Sizing: AUTO (hug) when the helper inferred content-driven sizing,
    // FIXED otherwise. Only FIXED axes get resized — resizing a hug axis
    // would fight the layout engine's own recalculation.
    const primaryAuto = al.primaryAxisSizingMode === 'AUTO';
    const counterAuto = al.counterAxisSizingMode === 'AUTO';
    if ('primaryAxisSizingMode' in node) node.primaryAxisSizingMode = primaryAuto ? 'AUTO' : 'FIXED';
    if ('counterAxisSizingMode' in node) node.counterAxisSizingMode = counterAuto ? 'AUTO' : 'FIXED';
    const isRow = node.layoutMode === 'HORIZONTAL';
    const wAuto = isRow ? primaryAuto : counterAuto;
    const hAuto = isRow ? counterAuto : primaryAuto;
    const w = !wAuto && typeof style.width === 'number' ? Math.max(0.01, style.width) : node.width;
    const h = !hAuto && typeof style.height === 'number' ? Math.max(0.01, style.height) : node.height;
    if ((!wAuto || !hAuto) && typeof node.resize === 'function') node.resize(w, h);
  } catch (_) {}
}

// Update-path auto-layout: reflow gap / padding / alignment onto a frame that
// is ALREADY auto-layout with the same direction. Never restructures
// (NONE↔flex, direction flips) and never touches sizing modes or size —
// the diff only emits this when the direction matches the baseline.
function applyAutoLayoutUpdate(node, al) {
  if (!node || !al || !('layoutMode' in node)) return;
  if (node.layoutMode !== 'HORIZONTAL' && node.layoutMode !== 'VERTICAL') return;
  if (al.mode && node.layoutMode !== al.mode) return;
  try {
    if (typeof al.itemSpacing === 'number') node.itemSpacing = al.itemSpacing;
    if (typeof al.paddingTop === 'number') node.paddingTop = al.paddingTop;
    if (typeof al.paddingRight === 'number') node.paddingRight = al.paddingRight;
    if (typeof al.paddingBottom === 'number') node.paddingBottom = al.paddingBottom;
    if (typeof al.paddingLeft === 'number') node.paddingLeft = al.paddingLeft;
    if (al.primaryAxisAlignItems) { try { node.primaryAxisAlignItems = al.primaryAxisAlignItems; } catch (_) {} }
    if (al.counterAxisAlignItems) { try { node.counterAxisAlignItems = al.counterAxisAlignItems; } catch (_) {} }
    if (al.layoutWrap === 'WRAP' && node.layoutMode === 'HORIZONTAL' && 'layoutWrap' in node) {
      node.layoutWrap = 'WRAP';
      if (typeof al.counterAxisSpacing === 'number') { try { node.counterAxisSpacing = al.counterAxisSpacing; } catch (_) {} }
    }
  } catch (_) {}
}

// Build a single node from a spec, without attaching it to a parent.
// `collector` (optional) accumulates { createId, figmaId } for id write-back.
async function buildNodeFromSpec(spec, collector) {
  const style = spec.style || {};
  const kind = String(spec.kind || 'rectangle').toLowerCase();
  let node;
  let isImage = false;
  let isSvg = false;
  if (kind === 'text') {
    node = figma.createText();
    node.fontName = await loadTextFont(style);
    node.characters = String(spec.text || 'Text');
    // Single-line text hugs (helper marks it) so CJK font-fallback metric
    // differences never wrap it; multi-line keeps the captured fixed size.
    const autoResize = style.textAutoResize === 'WIDTH_AND_HEIGHT' || style.textAutoResize === 'HEIGHT'
      ? style.textAutoResize
      : 'NONE';
    try { node.textAutoResize = autoResize; } catch (_) {}
  } else if (kind === 'svg' && spec.svgContent) {
    try {
      node = figma.createNodeFromSvg(String(spec.svgContent));
      isSvg = true;
    } catch (_) {
      node = figma.createRectangle();
    }
  } else if (kind === 'frame') {
    node = figma.createFrame();
    node.clipsContent = false;
    // Clear Figma's default white fill — a transparent HTML wrapper must stay
    // transparent (applyStyle re-adds a fill only when the source had one).
    node.fills = [];
    // Default to absolute children; auto-layout is enabled below only when the
    // source element was a flex container.
    if ('layoutMode' in node) node.layoutMode = 'NONE';
  } else {
    node = figma.createRectangle();
    node.fills = []; // clear default fill; applyStyle sets one if the source had a background
  }

  node.name = spec.name || (kind === 'text' ? 'HTML text' : kind === 'image' ? 'HTML image' : 'HTML layer');

  if (kind === 'image' && spec.imageBase64 && 'fills' in node) {
    try {
      const bytes = figma.base64Decode(String(spec.imageBase64));
      const image = figma.createImage(bytes);
      const scaleMode = ['FILL', 'FIT', 'CROP', 'TILE'].indexOf(String(style.scaleMode || '').toUpperCase()) !== -1
        ? String(style.scaleMode).toUpperCase()
        : 'FILL';
      node.fills = [{ type: 'IMAGE', scaleMode, imageHash: image.hash }];
      isImage = true;
    } catch (_) {}
  }

  resizeAndPlaceNode(node, style);
  // For image / SVG nodes, keep their own paint instead of overwriting with background paints.
  await applyStyle(node, (isImage || isSvg) ? Object.assign({}, style, { fill: undefined, fills: undefined }) : style);

  // Rich-text: apply per-run styling after the base style.
  if (node.type === 'TEXT' && Array.isArray(spec.segments) && spec.segments.length) {
    await applyTextSegments(node, spec.segments);
    resizeAndPlaceNode(node, style); // keep captured size after segment font changes
  }

  // Recursively create nested children (e.g. a card that contains an icon + label).
  const children = Array.isArray(spec.children) ? spec.children : [];
  const childPairs = [];
  for (const childSpec of children) {
    try {
      const child = await buildNodeFromSpec(childSpec, collector);
      if ('appendChild' in node) node.appendChild(child);
      // Re-apply size after attaching (appendChild can reset it).
      resizeAndPlaceNode(child, childSpec.style || {});
      childPairs.push({ node: child, style: childSpec.style || {} });
    } catch (_) {}
  }

  // Enable auto-layout last, so children exist and the fixed frame size sticks.
  const al = kind === 'frame' && style.autoLayout ? style.autoLayout : null;
  if (al) applyAutoLayout(node, al, childPairs, style);

  // Record createId → figmaId so the helper can write ids back into the source HTML.
  if (collector && spec && spec.id != null) collector.push({ createId: String(spec.id), figmaId: node.id });

  return node;
}

async function createNodeFromPatch(op) {
  const mapping = [];
  const node = await buildNodeFromSpec(op, mapping);
  const parent = await findPatchParent(op.parentId);
  if (parent && parent !== node.parent && 'appendChild' in parent) parent.appendChild(node);
  // Re-apply size/position after attaching to the target parent.
  resizeAndPlaceNode(node, op.style || {});
  return { node, mapping };
}

async function applyPatch(patch) {
  const ops = Array.isArray(patch && patch.operations) ? patch.operations : [];
  const results = [];

  // Optional: create a brand-new page and build everything on it, leaving all
  // existing pages and layers untouched.
  importTargetParent = null;
  const createdMap = {};
  const createdNodes = []; // for transactional cleanup
  let newPage = null;
  const prevPage = figma.currentPage;
  if (patch && patch.page && patch.page.create) {
    try {
      newPage = figma.createPage();
      newPage.name = String(patch.page.name || 'HTML Import');
      if (typeof figma.setCurrentPageAsync === 'function') {
        await figma.setCurrentPageAsync(newPage);
      } else {
        figma.currentPage = newPage;
      }
      importTargetParent = newPage;
      results.push({ id: 'page', ok: true, action: 'create-page', figmaId: newPage.id, name: newPage.name });
    } catch (error) {
      results.push({ id: 'page', ok: false, action: 'create-page', message: String(error && error.message || error) });
    }
  }

  let fatal = null;
  try {
    for (const op of ops) {
      try {
        if (op.action === 'create') {
          const { node: created, mapping } = await createNodeFromPatch(op);
          createdNodes.push(created);
          for (const m of mapping) { if (m && m.createId) createdMap[m.createId] = m.figmaId; }
          results.push({ id: op.id, figmaId: created.id, ok: true, action: 'create' });
          continue;
        }
        if (op.action === 'delete') {
          const target = await figma.getNodeByIdAsync(String(op.id));
          if (target && typeof target.remove === 'function') {
            if (!target.removed) target.remove();
            results.push({ id: op.id, ok: true, action: 'delete' });
          } else {
            results.push({ id: op.id, ok: true, action: 'delete', message: 'Already removed' });
          }
          continue;
        }
        const node = await figma.getNodeByIdAsync(String(op.id));
        if (!node) {
          results.push({ id: op.id, ok: false, action: 'update', message: 'Node not found' });
          continue;
        }
        if (op.text !== undefined && node.type === 'TEXT') {
          await setTextSafely(node, op.text);
        }
        const style = op.style || {};
        resizeAndPlaceNode(node, style);
        await applyStyle(node, style);
        applyAutoLayoutUpdate(node, style.autoLayout);
        results.push({ id: op.id, ok: true, action: 'update' });
      } catch (error) {
        results.push({ id: op.id, ok: false, action: op.action || 'update', message: String(error && error.message || error) });
      }
    }
  } catch (error) {
    fatal = String(error && error.message || error);
  }

  const counts = { created: 0, updated: 0, deleted: 0, failed: 0 };
  for (const r of results) {
    if (r.action === 'create-page') continue;
    if (!r.ok) counts.failed += 1;
    else if (r.action === 'create') counts.created += 1;
    else if (r.action === 'update') counts.updated += 1;
    else if (r.action === 'delete') counts.deleted += 1;
  }

  // Transactional rollback: a brand-new page starts empty, so if the build hit a
  // fatal error or any op failed, remove the whole page — never leave a half-built
  // page behind (all-or-nothing for the new-page/import flow).
  let rolledBack = false;
  if (newPage && (fatal || counts.failed > 0)) {
    try {
      if (typeof figma.setCurrentPageAsync === 'function') await figma.setCurrentPageAsync(prevPage);
      else figma.currentPage = prevPage;
      if (!newPage.removed) newPage.remove();
      rolledBack = true;
    } catch (_) {}
  } else if (newPage) {
    try { figma.currentPage.selection = []; } catch (_) {}
    try { figma.viewport.scrollAndZoomIntoView(newPage.children); } catch (_) {}
  }

  importTargetParent = null;
  return {
    ok: !fatal && results.every((r) => r.ok) && !rolledBack,
    fatal,
    rolledBack,
    counts,
    results,
    created: rolledBack ? {} : createdMap,
    page: (newPage && !rolledBack) ? { id: newPage.id, name: newPage.name } : null
  };
}

postSelectionPreview();

figma.on('selectionchange', () => {
  postSelectionPreview();
});

figma.ui.onmessage = async (msg) => {
  if (!msg) return;
  if (msg.type === 'close') {
    figma.closePlugin();
    return;
  }
  if (msg.type === 'open-url') {
    try {
      if (typeof figma.openExternal === 'function' && /^https?:\/\//i.test(String(msg.url || ''))) {
        figma.openExternal(String(msg.url));
      }
    } catch (e) {}
    return;
  }
  if (msg.type === 'confirm-selection') {
    const selection = selectionSummary();
    if (!selection.length) {
      figma.ui.postMessage({ type: 'selection-error', message: 'Please select one Frame or component in Figma.' });
      return;
    }
    const composition = await buildCompositionFromSelection();
    const imageIds = composition ? collectImageIdsFromComposition(composition) : [];
    figma.ui.postMessage({
      type: 'selection-confirmed',
      selection,
      composition,
      imageIds,
      page: { id: figma.currentPage.id, name: figma.currentPage.name }
    });
  }
  if (msg.type === 'export-missing-images') {
    try {
      const ids = Array.isArray(msg.ids) ? msg.ids : [];
      if (ids.length === 0) {
        figma.ui.postMessage({ type: 'export-missing-images:result', items: [] });
        return;
      }
      const batchSize = 8;
      const items = [];
      for (let i = 0; i < ids.length; i += batchSize) {
        const batch = ids.slice(i, i + batchSize);
        const results = await Promise.all(batch.map(async (imageId) => {
          try {
            const img = figma.getImageByHash(imageId);
            if (!img) return null;
            const bytes = await img.getBytesAsync();
            return { id: imageId, data: figma.base64Encode(bytes) };
          } catch (e) { return null; }
        }));
        results.forEach(r => { if (r) items.push(r); });
      }
      figma.ui.postMessage({ type: 'export-missing-images:result', items });
    } catch (e) {
      figma.ui.postMessage({ type: 'export-missing-images:result', items: [] });
    }
  }
  if (msg.type === 'export-figma-render') {
    try {
      let node = null;
      if (msg.nodeId) {
        try { node = await figma.getNodeByIdAsync(String(msg.nodeId)); } catch (_) {}
      }
      if (!node) {
        const sel = figma.currentPage.selection || [];
        node = sel.length === 1 ? sel[0] : null;
      }
      if (!node || typeof node.exportAsync !== 'function') {
        figma.ui.postMessage({ type: 'export-figma-render:result', base64: '', requestId: msg.requestId });
        return;
      }
      const bytes = await node.exportAsync({ format: 'PNG' });
      const b64 = figma.base64Encode(bytes);
      figma.ui.postMessage({ type: 'export-figma-render:result', base64: b64, requestId: msg.requestId });
    } catch (e) {
      figma.ui.postMessage({ type: 'export-figma-render:result', base64: '', requestId: msg.requestId });
    }
  }
  if (msg.type === 'apply-patch') {
    const result = await applyPatch(msg.patch);
    figma.ui.postMessage({ type: 'apply-patch-result', result });
  }
};
