import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import {
  glyphTokens, hybridRun, runGlyphStream, applyGlyphHybrid, assembleHybridUnit, GLYPH_HYBRID, GLYPH_HYBRID_VERSION, GLYPH_ALIGNMENT_AMBIGUOUS,
} from './lib/telugu-glyph-hybrid.mjs'
import { assembleUnit, characterErrorRate, MODEL_SHA256 } from './lib/telugu-ocr.mjs'

// B4.5R — production Integer + Glyph hybrid (pure). Synthetic legacy streams, plus opt-in golden
// checks over reports/b44 (the production CLI output) and the 68-unit reference benchmark.

const G = h => String.fromCharCode(0xF000 + h)
const SP = G(0x20)
const PUA = /[-�]/
// Letter glyphs are arbitrary non-deterministic PUA codes (never decoded).
const L = n => Array.from({ length: n }, (_, i) => G(0x41 + i)).join('')

test('glyph tokens: digits, punctuation, ॥ pairs and spacing are deterministic; everything else is a letter segment', () => {
  const toks = glyphTokens(L(3) + SP + G(0x33) + G(0x30) + G(0x2C) + SP + G(0xF6) + G(0xF6) + SP + SP)
  assert.deepEqual(toks, [{ t: 'L', n: 3 }, { t: ' ' }, { t: 'D', s: '3' }, { t: 'D', s: '0' }, { t: 'D', s: ',' }, { t: ' ' }, { t: 'D', s: '॥' }])
  assert.deepEqual(glyphTokens(G(0xF6)), [{ t: 'L', n: 1 }], 'a single F6 bar is not ॥ (only the proven pair is)')
})

test('ALIGNED run: letters from OCR, digits/punctuation/marks from the glyph layer (the "30" -> "80" fix)', () => {
  const stream = L(4) + SP + G(0x33) + G(0x30) + SP + L(3) + G(0x3F)
  const h = hybridRun(stream, 'రూపాయ 80 ఎంత!')
  assert.equal(h.status, 'ALIGNED')
  assert.equal(h.text, 'రూపాయ 30 ఎంత?')
  assert.ok(!PUA.test(h.text), 'no legacy glyph ever reaches the output')
})

test('refusals keep OCR unchanged: segment-count mismatch, implausible length, no glyphs', () => {
  assert.equal(hybridRun(L(4) + SP + L(3) + G(0x31), 'రూపాయ1').status, 'SEGMENT_COUNT_MISMATCH')
  assert.equal(hybridRun(L(10) + G(0x31), 'ర1').status, 'IMPLAUSIBLE_SEGMENT', 'ratio 0.1 < 0.3')
  assert.equal(hybridRun('', 'రూపాయ').status, 'NO_GLYPHS')
  // The glyph layer never supplies a letter, even when OCR lost one entirely.
  const h = hybridRun(L(2) + SP + L(2), 'అబ')
  assert.equal(h.status, 'SEGMENT_COUNT_MISMATCH')
  assert.equal(h.text, undefined)
})

test('run glyph stream: only PUA items overlapping the run rect, reading order, gaps become spaces; leading ")" of a bare marker dropped', () => {
  const items = [
    { str: L(2), x: 10, y: 100, width: 10, height: 10 },
    { str: G(0x31), x: 25, y: 100, width: 4, height: 10 },     // gap 5 > 0.2*10 -> space
    { str: 'Latin', x: 30, y: 100, width: 20, height: 10 },      // not PUA: ignored
    { str: L(1), x: 200, y: 100, width: 5, height: 10 },        // outside the rect
  ]
  assert.equal(runGlyphStream(items, { rect: { x0: 5, x1: 60, y0: 95, y1: 105 } }), L(2) + SP + G(0x31))
  const marker = [{ str: G(0x29) + SP + L(2), x: 10, y: 100, width: 10, height: 10 }]
  assert.equal(runGlyphStream(marker, { rect: { x0: 5, x1: 60, y0: 95, y1: 105 }, skipLeadingParen: true }), L(2))
})

test('unit assembly: a refused run that carried deterministic glyphs flags the unit and caps HIGH at MEDIUM; raw OCR kept', () => {
  const r1 = { type: 'TE', rect: { page: 1, x0: 0, x1: 50, y0: 95, y1: 105 } }
  const r2 = { type: 'TE', rect: { page: 1, x0: 60, x1: 110, y0: 95, y1: 105 } }
  const unit = { kind: 'STEM', lineRuns: [{ runs: [r1, r2] }] }
  const pages = [{ page: 1, items: [
    { str: L(4) + SP + G(0x33), x: 1, y: 100, width: 40, height: 10 },            // aligns
    { str: L(2) + SP + L(2) + G(0x35), x: 61, y: 100, width: 40, height: 10 },    // 2 letter segments vs 1 in OCR -> refused
  ] }]
  const raw = new Map([[r1, { text: 'రూపాయ 8', confidence: 95 }], [r2, { text: 'అబక', confidence: 95 }]])
  const hy = applyGlyphHybrid(raw, pages)
  assert.deepEqual([...hy.status.values()].map(s => s.status), ['ALIGNED', 'SEGMENT_COUNT_MISMATCH'])
  const u = assembleHybridUnit(assembleUnit, unit, { ...hy, rawResults: raw })
  assert.equal(u.text, 'రూపాయ 3 అబక')
  assert.equal(u.ocrRawText, 'రూపాయ 8 అబక')
  assert.equal(u.verdict, 'MEDIUM')
  assert.ok(u.flags.includes(GLYPH_ALIGNMENT_AMBIGUOUS))
  assert.deepEqual(u.hybrid, { name: GLYPH_HYBRID, version: GLYPH_HYBRID_VERSION, runs: ['ALIGNED', 'SEGMENT_COUNT_MISMATCH'], alignedRuns: 1, ambiguous: true, changed: true })
  // Without deterministic glyphs in the refused run, nothing is lost by refusing: no flag.
  pages[0].items[1].str = L(2) + SP + L(2)
  const clean = assembleHybridUnit(assembleUnit, unit, { ...applyGlyphHybrid(raw, pages), rawResults: raw })
  assert.equal(clean.verdict, 'HIGH')
  assert.ok(!clean.flags.includes(GLYPH_ALIGNMENT_AMBIGUOUS))
})

test('the integer model is registered with its pinned checksum', () => {
  assert.equal(MODEL_SHA256.int, '7d092812889dc8bb1f42d93b8d98f6985278009e31ced30ff434ee0e3b44983d')
})

// ---------- golden (opt-in: needs reports/b44 from `node scripts/b44-ocr-benchmark.mjs <paper>`) ----------
const BENCH = 'reports/b44/b44-benchmark.json'
const TRUTH = 'scripts/fixtures/telugu-ocr-benchmark-truth.json'
const skip = !fs.existsSync(BENCH) ? 'run scripts/b44-ocr-benchmark.mjs first' : false
test('golden: production B4.4 is integer + glyph, with full provenance and no legacy glyph anywhere', { skip }, () => {
  const b = JSON.parse(fs.readFileSync(BENCH, 'utf8'))
  assert.equal(b.meta.modelKey, 'int')
  assert.equal(b.meta.modelSha256, MODEL_SHA256.int)
  assert.deepEqual([b.meta.hybrid.name, b.meta.hybrid.version], [GLYPH_HYBRID, GLYPH_HYBRID_VERSION])
  assert.match(b.meta.ocrVersion, /tessdata\/tel\.traineddata \(integer\)@7d092812889d\+ksc-glyph-hybrid@1\.0\.0$/)
  const units = b.questions.flatMap(q => q.units)
  assert.ok(units.every(u => u.hybrid && typeof u.ocrRawText === 'string'))
  assert.ok(units.every(u => !PUA.test(u.text) && !PUA.test(u.ocrRawText)))
  assert.ok(units.filter(u => u.hybrid.ambiguous).every(u => u.flags.includes(GLYPH_ALIGNMENT_AMBIGUOUS) && u.verdict !== 'HIGH'))
})

test('golden: 68-unit reference benchmark (assistant-transcribed, NOT Telugu-reader verified) — report, do not claim', { skip: skip || (!fs.existsSync(TRUTH) && 'no benchmark truth') }, () => {
  const b = JSON.parse(fs.readFileSync(BENCH, 'utf8'))
  const truth = JSON.parse(fs.readFileSync(TRUTH, 'utf8'))
  assert.match(truth.provenance, /NOT yet verified/, 'if a Telugu reader verifies the reference, update the provenance and this test')
  const byId = new Map(b.questions.flatMap(q => q.units.map(u => [`${q.number}${u.kind === 'STEM' ? 'S' : u.kind === 'OPTION' ? 'O' + u.marker : 'B'}`, u])))
  // B4.8.2: numbers printed in the legacy font (118-D "2000", 125-B "1922") are script-neutral now — no OCR
  // unit; the Draft shows the option's own digits. Score them by that value, never as empty.
  const neutral = new Map(b.questions.filter(q => q.structure === 'STEM_WITH_NEUTRAL_OPTIONS').flatMap(q => q.englishOptions.map(s => [`${q.number}O${s[0]}`, s.slice(3)])))
  let e = 0, l = 0, exact = 0
  for (const t of truth.units) { const r = characterErrorRate(byId.get(t.id)?.text ?? neutral.get(t.id) ?? '', t.text); e += r.errors; l += r.length; if (!r.errors) exact++ }
  // Regression pins for the B4.4R-H result (fast baseline: 37 exact, CER 4.56%).
  assert.ok(exact >= 53, `exact ${exact}`)
  assert.ok(e / l <= 0.0166 + 1e-9, `CER ${(e / l * 100).toFixed(2)}%`)
})
