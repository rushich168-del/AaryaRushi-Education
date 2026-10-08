// B4.3 — Automatic visual detection & cropping (offline, pure).
//
// Input: the B4.1 page model (pdf.js text items), the B4.1 paper model (questions with
// figure-gap candidates), and one grayscale raster per page rendered by pdf.js. Output: a
// crop MANIFEST — every ink cluster the detector saw, with an ACCEPTED/REJECTED verdict, the
// reasons, a confidence, and (for accepted ones) the exact normalized source region to crop.
//
// The golden paper has no usable figure objects (its image XObjects are one repeated
// background; there are no vector paths in the operator list), so a figure is recognised
// from the RENDERED page: dark pixels that are neither text (pdf.js item rectangles) nor
// decoration (ink present at the same place on most pages: frame, column rule, watermark).
//
// Safety posture: prefer missing a visual (route to review) over attaching a wrong one.
// Only question-owned visuals that sit inside that question's own lines, before its options,
// clear of any real text, are accepted. Nothing here touches a database or the network.

import {
  buildFontScriptMap, detectColumnsFromNumbers, detectColumns, buildLines, readingOrder,
  findQuestionStarts, segmentQuestions, findAnswerKeyPage, classifyItemScript,
} from './paper-layout.mjs'

export const B43_DETECTOR = 'ksc-b43-visual-detector'
export const B43_DETECTOR_VERSION = '1.0.0'

// Kinds the detector may emit. It cannot tell a diagram from a chart deterministically, so
// every accepted visual gets the neutral FIGURE kind. TEXT_REGION is never produced here.
export const AUTO_VISUAL_KIND = 'FIGURE'

export const DEFAULTS = Object.freeze({
  scale: 2,                 // analysis and crop scale; equals B2's DRAFT_MEDIA_RENDER_SCALE
  darkThreshold: 140,       // luminance below this is ink (the watermark is far lighter)
  decorationShare: 0.5,     // ink at the same pixel on >= half the pages is decoration
  decorationDilatePx: 2,
  textPadXPt: 1.0,
  textPadAbovePt: 1.5,      // above item.y + item.height
  textPadBelowFactor: 0.45, // below the baseline, as a share of the font size (Telugu vowel signs)
  cellPt: 1,                // component grid resolution
  bridgeCells: 2,           // dilation that joins the strokes of one drawing
  clusterGapPt: 10,         // components closer than this are one figure
  minInkCells: 40,          // smaller residue is glyph overflow / specks
  minFigureWPt: 24,
  minFigureHPt: 16,
  ruleMaxThicknessPt: 3,    // thinner than this in either direction = a rule, underline or fraction bar
  paddingPt: 6,
  labelMaxChars: 3,         // short Latin/number labels inside a drawing (cube faces, vertices)
  zoneEdgeMarginPt: 1,
  materialSlackPt: 14,      // a material figure may extend a little beyond its block's text lines
  acceptConfidence: 0.85,
})

const FIGURE_WORDS = /\b(figures?|diagrams?|triangles?|squares?|circles?|graphs?|charts?|pictures?|images?|cubes?|dice|venn|given below|shown below|shown)\b/i
const OPTION_MARKER_ITEM = /^[A-D1-4]\s*[).]/
const LATIN_OR_NEUTRAL = new Set(['LATIN', 'NEUTRAL'])

// ---------- geometry helpers (PDF points, y grows upward) --------------------------------
const rectOverlap = (a, b) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) *
  Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0))
const intersects = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1
const area = r => Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0)
const contains = (outer, inner, eps = 0) => inner.x0 >= outer.x0 - eps && inner.x1 <= outer.x1 + eps &&
  inner.y0 >= outer.y0 - eps && inner.y1 <= outer.y1 + eps
const round1 = v => Math.round(v * 10) / 10
const round4 = v => Math.round(v * 10000) / 10000
const roundRect = r => ({ x0: round1(r.x0), y0: round1(r.y0), x1: round1(r.x1), y1: round1(r.y1) })

export function itemRect(it, o = DEFAULTS) {
  const h = it.height || 10
  return {
    x0: it.x - o.textPadXPt,
    x1: it.x + (it.width || 0) + o.textPadXPt,
    y0: it.y - h * o.textPadBelowFactor,
    y1: it.y + h + o.textPadAbovePt,
  }
}

// Normalized, top-left origin region (the draft_media contract) from a PDF-point rect.
export function toNormalizedRegion(r, pageWidthPt, pageHeightPt) {
  return {
    x: round4(r.x0 / pageWidthPt),
    y: round4((pageHeightPt - r.y1) / pageHeightPt),
    w: round4((r.x1 - r.x0) / pageWidthPt),
    h: round4((r.y1 - r.y0) / pageHeightPt),
  }
}

// Integer pixel rectangle on a raster rendered at `scale`.
export function toPixelRect(r, pageHeightPt, scale, rasterW, rasterH) {
  const sx = Math.max(0, Math.floor(r.x0 * scale))
  const sy = Math.max(0, Math.floor((pageHeightPt - r.y1) * scale))
  const ex = Math.min(rasterW, Math.ceil(r.x1 * scale))
  const ey = Math.min(rasterH, Math.ceil((pageHeightPt - r.y0) * scale))
  return { sx, sy, sw: ex - sx, sh: ey - sy }
}

// ---------- question zones (recomputed with the exact B4.1 functions) ---------------------
// The B4.1 JSON keeps only a merged bbox per page. Crops must be clamped to one question's
// own lines per page AND column, so the segments are rebuilt with the same exported B4.1
// functions (identical input -> identical segmentation) and checked against the model.
export function buildQuestionZones(pages, model) {
  const fontScriptMap = buildFontScriptMap(pages)
  const paperColumns = detectColumnsFromNumbers(pages)
  const linesByPage = new Map()
  let allLines = []
  const columnByPage = new Map()
  for (const page of pages) {
    const cm = paperColumns || detectColumns(page)
    columnByPage.set(page.page, cm)
    const lines = buildLines(page, cm)
    linesByPage.set(page.page, lines)
    allLines = allLines.concat(lines)
  }
  const columns = (paperColumns || columnByPage.get(pages[0]?.page))?.columns || []
  const keyPage = findAnswerKeyPage(pages, linesByPage)
  const ordered = readingOrder(allLines.filter(l => !keyPage || l.page !== keyPage.page))
  const starts = findQuestionStarts(ordered, columns)
  const segments = segmentQuestions(ordered, starts)

  const modelNumbers = (model?.questions || []).map(q => q.number)
  const segNumbers = segments.map(s => s.number)
  const consistent = modelNumbers.length === segNumbers.length && modelNumbers.every((n, i) => n === segNumbers[i])

  const pageById = new Map(pages.map(p => [p.page, p]))
  const zones = []
  segments.forEach((seg, qIndex) => {
    const startCol = columns.find(c => c.index === seg.startLine?.column)
    // Reading-order position of the first option-marker line: anything after it is option territory.
    let firstOptionLine = null
    for (const line of seg.lines) {
      if (line.items.some(it => OPTION_MARKER_ITEM.test(it.str.trim()) && !(startCol && Math.abs(it.x - startCol.numberX) <= 8))) {
        firstOptionLine = line; break
      }
    }
    const groups = new Map()
    for (const line of seg.lines) {
      const key = `${line.page}:${line.column}`
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(line)
    }
    for (const [key, lines] of groups) {
      const [page, column] = key.split(':').map(Number)
      const col = columns.find(c => c.index === column)
      const p = pageById.get(page)
      const tops = lines.flatMap(l => l.items.map(it => it.y + (it.height || 10)))
      const bottoms = lines.flatMap(l => l.items.map(it => it.y - (it.height || 10) * 0.3))
      zones.push({
        questionIndex: qIndex,
        number: seg.number,
        page,
        column,
        x0: col ? col.from : 0,
        x1: col ? Math.min(col.to, p?.widthPt ?? col.to) : (p?.widthPt ?? 595),
        y0: Math.min(...bottoms),
        y1: Math.max(...tops),
        lines,
        firstOptionLine,
        startColumnNumberX: startCol?.numberX ?? null,
      })
    }
  })
  return { zones, columns, fontScriptMap, keyPage: keyPage?.page ?? null, consistent, segments }
}

// Reading order is page, then column, then top-down. A drawing whose top edge is below the
// top of the first option-marker line (or in a later column/page) is in option territory.
export function isAtOrAfterOptions(page, column, box, optionLine) {
  if (page !== optionLine.page) return page > optionLine.page
  if (column !== optionLine.column) return column > optionLine.column
  const optionTop = Math.max(...optionLine.items.map(it => it.y + (it.height || 10)))
  return box.y1 <= optionTop
}

// ---------- raster masks ----------------------------------------------------------------
export function darkMask(raster, o = DEFAULTS) {
  const m = new Uint8Array(raster.gray.length)
  for (let i = 0; i < m.length; i++) m[i] = raster.gray[i] < o.darkThreshold ? 1 : 0
  return m
}

function dilate(mask, w, h, r) {
  if (r <= 0) return mask
  const tmp = new Uint8Array(mask.length)
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      if (!mask[row + x]) continue
      for (let dx = Math.max(0, x - r); dx <= Math.min(w - 1, x + r); dx++) tmp[row + dx] = 1
    }
  }
  const out = new Uint8Array(mask.length)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!tmp[y * w + x]) continue
      for (let dy = Math.max(0, y - r); dy <= Math.min(h - 1, y + r); dy++) out[dy * w + x] = 1
    }
  }
  return out
}

// Decoration = NON-TEXT ink at the same place on at least `decorationShare` of the pages.
// Each page's own text is excluded first (textMasks[i]); otherwise a fixed line grid would
// make ordinary text positions look like decoration and erase figures drawn there.
// The reference grid is the most common raster size (a page may differ by a pixel after
// rounding); other sizes are compared by proportional resampling, never skipped.
export function buildDecorationMask(rasters, o = DEFAULTS, textMasks = null) {
  const sizes = new Map()
  for (const r of rasters) { const k = `${r.width}x${r.height}`; sizes.set(k, (sizes.get(k) || 0) + 1) }
  const [width, height] = [...sizes.entries()].sort((a, b) => b[1] - a[1])[0][0].split('x').map(Number)
  const counts = new Uint16Array(width * height)
  rasters.forEach((r, k) => {
    const text = textMasks?.[k]
    const ink = i => r.gray[i] < o.darkThreshold && !(text && text[i])
    if (r.width === width && r.height === height) {
      for (let i = 0; i < counts.length; i++) if (ink(i)) counts[i]++
      return
    }
    for (let y = 0; y < height; y++) {
      const ry = Math.min(r.height - 1, Math.round(y * r.height / height))
      for (let x = 0; x < width; x++) {
        const rx = Math.min(r.width - 1, Math.round(x * r.width / width))
        if (ink(ry * r.width + rx)) counts[y * width + x]++
      }
    }
  })
  const threshold = Math.max(2, Math.ceil(rasters.length * o.decorationShare))
  const mask = new Uint8Array(counts.length)
  for (let i = 0; i < mask.length; i++) mask[i] = counts[i] >= threshold ? 1 : 0
  return { mask: dilate(mask, width, height, o.decorationDilatePx), width, height, threshold, pages: rasters.length }
}

// The decoration mask on a given raster's own pixel grid.
export function decorationFor(decoration, raster) {
  if (raster.width === decoration.width && raster.height === decoration.height) return decoration.mask
  const out = new Uint8Array(raster.width * raster.height)
  for (let y = 0; y < raster.height; y++) {
    const dy = Math.min(decoration.height - 1, Math.round(y * decoration.height / raster.height))
    for (let x = 0; x < raster.width; x++) {
      const dx = Math.min(decoration.width - 1, Math.round(x * decoration.width / raster.width))
      out[y * raster.width + x] = decoration.mask[dy * decoration.width + dx]
    }
  }
  return out
}

// B4.8.3B: pixel masks and text-overlap checks use every ORIGINAL glyph (page.inkItems), including the
// stacked numerators/exponents that the math pass folded into their host text.
export const inkItemsOf = page => page.inkItems || page.items

export function textMask(page, raster, o = DEFAULTS) {
  const { width, height, scale } = raster
  const m = new Uint8Array(width * height)
  for (const it of inkItemsOf(page)) {
    if (!it.str || !it.str.trim()) continue
    const r = itemRect(it, o)
    const px = toPixelRect(r, page.heightPt, scale, width, height)
    for (let y = px.sy; y < px.sy + px.sh; y++) m.fill(1, y * width + px.sx, y * width + px.sx + px.sw)
  }
  return m
}

// ---------- connected components on a 1pt cell grid -------------------------------------
function cellGrid(mask, raster, pageHeightPt, cellPt) {
  const { width, height, scale } = raster
  const cw = Math.ceil(width / (scale * cellPt))
  const ch = Math.ceil(height / (scale * cellPt))
  const cells = new Uint8Array(cw * ch)
  const counts = new Uint16Array(cw * ch)
  for (let y = 0; y < height; y++) {
    const cy = Math.floor(y / (scale * cellPt))
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue
      const i = cy * cw + Math.floor(x / (scale * cellPt))
      cells[i] = 1
      counts[i]++
    }
  }
  return { cells, counts, cw, ch }
}

function components(grid, bridge) {
  const { cells, counts, cw, ch } = grid
  const joined = dilate(cells, cw, ch, bridge)
  const label = new Int32Array(cw * ch).fill(-1)
  const comps = []
  const queue = new Int32Array(cw * ch)
  for (let start = 0; start < joined.length; start++) {
    if (!joined[start] || label[start] !== -1) continue
    const id = comps.length
    let head = 0, tail = 0
    queue[tail++] = start; label[start] = id
    const c = { id, cx0: Infinity, cy0: Infinity, cx1: -Infinity, cy1: -Infinity, cells: 0, pixels: 0 }
    while (head < tail) {
      const i = queue[head++]
      const x = i % cw, y = (i / cw) | 0
      if (cells[i]) {
        c.cells++; c.pixels += counts[i]
        if (x < c.cx0) c.cx0 = x; if (x > c.cx1) c.cx1 = x
        if (y < c.cy0) c.cy0 = y; if (y > c.cy1) c.cy1 = y
      }
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy
        if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue
        const j = ny * cw + nx
        if (joined[j] && label[j] === -1) { label[j] = id; queue[tail++] = j }
      }
    }
    if (c.cells > 0) comps.push(c)
  }
  return comps
}

// Cell bbox -> PDF-point rect (y up).
const cellsToRect = (c, pageHeightPt, cellPt) => ({
  x0: c.cx0 * cellPt, x1: (c.cx1 + 1) * cellPt,
  y1: pageHeightPt - c.cy0 * cellPt, y0: pageHeightPt - (c.cy1 + 1) * cellPt,
})

// Merge components whose rectangles lie within `gap` points of one another.
function clusterRects(rects, gap) {
  const items = rects.map(r => ({ ...r, members: [r] }))
  let merged = true
  while (merged) {
    merged = false
    outer: for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i], b = items[j]
        if (a.x0 - gap < b.x1 && b.x0 - gap < a.x1 && a.y0 - gap < b.y1 && b.y0 - gap < a.y1) {
          items[i] = {
            x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1),
            cells: a.cells + b.cells, pixels: a.pixels + b.pixels, members: a.members.concat(b.members),
          }
          items.splice(j, 1)
          merged = true
          break outer
        }
      }
    }
  }
  return items
}

// ---------- per-page detection ------------------------------------------------------------
function itemScriptOf(it, fontScriptMap) {
  return fontScriptMap?.get(it.fontName) === 'TELUGU_LEGACY' ? 'TELUGU_LEGACY' : classifyItemScript(it.str)
}

function pageClusters(page, raster, decoration, o, text) {
  const dark = darkMask(raster, o)
  const deco = decorationFor(decoration, raster)
  const residual = new Uint8Array(dark.length)
  const decoInk = new Uint8Array(dark.length)
  for (let i = 0; i < dark.length; i++) {
    if (!dark[i] || text[i]) continue
    if (deco[i]) decoInk[i] = 1
    else residual[i] = 1
  }
  const resid = components(cellGrid(residual, raster, page.heightPt, o.cellPt), o.bridgeCells)
    .map(c => ({ ...cellsToRect(c, page.heightPt, o.cellPt), cells: c.cells, pixels: c.pixels }))
  const decoComps = components(cellGrid(decoInk, raster, page.heightPt, o.cellPt), o.bridgeCells)
    .map(c => ({ ...cellsToRect(c, page.heightPt, o.cellPt), cells: c.cells }))
  return { clusters: clusterRects(resid, o.clusterGapPt), decorationComponents: decoComps, residual, decoInk }
}

// Evaluate one ink cluster against the question zones of its page. Returns a manifest row.
function evaluateCluster(cluster, ctx, o) {
  const { page, zonesOnPage, fontScriptMap, modelByNumber, raster } = ctx
  const box = { x0: cluster.x0, y0: cluster.y0, x1: cluster.x1, y1: cluster.y1 }
  const wPt = box.x1 - box.x0, hPt = box.y1 - box.y0
  const row = {
    page: page.page, inkBoxPt: roundRect(box), inkCells: cluster.cells, reasons: [], status: 'REJECTED',
    questionNumber: null, column: null, tier: null, confidence: 0,
  }
  // 1. Noise and rules never become candidates worth a question's attention.
  if (cluster.cells < o.minInkCells || wPt < o.minFigureWPt || hPt < o.minFigureHPt) {
    row.reasons.push(wPt <= o.ruleMaxThicknessPt || hPt <= o.ruleMaxThicknessPt ? 'RULE_OR_BAR' : 'BELOW_MIN_SIZE')
    row.noise = true
    return row
  }
  if (wPt <= o.ruleMaxThicknessPt * 2 || hPt <= o.ruleMaxThicknessPt * 2) {
    row.reasons.push('RULE_OR_BAR'); row.noise = true; return row
  }

  // 2. Ownership: the cluster must sit entirely inside ONE question's zone on this page.
  const touching = zonesOnPage.filter(z => intersects(z, box))
  if (touching.length === 0) {
    // Inside a shared-material block (a Directions passage/data/figure area): the figure belongs
    // to that MATERIAL, never to a question. Judged by evaluateMaterialCluster.
    const material = (ctx.materialZonesOnPage || []).find(z => contains({ x0: z.x0, x1: z.x1, y0: z.y0 - o.materialSlackPt, y1: z.y1 + o.materialSlackPt },
      { x0: (box.x0 + box.x1) / 2, x1: (box.x0 + box.x1) / 2, y0: (box.y0 + box.y1) / 2, y1: (box.y0 + box.y1) / 2 }))
    if (material) return evaluateMaterialCluster(cluster, row, material, ctx, o)
    // Otherwise unowned ink (e.g. the cover page): reported with the question it precedes and
    // routed to review, never attached.
    row.reasons.push('OUTSIDE_ANY_QUESTION')
    const after = zonesOnPage
      .filter(z => z.x0 <= box.x0 + 1 && box.x1 <= z.x1 + 1 && z.y1 <= box.y0 + 1)
      .sort((a, b) => b.y1 - a.y1)[0]
    row.precedesQuestion = after?.number ?? null
    return row
  }
  const inside = touching.filter(z => contains(z, box, o.zoneEdgeMarginPt))
  const owners = [...new Set(touching.map(z => z.number))]
  if (owners.length > 1 || inside.length !== 1) {
    row.questionNumber = owners.length === 1 ? owners[0] : null
    row.candidateOwners = owners
    row.reasons.push('CROSSES_QUESTION_BOUNDARY')
    return row
  }
  const zone = inside[0]
  row.questionNumber = zone.number
  row.column = zone.column

  // 3. Text inside the drawing: only short Latin/number labels may be absorbed.
  const absorbed = [], blocking = []
  for (const it of inkItemsOf(page)) {
    if (!it.str || !it.str.trim()) continue
    const r = itemRect(it, o)
    if (!intersects(r, box)) continue
    const s = it.str.trim()
    const script = itemScriptOf(it, fontScriptMap)
    const centreInside = contains(box, { x0: (r.x0 + r.x1) / 2, x1: (r.x0 + r.x1) / 2, y0: (r.y0 + r.y1) / 2, y1: (r.y0 + r.y1) / 2 }, 1)
    if (centreInside && s.length <= o.labelMaxChars && LATIN_OR_NEUTRAL.has(script) && !OPTION_MARKER_ITEM.test(s)) absorbed.push({ str: s, rect: r })
    else blocking.push({ str: s, script, rect: r })
  }
  if (blocking.some(b => b.script === 'TELUGU_LEGACY' || b.script === 'TELUGU_UNICODE')) row.reasons.push('TELUGU_TEXT_OVERLAP')
  if (blocking.some(b => OPTION_MARKER_ITEM.test(b.str))) row.reasons.push('OPTION_TEXT_OVERLAP')
  if (blocking.length && !row.reasons.length) row.reasons.push('TEXT_OVERLAP')
  row.absorbedLabels = absorbed.map(a => a.str)

  // 4. Stem only: a drawing at/after the first option marker belongs to an option (or is
  //    ambiguous). Never attached automatically.
  if (zone.firstOptionLine && isAtOrAfterOptions(page.page, zone.column, box, zone.firstOptionLine)) {
    row.reasons.push('OPTION_POSITIONED')
    row.optionOwnedCandidate = true
  }

  // 5. Also refuse clusters that overlap a B4.1 Telugu region.
  const q = modelByNumber.get(zone.number)
  for (const t of q?.teluguRegions || []) {
    if (t.page !== page.page) continue
    const tr = { x0: t.x, y0: t.y, x1: t.x + t.w, y1: t.y + t.h }
    if (rectOverlap(tr, box) > 0.1 * area(box) && !row.reasons.includes('TELUGU_TEXT_OVERLAP')) row.reasons.push('TELUGU_REGION_OVERLAP')
  }

  // 6. Tier: the B4.1 layout-gap candidate is the primary signal.
  const gaps = (q?.visuals?.figureGaps || []).filter(g => g.page === page.page)
  const inGap = gaps.some(g => rectOverlap({ x0: g.x, y0: g.y, x1: g.x + g.w, y1: g.y + g.h }, box) >= 0.5 * area(box))
  row.tier = inGap ? 'LAYOUT_GAP' : 'INK_SCAN'

  // 7. Crop: pad, then pull each edge back so it never includes non-absorbed text,
  //    decoration ink or another cluster, and never leaves the question's zone.
  const crop = {
    x0: Math.max(zone.x0 + 1, box.x0 - o.paddingPt), x1: Math.min(zone.x1 - 1, box.x1 + o.paddingPt),
    y0: Math.max(zone.y0, box.y0 - o.paddingPt), y1: Math.min(zone.y1, box.y1 + o.paddingPt),
  }
  const obstacles = []
  for (const it of inkItemsOf(page)) {
    if (!it.str || !it.str.trim()) continue
    const r = itemRect(it, o)
    if (absorbed.some(a => a.rect.x0 === r.x0 && a.rect.y0 === r.y0)) continue
    obstacles.push(r)
  }
  for (const other of ctx.clusters) if (other !== cluster) obstacles.push(other)
  for (const d of ctx.decorationComponents) obstacles.push(d)
  for (const r of obstacles) {
    if (!intersects(r, crop) || intersects(r, box)) continue
    if (r.y0 >= box.y1) crop.y1 = Math.min(crop.y1, r.y0)
    else if (r.y1 <= box.y0) crop.y0 = Math.max(crop.y0, r.y1)
    else if (r.x0 >= box.x1) crop.x1 = Math.min(crop.x1, r.x0)
    else if (r.x1 <= box.x0) crop.x0 = Math.max(crop.x0, r.x1)
  }
  if (!contains(crop, box, 0.01)) row.reasons.push('CROP_CANNOT_CLEAR_NEIGHBOURS')

  // 8. Confidence (transparent, deterministic).
  const clearance = Math.min(crop.y1 - box.y1, box.y0 - crop.y0)
  const wording = FIGURE_WORDS.test(q?.englishText || '')
  let confidence = row.tier === 'LAYOUT_GAP' ? 0.9 : 0.8
  if (clearance >= 3) confidence += 0.05
  if (wording) confidence += 0.05
  const nearEdge = box.x0 - zone.x0 < 2 || zone.x1 - box.x1 < 2 || box.y0 - zone.y0 < 1 || zone.y1 - box.y1 < 1
  if (nearEdge) confidence -= 0.2
  row.confidence = Math.max(0, Math.min(1, Math.round(confidence * 100) / 100))
  row.signals = { clearancePt: round1(clearance), figureWording: wording, nearZoneEdge: nearEdge }
  if (!row.reasons.length && row.confidence < o.acceptConfidence) row.reasons.push('LOW_CONFIDENCE')

  row.cropPt = roundRect(crop)
  row.region = toNormalizedRegion(crop, page.widthPt, page.heightPt)
  row.pixel = toPixelRect(crop, page.heightPt, raster.scale, raster.width, raster.height)
  row.renderScale = raster.scale
  row.pageWidthPt = page.widthPt
  row.pageHeightPt = page.heightPt
  if (!row.reasons.length) {
    row.status = 'ACCEPTED'
    row.owner = { kind: 'QUESTION', questionNumber: zone.number }
    row.mediaKind = AUTO_VISUAL_KIND
  }
  return row
}

// A figure/table/chart inside a shared-material block. Same zero-wrong-attachment posture as a
// question visual, adapted to what a material legitimately contains:
//   * it must not touch ANY question zone (it can never leak into or out of a question);
//   * no Telugu text may overlap it (Telugu stays a TEXT_REGION, never a figure);
//   * Latin/number labels whose centre lies inside it are part of the drawing (chart labels,
//     table cells, Venn counts) and are absorbed; a label only partly inside is refused;
//   * the crop is clamped away from question zones and from non-absorbed text.
// A material may carry more than one figure (e.g. two pie charts).
function evaluateMaterialCluster(cluster, row, material, ctx, o) {
  const { page, fontScriptMap, raster } = ctx
  let box = { x0: cluster.x0, y0: cluster.y0, x1: cluster.x1, y1: cluster.y1 }
  row.materialIndex = material.index
  row.column = material.column
  row.tier = 'MATERIAL_INK'
  const questionZones = ctx.zonesOnPage || []
  if (questionZones.some(z => intersects(z, box))) { row.reasons.push('CROSSES_QUESTION_BOUNDARY'); return row }
  // Overlap deeper than the text-rectangle padding / 1pt grid quantisation (edge contact is not overlap).
  const TOUCH = 1.5
  const depth = (a, b) => Math.min(Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0))
  // Telugu conflict is judged on the glyph body (baseline-0.25h .. baseline+0.9h), not on the
  // generous masking pad, so a chart title set just under a Telugu line is not "overlapping" it.
  const glyph = it => ({ x0: it.x, x1: it.x + (it.width || 0), y0: it.y - (it.height || 10) * 0.25, y1: it.y + (it.height || 10) * 0.9 })
  const texts = inkItemsOf(page).filter(it => it.str && it.str.trim()).map(it => ({ it, r: itemRect(it, o), g: glyph(it), script: itemScriptOf(it, fontScriptMap) }))
  const telugu = texts.filter(t => !LATIN_OR_NEUTRAL.has(t.script)).map(t => ({ ...t, r: t.g }))
  const zoneLimit = { x0: material.colX0, x1: material.colX1, y0: material.y0 - o.materialSlackPt, y1: material.y1 + o.materialSlackPt }
  // Labels that touch the drawing (Venn set names, chart titles) belong to it: grow the figure box
  // over them, but never into a question zone, over Telugu text or outside the material area.
  for (let guard = 0, grown = true; grown && guard < 12; guard++) {
    grown = false
    for (const t of texts) {
      if (!LATIN_OR_NEUTRAL.has(t.script) || contains(box, t.g)) continue
      const near = { x0: box.x0 - 2, x1: box.x1 + 2, y0: box.y0 - 2, y1: box.y1 + 2 }
      if (!intersects(near, t.r)) continue
      // Grow by the label's glyph extent (not its masking pad), like the Telugu test above.
      const next = { x0: Math.min(box.x0, t.g.x0), y0: Math.min(box.y0, t.g.y0), x1: Math.max(box.x1, t.g.x1), y1: Math.max(box.y1, t.g.y1) }
      if (!contains(zoneLimit, next) || questionZones.some(z => intersects(z, next)) || telugu.some(te => depth(te.r, next) > TOUCH)) continue
      box = next; grown = true
    }
  }
  row.figureBoxPt = roundRect(box)
  const absorbed = [], blocking = []
  for (const t of texts) {
    const latin = LATIN_OR_NEUTRAL.has(t.script)
    if (depth(latin ? t.r : t.g, box) <= TOUCH) continue
    const cx = (t.r.x0 + t.r.x1) / 2, cy = (t.r.y0 + t.r.y1) / 2
    const inside = cx >= box.x0 && cx <= box.x1 && cy >= box.y0 && cy <= box.y1
    if (inside && latin) absorbed.push({ str: t.it.str.trim(), rect: t.r })
    else if (latin && !inside && depth(t.g, box) <= TOUCH) continue    // padding-only contact
    else blocking.push({ str: t.it.str.trim(), script: t.script, rect: t.r })
  }
  if (blocking.some(b => b.script === 'TELUGU_LEGACY' || b.script === 'TELUGU_UNICODE')) row.reasons.push('TELUGU_TEXT_OVERLAP')
  else if (blocking.length) row.reasons.push('TEXT_PARTLY_INSIDE_FIGURE')
  row.absorbedLabels = absorbed.map(a => a.str)
  row.blockingText = blocking.map(b => ({ str: b.str.slice(0, 20), script: b.script, rect: roundRect(b.rect) }))
  const crop = {
    x0: Math.max(material.colX0 + 1, box.x0 - o.paddingPt), x1: Math.min(material.colX1 - 1, box.x1 + o.paddingPt),
    y0: box.y0 - o.paddingPt, y1: box.y1 + o.paddingPt,
  }
  const obstacles = [...(ctx.zonesOnPage || [])]
  for (const it of inkItemsOf(page)) {
    if (!it.str || !it.str.trim()) continue
    const r = itemRect(it, o)
    if (!absorbed.some(a => a.rect.x0 === r.x0 && a.rect.y0 === r.y0)) obstacles.push(r)
  }
  for (const other of ctx.clusters) if (other !== cluster) obstacles.push(other)
  for (const d of ctx.decorationComponents) obstacles.push(d)
  // Anything outside the figure (text, question zones, other ink) is a boundary: the crop's
  // padding stops at it, and never goes beyond the figure edge on that side.
  for (const r of obstacles) {
    if (!intersects(r, crop)) continue
    const cx = (r.x0 + r.x1) / 2, cy = (r.y0 + r.y1) / 2
    if (cx >= box.x0 && cx <= box.x1 && cy >= box.y0 && cy <= box.y1) continue
    if (cy > box.y1) crop.y1 = Math.min(crop.y1, Math.max(r.y0, box.y1))
    else if (cy < box.y0) crop.y0 = Math.max(crop.y0, Math.min(r.y1, box.y0))
    else if (cx > box.x1) crop.x1 = Math.min(crop.x1, Math.max(r.x0, box.x1))
    else if (cx < box.x0) crop.x0 = Math.max(crop.x0, Math.min(r.x1, box.x0))
  }
  if (!contains(crop, box, 0.01)) row.reasons.push('CROP_CANNOT_CLEAR_NEIGHBOURS')
  const clearance = Math.min(crop.y1 - box.y1, box.y0 - crop.y0)
  const wording = /\b(diagram|figure|pie[- ]?charts?|charts?|graphs?|table|venn)\b/i.test(material.heading || '')
  let confidence = 0.85
  if (clearance >= 3) confidence += 0.05
  if (wording) confidence += 0.05
  row.confidence = Math.round(Math.min(1, confidence) * 100) / 100
  row.signals = { clearancePt: round1(clearance), headingWording: wording }
  if (!row.reasons.length && row.confidence < o.acceptConfidence) row.reasons.push('LOW_CONFIDENCE')
  row.cropPt = roundRect(crop)
  row.region = toNormalizedRegion(crop, page.widthPt, page.heightPt)
  row.pixel = toPixelRect(crop, page.heightPt, raster.scale, raster.width, raster.height)
  row.renderScale = raster.scale
  row.pageWidthPt = page.widthPt
  row.pageHeightPt = page.heightPt
  if (!row.reasons.length) {
    row.status = 'ACCEPTED'
    row.owner = { kind: 'MATERIAL', materialIndex: material.index }
    row.mediaKind = AUTO_VISUAL_KIND
  }
  return row
}

// ---------- top level -------------------------------------------------------------------
// pages: B4.1 page models; model: B4.1 paper model; rasters: Map(page -> {gray,width,height,scale}).
export function detectVisuals(pages, model, rasters, options = {}) {
  const o = { ...DEFAULTS, ...options }
  const zoneModel = buildQuestionZones(pages, model)
  if (!zoneModel.consistent) throw new Error('B4.3 segmentation does not match the B4.1 model; refusing to detect.')
  const modelByNumber = new Map((model.questions || []).map(q => [q.number, q]))
  // Shared-material areas (B4.1 materials): the block's text extent per page/column, full column width.
  const materialZones = (model.materials || []).flatMap(m => m.sourceRegions.map(r => {
    const col = zoneModel.columns.find(c => c.index === r.column)
    return { index: m.index, heading: m.heading, page: r.page, column: r.column, x0: col ? col.from : r.x, x1: col ? col.to : r.x + r.w,
      colX0: col ? col.from : r.x, colX1: col ? Math.min(col.to, pages[0]?.widthPt ?? col.to) : r.x + r.w, y0: r.y, y1: r.y + r.h }
  }))
  const questionPages = pages.filter(p => p.page !== zoneModel.keyPage)
  const textMasks = questionPages.map(p => textMask(p, rasters.get(p.page), o))
  const decoration = buildDecorationMask(questionPages.map(p => rasters.get(p.page)), o, textMasks)

  const rows = []
  const decorationRejected = []
  questionPages.forEach((page, k) => {
    const raster = rasters.get(page.page)
    const { clusters, decorationComponents } = pageClusters(page, raster, decoration, o, textMasks[k])
    decorationRejected.push(...decorationComponents.filter(d => d.cells >= o.minInkCells)
      .map(d => ({ page: page.page, boxPt: roundRect(d), cells: d.cells, reason: 'DECORATION' })))
    const ctx = { page, raster, clusters, decorationComponents, fontScriptMap: zoneModel.fontScriptMap, modelByNumber,
      zonesOnPage: zoneModel.zones.filter(z => z.page === page.page),
      materialZonesOnPage: materialZones.filter(z => z.page === page.page) }
    for (const cluster of clusters) rows.push(evaluateCluster(cluster, ctx, o))
  })

  // One accepted visual per question per page is the safe expectation; more than one means
  // the drawing was split or two things were found — both go to review, none attached.
  const acceptedByQuestion = new Map()
  for (const r of rows.filter(r => r.status === 'ACCEPTED')) {
    const list = acceptedByQuestion.get(r.questionNumber) || []
    list.push(r); acceptedByQuestion.set(r.questionNumber, list)
  }
  for (const [, list] of acceptedByQuestion) {
    if (list.length > 1 && list[0].owner?.kind === 'QUESTION') for (const r of list) { r.status = 'REJECTED'; r.reasons.push('MULTIPLE_VISUALS_FOR_QUESTION'); delete r.owner }
  }

  // Every B4.1 layout gap gets an explicit verdict. A gap with no real ink cluster is
  // ordinary whitespace (rule/fraction/speck residue at most) and is rejected as such.
  for (const q of model.questions) {
    for (const g of q.visuals?.figureGaps || []) {
      const gr = { x0: g.x, y0: g.y, x1: g.x + g.w, y1: g.y + g.h }
      const real = rows.some(r => !r.noise && r.page === g.page && intersects(r.inkBoxPt, gr))
      if (real) continue
      const residue = rows.filter(r => r.noise && r.page === g.page && intersects(r.inkBoxPt, gr)).length
      rows.push({ page: g.page, questionNumber: q.number, column: g.column, tier: 'LAYOUT_GAP', status: 'REJECTED',
        reasons: ['WHITESPACE_NO_INK'], confidence: 0, inkBoxPt: roundRect(gr), inkCells: 0, residueComponents: residue })
    }
  }
  rows.sort((a, b) => a.page - b.page || (b.inkBoxPt.y1 - a.inkBoxPt.y1))

  let n = 0
  for (const r of rows) r.id = `p${r.page}-${String(++n).padStart(3, '0')}${r.questionNumber ? `-q${r.questionNumber}` : ''}`

  return { rows, decorationRejected, decorationPixelThreshold: decoration.threshold, zones: zoneModel.zones.length, options: o }
}

// ---------- summary against B4.1 -----------------------------------------------------------
export function summarise(model, detection) {
  const rows = detection.rows
  const real = rows.filter(r => !r.noise)
  const accepted = rows.filter(r => r.status === 'ACCEPTED')
  const b41Status = q => q.visuals.figureGaps.length ? 'GAP_CANDIDATE'
    : (q.reviewReasons.some(r => r.startsWith('VISUAL_EXPECTED_BUT_NONE_FOUND')) ? 'EXPECTED_NONE_FOUND' : 'NONE')
  const perQuestion = model.questions.map(q => {
    const mine = real.filter(r => r.questionNumber === q.number)
    const acc = mine.filter(r => r.status === 'ACCEPTED')
    const b43 = acc.length ? 'AUTO_ATTACHED' : (mine.length ? 'CANDIDATE_REJECTED' : 'NONE')
    return { number: q.number, b41: b41Status(q), b43, accepted: acc.map(r => r.id),
      rejected: mine.filter(r => r.status !== 'ACCEPTED').map(r => ({ id: r.id, reasons: r.reasons })) }
  })
  const predicted = perQuestion.filter(p => p.b41 !== 'NONE' || p.b43 !== 'NONE')
  const confidenceBuckets = {}
  for (const r of real.filter(r => r.confidence > 0)) {
    const b = r.confidence >= 0.95 ? '0.95-1.00' : r.confidence >= 0.85 ? '0.85-0.94' : r.confidence >= 0.7 ? '0.70-0.84' : '<0.70'
    confidenceBuckets[b] = confidenceBuckets[b] || { accepted: 0, rejected: 0 }
    confidenceBuckets[b][r.status === 'ACCEPTED' ? 'accepted' : 'rejected']++
  }
  const reasonCounts = {}
  for (const r of rows.filter(r => r.status !== 'ACCEPTED')) for (const reason of r.reasons) reasonCounts[reason] = (reasonCounts[reason] || 0) + 1
  return {
    questionsPredictedVisual: predicted.length,
    questionsAutoCropped: new Set(accepted.map(r => r.questionNumber)).size,
    cropsAccepted: accepted.length,
    candidatesConsidered: real.length,
    candidatesRejected: real.filter(r => r.status !== 'ACCEPTED').length,
    noiseRejected: rows.filter(r => r.noise).length,
    questionsLeftForReview: predicted.filter(p => p.b43 !== 'AUTO_ATTACHED').map(p => p.number),
    decorationComponentsRejected: detection.decorationRejected.length,
    decorationAttached: 0,
    confidenceBuckets,
    reasonCounts,
    questionsWithMultipleVisuals: [...new Set(real.filter(r => r.reasons.includes('MULTIPLE_VISUALS_FOR_QUESTION')).map(r => r.questionNumber))],
    optionOwnedCandidates: real.filter(r => r.optionOwnedCandidate).map(r => ({ id: r.id, questionNumber: r.questionNumber, reasons: r.reasons })),
    changedFromB41: perQuestion.filter(p => (p.b41 === 'NONE') !== (p.b43 === 'NONE') || p.b43 === 'AUTO_ATTACHED' || (p.b41 !== 'NONE' && p.b43 !== 'AUTO_ATTACHED')),
    perQuestion,
  }
}
