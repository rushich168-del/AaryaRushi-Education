// EXPERIMENT — time-boxed glyph-map feasibility on the golden paper.
//
// The legacy fonts encode Telugu as VISUAL COMPONENTS (bases without talakattu, talakattu
// variants, vowel-sign pieces, vattus, pre-base ra-vattu, shared hooks), so a glyph map is a
// cluster grammar, not a character table. This test measures, without building that grammar:
//   1. glyph classes that ARE 1:1 (digits, punctuation, the abbreviation mark) and how many
//      benchmark OCR errors fall in them (what a glyph layer would fix deterministically);
//   2. word-level determinism: learn glyph-word -> Unicode-word pairs from NON-benchmark units
//      where both OCR models agree exactly and neither flags digits; count conflicts;
//   3. coverage: share of benchmark Telugu words whose glyph word was seen in training, and the
//      CER of a lookup-only converter on the words it covers (upper bound for "learn from OCR").
// Writes reports/ocr-bench/glyphmap-feasibility.json. No production code or data is changed.
import fs from 'fs'
import { align } from './score.mjs'

const { units } = JSON.parse(fs.readFileSync('reports/ocr-bench/units.json', 'utf8'))
const truth = JSON.parse(fs.readFileSync('scripts/fixtures/telugu-ocr-benchmark-truth.json', 'utf8')).units
const benchIds = new Set(truth.map(t => t.id))
const hx = c => (c.codePointAt(0) - 0xF000).toString(16).padStart(2, '0')
const SPACE = String.fromCharCode(0xF020)
// 1:1 classes read directly from the atlas (reports/ocr-bench/glyph-atlas-*.png).
const ONE_TO_ONE = { '30': '0', '31': '1', '32': '2', '33': '3', '34': '4', '35': '5', '36': '6', '37': '7', '38': '8', '39': '9',
  '2c': ',', '2e': '.', '3f': '?', '3a': ':', '25': '%', '28': '(', '29': ')', '60': '-', '2d': '-', '2f': '/', 'bb': '‘', 'b5': '’', 'f6': '।' }

// Telugu runs only (script-neutral text-layer runs are not part of the glyph question).
const glyphWords = u => u.glyphs.flat().filter(r => r.te).map(r => r.te).join(SPACE).split(SPACE).filter(Boolean)
const teluguWords = s => String(s || '').normalize('NFC').replace(/[‌‍]/g, '').split(/\s+/).filter(w => /[ఀ-౿]/.test(w))
const isTeluguGlyphWord = w => [...w].some(c => !(hx(c) in ONE_TO_ONE))
// Word pairs: only when the Telugu-letter words of glyph and text line up one-to-one.
function pairs(u, text) {
  const g = glyphWords(u).filter(isTeluguGlyphWord), t = teluguWords(text)
  if (u.kind === 'OPTION' && g.length && [...g[0]].every(c => hx(c) === '29')) g.shift()
  return g.length === t.length ? g.map((w, i) => [w, t[i]]) : null
}

// 2. training dictionary from non-benchmark units where both models agree and digits are not flagged.
const dict = new Map()
let trainUnits = 0, trainUnaligned = 0
for (const u of units) {
  if (benchIds.has(u.id) || u.kind === 'BLOCK') continue
  const f = u.models.fast, i = u.models.int
  if (!f.text || f.text !== i.text || f.digitCheck === 'MISMATCH' || ['EMPTY', 'NOT_TELUGU'].includes(f.verdict)) continue
  const p = pairs(u, f.text)
  if (!p) { trainUnaligned++; continue }
  trainUnits++
  for (const [g, t] of p) {
    if (!dict.has(g)) dict.set(g, new Map())
    dict.get(g).set(t, (dict.get(g).get(t) || 0) + 1)
  }
}
const conflicts = [...dict].filter(([, m]) => m.size > 1).map(([g, m]) => ({ glyphs: [...g].map(hx).join('.'), readings: Object.fromEntries(m) }))

// 3. coverage and lookup accuracy on benchmark Telugu words (reference words from the truth file).
let words = 0, covered = 0, errs = 0, chars = 0, benchUnaligned = 0
const misses = []
for (const t of truth) {
  const u = units.find(x => x.id === t.id)
  const p = pairs(u, t.text)
  if (!p) { benchUnaligned++; continue }
  for (const [g, ref] of p) {
    words++
    const m = dict.get(g)
    if (!m) { misses.push(ref); continue }
    covered++
    const best = [...m].sort((a, b) => b[1] - a[1])[0][0]
    const a = align(best, ref)
    errs += a.errors; chars += a.length
  }
}

// 1. glyph inventory classes and deterministic-class share of benchmark OCR errors.
const inv = new Map()
for (const u of units) for (const w of glyphWords(u)) for (const c of w) inv.set(hx(c), (inv.get(hx(c)) || 0) + 1)
const tokens = [...inv.values()].reduce((a, b) => a + b, 0)
const oneToOneTokens = [...inv].filter(([k]) => k in ONE_TO_ONE).reduce((n, [, v]) => n + v, 0)
const scores = JSON.parse(fs.readFileSync('reports/ocr-bench/scores.json', 'utf8'))
const deterministicShare = Object.fromEntries(Object.entries(scores.systems).map(([m, s]) => {
  const c = s.errorCharClasses
  const det = (c.DIGIT || 0) + (c.TELUGU_DIGIT || 0) + (c.PUNCT_SYMBOL || 0)
  return [m, { charErrors: s.charErrors, inDigitPunctSymbolClasses: det, unitsWithNumberError: s.unitsWithNumberError, abbreviationMarkUnits: s.failureUnits.ABBREVIATION_MARK || 0 }]
}))

const out = {
  inventory: { distinctGlyphs: inv.size, glyphTokens: tokens, oneToOneGlyphs: Object.keys(ONE_TO_ONE).length, oneToOneTokenShare: +(oneToOneTokens / tokens).toFixed(3) },
  deterministicClasses: deterministicShare,
  wordDeterminism: { trainingUnits: trainUnits, trainingUnitsSkippedUnaligned: trainUnaligned, distinctGlyphWords: dict.size,
    glyphWordsWithConflictingReadings: conflicts.length, conflicts: conflicts.slice(0, 25) },
  benchmarkCoverage: { teluguWords: words, coveredBySeenGlyphWords: covered, share: +(covered / words).toFixed(3), lookupCerOnCovered: chars ? +(errs / chars).toFixed(4) : null,
    unitsUnaligned: benchUnaligned, sampleMisses: misses.slice(0, 30) },
}
fs.writeFileSync('reports/ocr-bench/glyphmap-feasibility.json', JSON.stringify(out, null, 1))
console.log(JSON.stringify({ inventory: out.inventory, deterministicClasses: out.deterministicClasses,
  words: { trainUnits, dict: dict.size, conflicts: conflicts.length }, coverage: { ...out.benchmarkCoverage, sampleMisses: undefined } }, null, 1))
