import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import { analysePaper } from './lib/paper-layout.mjs'
import {
  detectVisuals, summarise, toNormalizedRegion, buildDecorationMask, decorationFor, AUTO_VISUAL_KIND,
} from './lib/visual-detection.mjs'

// B4.3 detector — pure tests on a synthetic two-column paper whose raster is drawn by hand,
// plus an opt-in golden-paper run (skipped when the PDF is not on this machine).

const W = 595.32, H = 841.92, SCALE = 1
// Column 2 starts 7pt lower: B4.1 finds column number-x from the leftmost token of each
// baseline, so perfectly aligned columns would hide column 2 (a known B4.1 trait).
const COLS = [{ numberX: 27, tx: 54, top: 790 }, { numberX: 306, tx: 333, top: 783 }]
const LEGACY = String.fromCharCode(0xF041, 0xF042, 0xF043)   // legacy private-use glyphs
const LOGO = { x0: 420, y0: 300, x1: 470, y1: 340 }          // repeated on every page = decoration

function newRaster() {
  return { gray: new Uint8Array(Math.ceil(W * SCALE) * Math.ceil(H * SCALE)).fill(255), width: Math.ceil(W * SCALE), height: Math.ceil(H * SCALE), scale: SCALE }
}
function fill(r, x0, y0, x1, y1) {
  for (let y = Math.floor((H - y1) * SCALE); y < Math.ceil((H - y0) * SCALE); y++) {
    for (let x = Math.floor(x0 * SCALE); x < Math.ceil(x1 * SCALE); x++) {
      if (x >= 0 && y >= 0 && x < r.width && y < r.height) r.gray[y * r.width + x] = 0
    }
  }
}
function drawFigure(r, f) {                                     // outlined box with a diagonal
  fill(r, f.x0, f.y0, f.x1, f.y0 + 1.5); fill(r, f.x0, f.y1 - 1.5, f.x1, f.y1)
  fill(r, f.x0, f.y0, f.x0 + 1.5, f.y1); fill(r, f.x1 - 1.5, f.y0, f.x1, f.y1)
  const steps = 200
  for (let i = 0; i <= steps; i++) {
    const x = f.x0 + (f.x1 - f.x0) * i / steps, y = f.y0 + (f.y1 - f.y0) * i / steps
    fill(r, x, y, x + 1.5, y + 1.5)
  }
}

// Scenario per question number. Every question has a stem, and A)-D) options on two lines.
const SCENARIOS = {
  2: { gap: true, figure: 'stem', wording: true },               // the Q6-like golden shape
  3: { gap: true },                                             // whitespace only
  4: { gap: true, figure: 'stem', teluguInside: true },          // Telugu inside the drawing
  5: { optionGap: true, figure: 'options' },                     // drawing between option lines
  7: { gap: true, figure: 'two' },                               // two drawings in one stem
  8: { crossNext: true },                                        // drawing straddles Q8 and Q9
  10: { gap: true, figure: 'stem', label: '6', wording: true },  // short label inside
  11: { gap: true, rule: true },                                 // underline/fraction bar only
  20: { gap: true, figure: 'stem', telugu: true },               // Telugu line above, clear figure
}

function buildPaper() {
  const pages = [], rasters = new Map(), truth = {}
  let n = 0
  for (let p = 1; p <= 10; p++) {   // decoration threshold = 5 pages
    const items = [], raster = newRaster()
    fill(raster, 18, 18, 578, 20); fill(raster, 18, 822, 578, 824)       // frame
    fill(raster, 18, 18, 20, 824); fill(raster, 576, 18, 578, 824)
    fill(raster, 298, 30, 299, 812)                                    // column rule
    drawFigure(raster, LOGO)
    const text = (str, x, y, width, fontName = 'f15') => {
      items.push({ str, x, y, width, height: 10, fontName, dir: 'ltr' })
      fill(raster, x, y, x + width, y + 7)                             // glyph ink (masked as text)
    }
    for (const col of COLS) {
      let y = col.top
      for (let k = 0; k < 3; k++) {
        const q = ++n, s = SCENARIOS[q] || {}
        text(`${q}.`, col.numberX, y, 10)
        text(s.wording ? `Count the triangles in the figure given below ${q}` : `Question ${q} asks about something`, col.tx, y, 150)
        y -= 14
        if (s.telugu) { text('', col.tx, y, 120, 'f17'); y -= 14 }
        if (s.gap) {
          const top = y + 14, bottom = y - 56           // previous baseline+14 .. next baseline
          const fig = { x0: col.tx + 20, y0: bottom + 16, x1: col.tx + 110, y1: top - 26 }
          if (s.figure === 'stem') { drawFigure(raster, fig); truth[q] = { page: p, fig } }
          if (s.figure === 'two') {
            drawFigure(raster, { ...fig, x1: fig.x0 + 35 }); drawFigure(raster, { ...fig, x0: fig.x0 + 60, x1: fig.x0 + 95 })
          }
          if (s.teluguInside) text('', fig.x0 + 20, (fig.y0 + fig.y1) / 2, 40, 'f17')
          if (s.label) text(s.label, (fig.x0 + fig.x1) / 2 + 8, (fig.y0 + fig.y1) / 2 + 4, 5)
          if (s.rule) fill(raster, col.tx + 10, y - 30, col.tx + 120, y - 29)
          y -= 56
        }
        text('A) one', col.tx, y, 40); text('B) two', col.tx + 100, y, 40)
        if (s.optionGap) {
          const fig = { x0: col.tx + 20, y0: y - 40, x1: col.tx + 110, y1: y - 12 }
          if (s.figure === 'options') drawFigure(raster, fig)
          y -= 56
        } else y -= 14
        text('C) three', col.tx, y, 40); text('D) four', col.tx + 100, y, 40)
        if (s.crossNext) {
          drawFigure(raster, { x0: col.tx + 180, y0: y - 30, x1: col.tx + 235, y1: y + 20 })
        }
        y -= 22
      }
    }
    pages.push({ page: p, widthPt: W, heightPt: H, items, images: [] })
    rasters.set(p, raster)
  }
  return { pages, rasters, truth }
}

const paper = buildPaper()
const model = analysePaper(paper.pages)
const detection = detectVisuals(paper.pages, model, paper.rasters)
const rows = detection.rows
const accepted = rows.filter(r => r.status === 'ACCEPTED')
const rowsFor = q => rows.filter(r => r.questionNumber === q && !r.noise)

test('synthetic paper segments as B4.1 does (60 questions, gaps found)', () => {
  assert.equal(model.questions.length, 60)
  assert.ok(model.questions.find(q => q.number === 2).visuals.figureGaps.length > 0)
})

test('a clear stem drawing in a layout gap is accepted, owned by its question, with region + confidence', () => {
  const r = rowsFor(2)
  assert.equal(r.length, 1)
  assert.equal(r[0].status, 'ACCEPTED')
  assert.equal(r[0].tier, 'LAYOUT_GAP')
  assert.deepEqual(r[0].owner, { kind: 'QUESTION', questionNumber: 2 })
  assert.equal(r[0].mediaKind, AUTO_VISUAL_KIND)
  assert.ok(r[0].confidence >= 0.85 && r[0].confidence <= 1)
  const f = paper.truth[2].fig
  assert.ok(r[0].cropPt.x0 <= f.x0 && r[0].cropPt.x1 >= f.x1 && r[0].cropPt.y0 <= f.y0 && r[0].cropPt.y1 >= f.y1, 'crop contains the drawing')
  for (const k of ['x', 'y', 'w', 'h']) assert.ok(r[0].region[k] >= 0 && r[0].region[k] <= 1)
})

test('crop never includes the surrounding question/option text', () => {
  const page = paper.pages.find(p => p.page === accepted[0].page)
  for (const r of accepted) {
    const pg = paper.pages.find(p => p.page === r.page)
    for (const it of pg.items) {
      if ((r.absorbedLabels || []).includes(it.str.trim())) continue
      const inside = it.x < r.cropPt.x1 && it.x + it.width > r.cropPt.x0 && it.y < r.cropPt.y1 && it.y + 7 > r.cropPt.y0
      assert.ok(!inside, `Q${r.questionNumber} crop overlaps "${it.str}"`)
    }
  }
  assert.ok(page)
})

test('ordinary whitespace gap is rejected as WHITESPACE_NO_INK', () => {
  assert.deepEqual(rowsFor(3).map(r => r.reasons), [['WHITESPACE_NO_INK']])
})

test('Telugu text inside a drawing is never converted into a visual', () => {
  const r = rowsFor(4)
  assert.ok(r.length >= 1 && r.every(x => x.status === 'REJECTED'))
  assert.ok(r.some(x => x.reasons.includes('TELUGU_TEXT_OVERLAP')))
})

test('a clear drawing under a Telugu stem line is still accepted (Telugu line itself is not a figure)', () => {
  const r = rowsFor(20)
  assert.equal(r.length, 1)
  assert.equal(r[0].status, 'ACCEPTED')
})

test('a drawing among the options is an option-positioned candidate, never attached', () => {
  const r = rowsFor(5)
  assert.equal(r.length, 1)
  assert.equal(r[0].status, 'REJECTED')
  assert.ok(r[0].reasons.includes('OPTION_POSITIONED'))
  assert.equal(r[0].optionOwnedCandidate, true)
  assert.equal(r[0].owner, undefined)
})

test('two drawings for one question: neither is attached', () => {
  const r = rowsFor(7)
  assert.equal(r.length, 2)
  assert.ok(r.every(x => x.status === 'REJECTED' && x.reasons.includes('MULTIPLE_VISUALS_FOR_QUESTION')))
})

test('a drawing crossing into another question is rejected', () => {
  const r = rows.filter(x => x.reasons.includes('CROSSES_QUESTION_BOUNDARY'))
  assert.equal(r.length, 1)
  assert.deepEqual(r[0].candidateOwners.sort(), [8, 9])
  assert.equal(accepted.some(a => a.questionNumber === 8 || a.questionNumber === 9), false)
})

test('short Latin labels inside a drawing are absorbed, not treated as text', () => {
  const r = rowsFor(10)
  assert.equal(r.length, 1)
  assert.equal(r[0].status, 'ACCEPTED')
  assert.deepEqual(r[0].absorbedLabels, ['6'])
})

test('a thin rule is noise and its gap stays whitespace', () => {
  assert.ok(rows.some(r => r.noise && r.reasons.includes('RULE_OR_BAR') && r.page === 2))
  assert.deepEqual(rowsFor(11).map(r => r.reasons), [['WHITESPACE_NO_INK']])
})

test('decoration (frame, column rule, repeated logo) is rejected and never attached', () => {
  assert.ok(detection.decorationRejected.length >= 6, 'decoration components recorded')
  for (const r of rows) {
    const overlapsLogo = r.inkBoxPt.x0 < LOGO.x1 && r.inkBoxPt.x1 > LOGO.x0 && r.inkBoxPt.y0 < LOGO.y1 && r.inkBoxPt.y1 > LOGO.y0
    assert.ok(!overlapsLogo, `${r.id} came from the repeated logo`)
  }
  assert.equal(summarise(model, detection).decorationAttached, 0)
})

test('exactly the expected questions are attached — no others', () => {
  assert.deepEqual(accepted.map(r => r.questionNumber).sort((a, b) => a - b), [2, 10, 20])
  assert.ok(accepted.every(r => r.owner.kind === 'QUESTION' && r.mediaKind !== 'TEXT_REGION'))
})

test('decoration mask resamples a page rendered at a different pixel size', () => {
  const a = { gray: new Uint8Array(100).fill(255), width: 10, height: 10 }
  const b = { gray: new Uint8Array(100).fill(255), width: 10, height: 10 }
  const odd = { gray: new Uint8Array(121).fill(255), width: 11, height: 11 }
  a.gray[55] = 0; b.gray[55] = 0; odd.gray[5 * 11 + 5] = 0
  const d = buildDecorationMask([odd, a, b])
  assert.equal(d.width, 10, 'reference is the common size, not the first page')
  assert.equal(decorationFor(d, odd)[5 * 11 + 5], 1)
})

test('normalized region uses the top-left origin contract', () => {
  assert.deepEqual(toNormalizedRegion({ x0: 0, y0: H - 100, x1: W / 2, y1: H }, W, H), { x: 0, y: 0, w: 0.5, h: 0.1188 })
})

// ---------- golden paper (opt-in, needs the local PDF) -----------------------------------
const GOLDEN = 'C:/Users/AARYA RUSHI/Downloads/PDF files/SI-CONSTABLE TEST-10(27.03.2026)28 PAGES.pdf'
const HAVE_GOLDEN = fs.existsSync(GOLDEN)

test('golden paper: Q6 gets exactly one triangle crop on page 2, owned by Q6, and nothing wrong is attached', { skip: !HAVE_GOLDEN && 'golden PDF not present', timeout: 300000 }, async () => {
  const { openPdf, buildPageModels, renderPage } = await import('./lib/pdf-page-model.mjs')
  const opened = await openPdf(GOLDEN)
  const { pages } = await buildPageModels(GOLDEN, null, opened)
  const gm = analysePaper(pages)
  const rs = new Map()
  for (const p of pages) { const r = await renderPage(opened.pdf, p.page, 2); rs.set(p.page, { gray: r.gray, width: r.width, height: r.height, scale: 2 }) }
  const det = detectVisuals(pages, gm, rs)
  const all = det.rows.filter(r => r.status === 'ACCEPTED')
  const acc = all.filter(r => r.owner?.kind === 'QUESTION')
  const q6 = acc.filter(r => r.questionNumber === 6)
  assert.equal(q6.length, 1)
  assert.equal(q6[0].page, 2)
  assert.deepEqual(q6[0].owner, { kind: 'QUESTION', questionNumber: 6 })
  assert.ok(q6[0].confidence >= 0.85)
  // The triangle sits between Q6's Telugu stem line and its A) option line: the crop must
  // stay below the stem glyphs and above the option glyphs.
  const p2 = pages.find(p => p.page === 2)
  const optionA = p2.items.find(it => /^A\)/.test(it.str.trim()) && it.x > 306 && it.y > 500 && it.y < 540)
  assert.ok(optionA, 'Q6 A) option located')
  assert.ok(q6[0].cropPt.y0 >= optionA.y + optionA.height, `crop ${JSON.stringify(q6[0].cropPt)} reaches option text at ${optionA.y}`)
  assert.ok(q6[0].cropPt.y1 <= 574.1, 'crop stays below the Telugu stem baseline')
  assert.ok(q6[0].cropPt.x0 > 306 && q6[0].cropPt.x1 < 575, 'inside the right column, clear of rule and frame')
  // No crop overlaps any Telugu region, option line or other question; one per question.
  const perQ = new Map()
  for (const r of acc) perQ.set(r.questionNumber, (perQ.get(r.questionNumber) || 0) + 1)
  assert.ok([...perQ.values()].every(n => n === 1))
  for (const r of acc) {
    const q = gm.questions.find(x => x.number === r.questionNumber)
    for (const t of q.teluguRegions.filter(t => t.page === r.page)) {
      const ov = Math.max(0, Math.min(t.x + t.w, r.cropPt.x1) - Math.max(t.x, r.cropPt.x0)) * Math.max(0, Math.min(t.y + t.h, r.cropPt.y1) - Math.max(t.y, r.cropPt.y0))
      assert.equal(ov, 0, `Q${r.questionNumber} crop overlaps its Telugu region`)
    }
  }
  assert.equal(gm.questions.find(q => q.number === 6).options.length, 4)
  assert.equal(gm.questions.find(q => q.number === 6).proposedAnswer.letter, 'D')
  // Figures inside shared Directions blocks belong to the material, never to a question, and
  // their crops never overlap any question's text area.
  const mats = all.filter(r => r.owner?.kind === 'MATERIAL')
  assert.deepEqual([...new Set(mats.map(r => r.owner.materialIndex))].sort((a, b) => a - b), [1, 8, 9], 'Venn (Q11-12), pie+table (Q36-39), pie charts (Q71-74)')
  // Per-column question zones (B4.1's per-page bbox merges a question's two columns).
  const { buildQuestionZones } = await import('./lib/visual-detection.mjs')
  const zones = buildQuestionZones(pages, gm).zones
  for (const r of mats) {
    for (const z of zones.filter(z => z.page === r.page)) {
      const ov = Math.max(0, Math.min(z.x1, r.cropPt.x1) - Math.max(z.x0, r.cropPt.x0)) * Math.max(0, Math.min(z.y1, r.cropPt.y1) - Math.max(z.y0, r.cropPt.y0))
      assert.equal(ov, 0, `material crop ${r.id} overlaps Q${z.number}`)
    }
  }
  // The question-visual policy is unchanged: figures touching question text stay rejected.
  for (const n of [9, 17]) assert.ok(det.rows.some(r => r.questionNumber === n && r.status === 'REJECTED'), `Q${n} still routed to review`)
})
