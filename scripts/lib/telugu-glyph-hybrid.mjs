// B4.5R — production Integer + Glyph hybrid for legacy-Telugu PDFs (promoted from the B4.4R-H
// experiment in scripts/ocr-bench/run-models.mjs; the algorithm and bounds are unchanged).
//
// Telugu LETTERS always come from OCR (the integer tessdata model). The PDF glyph layer supplies
// only the classes proven one-to-one in the glyph atlases (reports/ocr-bench/glyph-atlas-*.png):
// digits, basic punctuation, the abbreviation mark ॥ (two F0F6 bars, 318/318 paired), single and
// doubled quotes, and spacing. Every other glyph is a letter component and is NEVER decoded.
//
// A run's glyph data is applied only when its letter segments match the OCR letter segments
// one-to-one with a plausible length ratio. Anything else keeps the OCR text unchanged; a refused
// run that carried deterministic glyphs flags its unit GLYPH_ALIGNMENT_AMBIGUOUS (HIGH -> MEDIUM),
// so it goes to teacher review. Pure: no I/O.

export const GLYPH_HYBRID = 'ksc-glyph-hybrid'
export const GLYPH_HYBRID_VERSION = '1.0.0'
export const GLYPH_ALIGNMENT_AMBIGUOUS = 'GLYPH_ALIGNMENT_AMBIGUOUS'

const SP = String.fromCharCode(0xF020)
const G = h => String.fromCharCode(0xF000 + h)
const PUA = new RegExp('[' + String.fromCharCode(0xE000) + '-' + String.fromCharCode(0xF8FF) + ']')
export const DETERMINISTIC_PAIRS = new Map([[G(0xF6) + G(0xF6), '॥'], [G(0xBB) + G(0xBB), '“'], [G(0xB5) + G(0xB5), '”']])
export const DETERMINISTIC = new Map([...'0123456789'].map((d, i) => [G(0x30 + i), d]).concat(
  [[0x2C, ','], [0x2E, '.'], [0x3F, '?'], [0x3A, ':'], [0x25, '%'], [0x28, '('], [0x29, ')'], [0x2F, '/'], [0x60, '-'], [0x2D, '-'], [0xBB, '‘'], [0xB5, '’']].map(([h, c]) => [G(h), c])))
// B4.8.2 — script-neutral NUMBERS drawn in the legacy Telugu font ("A) 1921" printed with the Telugu
// font's digits). Only digits and a few number punctuation marks, a strict subset of DETERMINISTIC, are
// accepted; any letter component, bracket, quote or ॥ refuses the whole run (returns null). The leading
// ")" printed after a Latin option marker is structure, not content, and is dropped. Never used for
// fractions, powers or any stacked layout (callers must prove the run sits alone on its line).
export const NEUTRAL_NUMERIC = new Map([...'0123456789'].map((d, i) => [G(0x30 + i), d]).concat(
  [[0x2C, ','], [0x2E, '.'], [0x2F, '/'], [0x3A, ':'], [0x25, '%'], [0x2D, '-']].map(([h, c]) => [G(h), c])))
export function decodeNeutralNumeric(stream, { dropLeadingParen = true } = {}) {
  let s = String(stream ?? '')
  if (dropLeadingParen) s = s.replace(new RegExp(`^[\\s${SP}]*${G(0x29)}`), '')
  let out = ''
  for (const ch of s) {
    if (ch === SP || /\s/.test(ch)) { out += ' '; continue }
    const d = NEUTRAL_NUMERIC.get(ch)
    if (d === undefined) return null
    out += d
  }
  out = out.replace(/\s+/g, ' ').trim()
  return /\d/.test(out) && !/^[,./:%-]|[,./:-]$/.test(out) ? out : null
}

// Plausible OCR-characters per letter-glyph ratio for one aligned segment (outside -> refused).
export const RATIO = Object.freeze({ min: 0.3, max: 3.0 })
const TE_LETTER = /[ఀ-ౣ‌‍]/

// Glyph stream -> tokens: { t: 'L', n: glyphCount } letter segment | { t: 'D', s } deterministic | { t: ' ' }.
export function glyphTokens(stream) {
  const out = []
  const cs = [...stream]
  for (let i = 0; i < cs.length; i++) {
    const pair = cs[i] + (cs[i + 1] || '')
    const last = out[out.length - 1]
    if (cs[i] === SP) { if (last && last.t !== ' ') out.push({ t: ' ' }); continue }
    if (DETERMINISTIC_PAIRS.has(pair)) { out.push({ t: 'D', s: DETERMINISTIC_PAIRS.get(pair) }); i++; continue }
    if (DETERMINISTIC.has(cs[i])) { out.push({ t: 'D', s: DETERMINISTIC.get(cs[i]) }); continue }
    if (last?.t === 'L') last.n++
    else out.push({ t: 'L', n: 1 })
  }
  while (out.length && out[out.length - 1].t === ' ') out.pop()
  return out
}

// OCR text -> Telugu-letter segments (everything else is gap text, used only as evidence).
export function ocrSegments(text) {
  const segs = [], gaps = ['']
  for (const ch of String(text || '').normalize('NFC')) {
    if (TE_LETTER.test(ch)) { if (segs.length === gaps.length - 1) segs.push(''); segs[segs.length - 1] += ch }
    else { if (segs.length === gaps.length) gaps.push(''); gaps[gaps.length - 1] += ch }
  }
  return { segs, gaps }
}

// Align one run. ALIGNED only if both sides have the same number of letter segments and every
// segment pair has a plausible length ratio; then letters come from OCR (in order) and digits,
// punctuation, marks and spacing from the glyph layer. Otherwise the OCR is kept unchanged.
export function hybridRun(stream, ocrText) {
  const toks = glyphTokens(stream)
  const hasDeterministic = toks.some(t => t.t === 'D')
  const letters = toks.filter(t => t.t === 'L')
  const { segs, gaps } = ocrSegments(ocrText)
  if (!toks.length) return { status: 'NO_GLYPHS', hasDeterministic }
  if (letters.length !== segs.length) return { status: 'SEGMENT_COUNT_MISMATCH', hasDeterministic }
  const ratios = letters.map((l, i) => [...segs[i]].length / l.n)
  if (ratios.some(r => r < RATIO.min || r > RATIO.max)) return { status: 'IMPLAUSIBLE_SEGMENT', hasDeterministic }
  let text = '', k = 0, det = ''
  const pairs = []
  for (const t of toks) {
    if (t.t === 'L') { pairs.push([det, gaps[k] || '']); det = ''; text += segs[k++] }
    else { const s = t.t === 'D' ? t.s : ' '; text += s; det += s }
  }
  pairs.push([det, gaps[k] || ''])
  return { status: 'ALIGNED', hasDeterministic, text, ratios, gaps: pairs }
}

// A Telugu run's glyph stream: text-layer items overlapping the run rect on its line, in reading
// order, with a space where items are separated by a visible gap. The stream stays in memory as
// alignment evidence only; it is never stored as text.
export function runGlyphStream(pageItems, run) {
  const r = run.rect
  const its = pageItems
    .filter(i => PUA.test(i.str) && i.x < r.x1 && i.x + (i.width || 0) > r.x0 + 0.5 && i.y >= r.y0 && i.y <= r.y1)
    .sort((a, b) => b.y - a.y || a.x - b.x)
  let s = ''
  its.forEach((it, k) => {
    const prev = its[k - 1]
    if (prev && (Math.abs(prev.y - it.y) > 2 || it.x - (prev.x + (prev.width || 0)) > 0.2 * (it.height || 10))) s += SP
    s += it.str
  })
  if (run.skipLeadingParen) s = s.replace(new RegExp(`^[${SP}${String.fromCharCode(0xF029)}]+`), '')
  return s
}

// Apply the hybrid to every OCR'd run. runResults: Map(run -> { text, confidence, skipped? }).
// Returns { results: Map(run -> result with hybrid text when ALIGNED), status: Map(run -> hybridRun result) }.
// Skipped (marker-only) runs pass through without a status.
export function applyGlyphHybrid(runResults, pages) {
  const itemsByPage = new Map(pages.map(p => [p.page, p.items]))
  const results = new Map(), status = new Map()
  for (const [run, res] of runResults) {
    if (res.skipped) { results.set(run, res); continue }
    const h = hybridRun(runGlyphStream(itemsByPage.get(run.rect.page) || [], run), res.text)
    status.set(run, h)
    results.set(run, h.status === 'ALIGNED' ? { ...res, text: h.text, ocrText: res.text } : res)
  }
  return { results, status }
}

// Unit-level refusal rule (B4.4R-H): a unit with any Telugu run whose glyph layer carried
// deterministic tokens that could not be aligned is flagged, and HIGH drops to MEDIUM.
export function unitHybridOutcome(unit, status) {
  const teRuns = unit.lineRuns.flatMap(l => l.runs.filter(r => r.type === 'TE'))
  const st = teRuns.map(r => status.get(r)).filter(Boolean)
  const ambiguous = st.some(s => s.status !== 'ALIGNED' && s.hasDeterministic)
  return { runs: st.map(s => s.status), aligned: st.filter(s => s.status === 'ALIGNED').length, ambiguous }
}

// Assemble one unit from hybrid run results with the production rules (assembleUnit from
// telugu-ocr.mjs) plus the refusal rule above. Also returns the pure-OCR assembly of the same
// unit (ocrRawText) so the stored provenance shows exactly what the glyph layer changed.
export function assembleHybridUnit(assembleUnit, unit, { results, status, rawResults }, opts = {}) {
  const b = assembleUnit(unit, results, opts)
  const raw = assembleUnit(unit, rawResults, opts)
  const h = unitHybridOutcome(unit, status)
  const flags = [...b.flags]
  let verdict = b.verdict
  if (h.ambiguous) { flags.push(GLYPH_ALIGNMENT_AMBIGUOUS); if (verdict === 'HIGH') verdict = 'MEDIUM' }
  return { ...b, flags, verdict, ocrRawText: raw.text,
    hybrid: { name: GLYPH_HYBRID, version: GLYPH_HYBRID_VERSION, runs: h.runs, alignedRuns: h.aligned, ambiguous: h.ambiguous, changed: raw.text !== b.text } }
}
