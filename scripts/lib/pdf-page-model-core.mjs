// Platform-neutral pdf.js page model + page rendering (B4.7: shared by the Node tools and the
// in-browser "Prepare Paper Automatically" pipeline). No fs, no Node APIs.
//
// The caller supplies an opened pdf.js document, its OPS table and a canvas factory
// `createCanvas(width, height) -> { canvas, context }` (Node: pdf.canvasFactory; browser: DOM canvas).

import { buildFontScriptMap, detectColumnsFromNumbers, detectColumns } from './paper-layout.mjs'
import { applyMathNotation } from './math-notation.mjs'

export function parsePages(spec, numPages) {
  if (!spec) return Array.from({ length: numPages }, (_, i) => i + 1)
  const out = new Set()
  for (const part of String(spec).split(',')) {
    const m = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/)
    if (!m) continue
    for (let p = Number(m[1]); p <= Math.min(Number(m[2] || m[1]), numPages); p++) if (p >= 1) out.add(p)
  }
  return [...out].sort((a, b) => a - b)
}

// Multiply 2D affine matrices in pdf.js order [a,b,c,d,e,f].
const mul = (m1, m2) => [
  m1[0] * m2[0] + m1[2] * m2[1], m1[1] * m2[0] + m1[3] * m2[1],
  m1[0] * m2[2] + m1[2] * m2[3], m1[1] * m2[2] + m1[3] * m2[3],
  m1[0] * m2[4] + m1[2] * m2[5] + m1[4], m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
]

// Image XObjects are drawn into the unit square; the current transform gives their rect.
// B4.8.3B: the same walk also keeps small path boxes ("frames": the clip/fill boxes an equation object
// draws around a stacked fraction) and each image's object id (identical bitmaps reuse one object).
// B4.8.3C: every SMALL image (a notation-sized bitmap, w < 300 and h < 80 pt) also gets a pixel
// fingerprint, so identical bitmaps are recognised whatever PDF object carries them. Identity is exact
// pixels, never visual similarity: the hash covers the decoded size and every RGBA byte.
export const SMALL_IMAGE = Object.freeze({ maxW: 300, maxH: 80 })

// Decoded pixels of one image object as canonical RGBA, or null. Only RAW decoded data counts
// (kind 1 = 1-bit gray, 2 = RGB, 3 = RGBA): reading an ImageBitmap back through a canvas is not
// pixel-exact (measured: OffscreenCanvas and DOM canvas readbacks disagree), so the browser opens a
// geometry document with OffscreenCanvas off (browserPlatform.openPdf) and a bitmap is never hashed.
function canonicalRgba(img) {
  const { width: w, height: h } = img || {}
  if (!(w > 0 && h > 0)) return null
  if (img.data) {
    const src = img.data, out = new Uint8Array(w * h * 4)
    if (img.kind === 3 && src.length >= w * h * 4) out.set(src.subarray(0, w * h * 4))
    else if (img.kind === 2 && src.length >= w * h * 3) for (let i = 0, j = 0; i < w * h; i++, j += 3) out.set([src[j], src[j + 1], src[j + 2], 255], i * 4)
    else if (img.kind === 1) {
      const row = (w + 7) >> 3
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const v = (src[y * row + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0
        out.set([v, v, v, 255], (y * w + x) * 4)
      }
    } else return null
    return out
  }
  return null
}

async function sha256Hex(bytes) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

// The pdf.js image object for a paint op's name (document-level "g_…" cache or the page's), awaited:
// in a browser the worker may still be delivering it when the operator list resolves. Null after
// `ms` — located but unfingerprinted, never a guess.
function resolvedImage(page, name, ms = 5000) {
  const store = name.startsWith('g_') ? page.commonObjs : page.objs
  if (!store?.get) return Promise.resolve(null)
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), ms)
    try { store.get(name, data => { clearTimeout(timer); resolve(data ?? null) }) } catch { clearTimeout(timer); resolve(null) }
  })
}

export async function imageFingerprint(img) {
  const rgba = canonicalRgba(img)
  if (!rgba) return null
  const head = new TextEncoder().encode(`${img.width}x${img.height}:`)
  const bytes = new Uint8Array(head.length + rgba.length)
  bytes.set(head); bytes.set(rgba, head.length)
  return { fp: `px:${(await sha256Hex(bytes)).slice(0, 24)}`, px: [img.width, img.height] }
}

export async function pageGeometry(page, OPS, { fingerprints = true } = {}) {
  const ops = await page.getOperatorList()
  const stack = []
  let ctm = [1, 0, 0, 1, 0, 0]
  const rects = [], frames = []
  const r1 = v => Math.round(v * 10) / 10
  const boxOf = (x0, y0, x1, y1) => {
    const corners = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(([x, y]) => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]])
    const xs = corners.map(c => c[0]); const ys = corners.map(c => c[1])
    return { x: r1(Math.min(...xs)), y: r1(Math.min(...ys)), w: r1(Math.max(...xs) - Math.min(...xs)), h: r1(Math.max(...ys) - Math.min(...ys)) }
  }
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i]
    const args = ops.argsArray[i]
    if (fn === OPS.save) stack.push(ctm.slice())
    else if (fn === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0]
    else if (fn === OPS.transform) ctm = mul(ctm, args)
    else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject) {
      rects.push({ ...boxOf(0, 0, 1, 1), ...(typeof args?.[0] === 'string' ? { obj: args[0] } : {}) })
    } else if (fn === OPS.constructPath && args?.[2]?.length >= 4) {   // pdf.js 6: [paintOp, pathData, bbox]
      const b = args[2]
      const f = boxOf(b[0], b[1], b[2], b[3])
      if (f.w > 0 && f.h > 0 && f.w < 120 && f.h < 40) frames.push(f)
    }
  }
  const images = rects.filter(r => r.w > 1 && r.h > 1)
  if (fingerprints) {
    for (const im of images) {
      if (!im.obj || im.w >= SMALL_IMAGE.maxW || im.h >= SMALL_IMAGE.maxH) continue
      const f = await imageFingerprint(await resolvedImage(page, im.obj))
      if (f) Object.assign(im, f); else im.fp = null        // unreadable: located, never grouped
    }
  }
  return { images, frames }
}
export async function imageRects(page, OPS) { return (await pageGeometry(page, OPS)).images }

// B4.8.4B: identity evidence for a font that draws private-use (legacy) glyphs — its per-code advance
// widths and a checksum of the program pdf.js built. Needs the document opened with
// fontExtraProperties: true (else no widths: the legacy decoder then refuses). The font resolves only
// once the page's operator list has been built. Null after `ms`: unidentified, never guessed.
const PRIVATE_USE = /[-]/
function resolvedFont(page, fontName, ms = 5000) {
  if (!page.commonObjs?.get) return Promise.resolve(null)
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), ms)
    try { page.commonObjs.get(fontName, f => { clearTimeout(timer); resolve(f ?? null) }) } catch { clearTimeout(timer); resolve(null) }
  })
}
// glyphs: [[text code point, advance width]] — the private-use character pdf.js reports for each glyph
// (its to-Unicode map: glyph id -> character) paired with that glyph's width (keyed by glyph id). The
// pairing binds the ENCODING (which character names which glyph) to the font's metrics.
async function legacyFontInfo(page, fontName) {
  const f = await resolvedFont(page, fontName)
  if (!f) return { name: null, glyphs: [], program: null }
  const w = f.widths || {}, map = Array.isArray(f.toUnicode?._map) ? f.toUnicode._map : []
  const byCode = new Map()
  map.forEach((u, gid) => {
    if (typeof u !== 'string' || [...u].length !== 1 || !PRIVATE_USE.test(u) || typeof w[gid] !== 'number') return
    const code = u.codePointAt(0)
    byCode.set(code, byCode.has(code) && byCode.get(code) !== w[gid] ? NaN : w[gid])   // one code, two widths: unusable
  })
  const glyphs = [...byCode].filter(([, v]) => Number.isFinite(v)).sort((a, b) => a[0] - b[0])
  const program = f.data?.length ? `sha256:${(await sha256Hex(new Uint8Array(f.data))).slice(0, 16)}` : null
  return { name: f.name ?? null, glyphs, program }
}

// Text items + image rectangles per page — what the pure B4 engines consume.
// geometryPdf (optional): a second handle on the SAME bytes whose images arrive as raw decoded data
// (browser: opened with OffscreenCanvas off); image rects, frames and fingerprints come from it. The
// main document (rendering, OCR) is untouched. Node delivers raw data already and passes none.
export async function buildPageModelsFromPdf(pdf, OPS, { pageSpec = null, onPage = null, mathNotation = true, geometryPdf = null } = {}) {
  const wanted = parsePages(pageSpec, pdf.numPages)
  const pages = []
  const fonts = {}   // B4.8.4B: fontName (main document) -> legacyFontInfo, for fonts drawing private-use glyphs
  for (const pageNum of wanted) {
    const page = await pdf.getPage(pageNum)
    const viewport = page.getViewport({ scale: 1 })
    const content = await page.getTextContent()
    const geometry = await pageGeometry(geometryPdf ? await geometryPdf.getPage(pageNum) : page, OPS)
    const legacyNames = [...new Set(content.items.filter(i => PRIVATE_USE.test(i.str || '')).map(i => i.fontName))].filter(n => n && !(n in fonts))
    if (legacyNames.length) {
      await page.getOperatorList()   // loads the page's fonts (Node: already built above; cached)
      for (const n of legacyNames) fonts[n] = await legacyFontInfo(page, n)
    }
    pages.push({
      page: pageNum,
      widthPt: Math.round(viewport.width * 100) / 100,
      heightPt: Math.round(viewport.height * 100) / 100,
      items: content.items.filter(i => i.str !== undefined).map(i => ({
        str: i.str,
        x: Math.round(i.transform[4] * 10) / 10,
        y: Math.round(i.transform[5] * 10) / 10,
        width: Math.round((i.width || 0) * 10) / 10,
        height: Math.round((i.height || 0) * 10) / 10,
        fontName: i.fontName,
        dir: i.dir,
      })),
      images: geometry.images,
      frames: geometry.frames,
    })
    if (onPage) await onPage(pageNum, wanted.length)
  }
  // B4.8.3B: deterministic math notation, once for the whole paper, before ANY parsing — so B4.1, B4.3
  // and B4.4 all read the same text (reading-order leaks such as a stacked numerator falling into the
  // previous question are repaired at the source). The original items stay as `inkItems`.
  if (!mathNotation) return { pages, numPages: pdf.numPages, fonts }
  const fontScriptMap = buildFontScriptMap(pages)
  const legacyFonts = new Set([...fontScriptMap].filter(([, s]) => s === 'TELUGU_LEGACY').map(([f]) => f))
  const grid = detectColumnsFromNumbers(pages)
  const columnsOf = page => grid?.columns || detectColumns(page).columns
  return { pages: applyMathNotation(pages, { legacyFonts, columnsOf }), numPages: pdf.numPages, fonts }
}

// Render one page at `scale` on a white background. Returns the canvas (for cropping) plus a
// grayscale raster (Uint8Array, row-major, top-left origin) for the pure detector when `gray`.
export async function renderPageWith(createCanvas, pdf, pageNumber, scale, { gray = true } = {}) {
  const page = await pdf.getPage(pageNumber)
  const base = page.getViewport({ scale: 1 })
  const viewport = page.getViewport({ scale })
  const width = Math.floor(viewport.width)
  const height = Math.floor(viewport.height)
  const { canvas, context } = createCanvas(width, height)
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, width, height)
  const task = page.render({ canvasContext: context, canvas, viewport })
  // pdf.js continues a display render with requestAnimationFrame in a browser; a hidden or
  // background tab gets no frames, so preparation would stall. Continue with microtasks instead,
  // exactly as pdf.js already does in Node (no window) — same drawing, same output.
  if (task._internalRenderTask) task._internalRenderTask._useRequestAnimationFrame = false
  await task.promise
  let g = null
  if (gray) {
    const rgba = context.getImageData(0, 0, width, height).data
    g = new Uint8Array(width * height)
    for (let i = 0, p = 0; i < g.length; i++, p += 4) g[i] = (rgba[p] * 299 + rgba[p + 1] * 587 + rgba[p + 2] * 114) / 1000
  }
  return { canvas, gray: g, width, height, scale, pageWidthPt: base.width, pageHeightPt: base.height }
}

// Copy a pixel rectangle of a rendered canvas into a new canvas (encoding is the platform's job).
export function cropCanvas(createCanvas, canvas, { sx, sy, sw, sh }) {
  const { canvas: out, context } = createCanvas(sw, sh)
  context.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh)
  return out
}
