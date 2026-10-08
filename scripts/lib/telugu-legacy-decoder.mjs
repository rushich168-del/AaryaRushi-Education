// B4.8.4B — legacy-Telugu glyph decoder: a SECOND, independent reading beside the OCR (never a
// replacement). Pure and platform-neutral (Node tools and the in-browser preparation pipeline).
//
// It reads the PDF's private-use glyph codes through the versioned asset
// (./telugu-legacy-decoder-asset.mjs) and runs ONLY when every glyph of a run is drawn by a font whose
// [code point, advance width] pairs all belong to one supported face (regular or bold) of the one legacy
// encoding the asset was built for. Anything else refuses, with a reason:
//   UNSUPPORTED_FONT     a glyph comes from a font that is not proven to be the supported one;
//   UNKNOWN_GLYPH_CODE   a code the supported face does not define;
//   UNKNOWN_CLUSTER      a letter cluster the asset cannot segment completely;
//   AMBIGUOUS            two segmentations are too close to choose (ratio < params.ambiguityRatio);
//   INVALID_SEQUENCE     the result is not a valid Telugu sequence;
//   PARTIAL_LEGACY       only part of a unit has legacy glyphs (the rest could not be compared).
// NOT_APPLICABLE: no legacy glyphs at all (a Unicode-Telugu text layer, a scanned page, no text layer):
// the decoder stays out of the way and the OCR path is unchanged.
//
// The glyph stream exists only in memory (never stored). Decoder text is Unicode Telugu; it becomes a
// suggestion or an agreement signal, never content on its own (see withDecoderReading).

import { LEGACY_TELUGU_DECODER_ASSET as ASSET } from './telugu-legacy-decoder-asset.mjs'
import { runGlyphStream, DETERMINISTIC, DETERMINISTIC_PAIRS } from './telugu-glyph-hybrid.mjs'
import { assembleUnit } from './telugu-ocr-core.mjs'

export const LEGACY_DECODER = ASSET.name
export const LEGACY_DECODER_VERSION = ASSET.version
export const OCR_DECODER_AGREE = 'OCR_DECODER_AGREE'
export const OCR_DECODER_DISAGREE = 'OCR_DECODER_DISAGREE'

const SP = String.fromCharCode(0xF020)
const PUA = /[-]/
const PUA_ALL = /[-]/g

// ---- font gate --------------------------------------------------------------------------------------
const VARIANTS = ASSET.fontVariants.map(v => ({ id: v.id, pdfName: v.pdfName, program: v.program, widths: new Map(v.glyphs) }))

// fontInfo: { name, glyphs: [[codePoint, width]], program } (pdf-page-model-core legacyFontInfo).
// Supported only if the font defines enough codes and EVERY one of them has exactly the width the
// supported face gives it (a subset of the same face passes; any other font fails).
export function matchLegacyFont(fontInfo) {
  const glyphs = fontInfo?.glyphs || []
  if (!glyphs.length) return { supported: false, reason: 'NO_FONT_METRICS' }
  if (glyphs.length < ASSET.params.minFontCodes) return { supported: false, reason: 'TOO_FEW_GLYPHS' }
  for (const v of VARIANTS) {
    if (glyphs.every(([c, w]) => v.widths.get(c) === w)) return { supported: true, variant: v.id, codes: new Set(glyphs.map(g => g[0])), pdfName: fontInfo.name ?? null, program: fontInfo.program ?? null }
  }
  return { supported: false, reason: 'FONT_NOT_RECOGNISED' }
}

// fonts: { fontName -> fontInfo } from buildPageModelsFromPdf. Returns Map(fontName -> matchLegacyFont).
export function identifyLegacyFonts(fonts) {
  return new Map(Object.entries(fonts || {}).map(([n, f]) => [n, matchLegacyFont(f)]))
}

// ---- segment decoding --------------------------------------------------------------------------------
const ENTRIES = new Map(ASSET.entries.map(([block, akshara, count]) => [block, { akshara, count }]))
const TOTAL = ASSET.entries.reduce((s, e) => s + e[2], 0)
const MARGIN = Math.log(ASSET.params.ambiguityRatio)
const hex = codes => codes.map(c => c.toString(16).slice(-2)).join('.')

// Glyph stream -> tokens: { t:'L', codes } letter cluster | { t:'D', s } digit/punctuation | { t:' ' }.
export function glyphTokensWithCodes(stream) {
  const out = [], cs = [...stream]
  for (let i = 0; i < cs.length; i++) {
    const pair = cs[i] + (cs[i + 1] || ''), last = out[out.length - 1]
    if (cs[i] === SP || /\s/.test(cs[i])) { if (last && last.t !== ' ') out.push({ t: ' ' }); continue }
    if (DETERMINISTIC_PAIRS.has(pair)) { out.push({ t: 'D', s: DETERMINISTIC_PAIRS.get(pair) }); i++; continue }
    if (DETERMINISTIC.has(cs[i])) { out.push({ t: 'D', s: DETERMINISTIC.get(cs[i]) }); continue }
    const code = cs[i].codePointAt(0)
    if (last?.t === 'L') last.codes.push(code); else out.push({ t: 'L', codes: [code] })
  }
  while (out.length && out[out.length - 1].t === ' ') out.pop()
  return out
}

// Beam over cluster boundaries; score = sum of log relative frequency. Refuses rather than guesses.
export function decodeCluster(codes) {
  const { maxClusterCodes: K, beam: B } = ASSET.params
  const beams = Array.from({ length: codes.length + 1 }, () => new Map())
  beams[0].set('', 0)
  for (let i = 0; i < codes.length; i++) {
    for (const [str, sc] of beams[i]) for (let L = 1; L <= K && i + L <= codes.length; L++) {
      const e = ENTRIES.get(hex(codes.slice(i, i + L))); if (!e) continue
      const s2 = str + e.akshara, v = sc + Math.log(e.count / TOTAL)
      const b = beams[i + L]; if (!b.has(s2) || b.get(s2) < v) b.set(s2, v)
    }
    for (const b of beams.slice(i + 1, i + 1 + K)) if (b.size > B) { const keep = [...b].sort((x, y) => y[1] - x[1]).slice(0, B); b.clear(); keep.forEach(([k, v]) => b.set(k, v)) }
  }
  const end = [...beams[codes.length]].sort((x, y) => y[1] - x[1])
  if (!end.length) return { refused: 'UNKNOWN_CLUSTER' }
  if (end.length > 1 && end[0][1] - end[1][1] < MARGIN) return { refused: 'AMBIGUOUS' }
  return { text: end[0][0] }
}

// Not valid Telugu: an independent vowel followed by a vowel sign, a vowel sign with no consonant before
// it, two vowel signs in a row, or a leading virama.
export const DECODER_INVALID = /[అ-ఔ][ా-ౌౕౖౢౣ]|(^|[^క-హౘ-ౚ్])[ా-ౌ]|[ా-ౌ][ా-ౌ]|^్/u

export function decodeGlyphStream(stream) {
  let text = ''
  for (const t of glyphTokensWithCodes(stream)) {
    if (t.t === ' ') text += ' '
    else if (t.t === 'D') text += t.s
    else { const d = decodeCluster(t.codes); if (d.refused) return { refused: d.refused }; text += d.text }
  }
  if (DECODER_INVALID.test(text.replace(/\s+/g, ' '))) return { refused: 'INVALID_SEQUENCE' }
  return { text }
}

// ---- runs and units -----------------------------------------------------------------------------------
// The same items runGlyphStream reads (private-use items overlapping the run rect on its line).
const runItems = (pageItems, r) => pageItems.filter(i => PUA.test(i.str) && i.x < r.x1 && i.x + (i.width || 0) > r.x0 + 0.5 && i.y >= r.y0 && i.y <= r.y1)

// One Telugu run -> { status: 'DECODED', text } | { status: 'REFUSED', reason } | { status: 'NOT_APPLICABLE' }.
export function decodeLegacyRun(pageItems, run, fontSupport) {
  const its = runItems(pageItems || [], run.rect)
  if (!its.length) return { status: 'NOT_APPLICABLE' }
  const variants = new Set()
  for (const i of its) {
    const codes = (i.str.match(PUA_ALL) || [])
    // A private-use SPACE carries no letter; any other glyph must come from a supported face.
    if (codes.every(c => c === SP)) continue
    const f = fontSupport.get(i.fontName)
    if (!f?.supported) return { status: 'REFUSED', reason: 'UNSUPPORTED_FONT' }
    if (codes.some(c => !f.codes.has(c.codePointAt(0)))) return { status: 'REFUSED', reason: 'UNKNOWN_GLYPH_CODE' }
    variants.add(f.variant)
  }
  if (!variants.size) return { status: 'NOT_APPLICABLE' }
  const d = decodeGlyphStream(runGlyphStream(pageItems, run))
  return d.refused ? { status: 'REFUSED', reason: d.refused } : { status: 'DECODED', text: d.text, variants: [...variants] }
}

// A unit's decoder reading, assembled with the production unit rules (TEXT runs keep the text layer).
export function decodeUnit(unit, decodedRuns) {
  const te = unit.lineRuns.flatMap(l => l.runs.filter(r => r.type === 'TE'))
  const st = te.map(r => decodedRuns.get(r) || { status: 'NOT_APPLICABLE' })
  if (!st.length || st.every(s => s.status === 'NOT_APPLICABLE')) return { status: 'NOT_APPLICABLE' }
  const refused = st.find(s => s.status === 'REFUSED')
  if (refused) return { status: 'REFUSED', reason: refused.reason }
  if (st.some(s => s.status !== 'DECODED')) return { status: 'REFUSED', reason: 'PARTIAL_LEGACY' }
  const results = new Map(te.map((r, k) => [r, { text: st[k].text, confidence: 100 }]))
  return { status: 'DECODED', text: assembleUnit(unit, results).text, variants: [...new Set(st.flatMap(s => s.variants || []))] }
}

// Every Telugu run of every unit on the paper. Returns Map(run -> decodeLegacyRun result).
export function decodeLegacyRuns(structures, pages, fonts) {
  const support = identifyLegacyFonts(fonts)
  const itemsByPage = new Map(pages.map(p => [p.page, p.items]))
  const out = new Map()
  for (const s of structures) for (const u of s.units) for (const l of u.lineRuns) for (const r of l.runs) {
    if (r.type === 'TE' && !out.has(r)) out.set(r, decodeLegacyRun(itemsByPage.get(r.rect.page) || [], r, support))
  }
  return { runs: out, fonts: Object.fromEntries([...support].map(([n, m]) => [n, m.supported ? { supported: true, variant: m.variant } : { supported: false, reason: m.reason }])) }
}

// ---- routing -------------------------------------------------------------------------------------------
// Same visible text: NFC, joiners removed, whitespace collapsed.
export const sameTeluguText = (a, b) => {
  const n = s => String(s ?? '').normalize('NFC').replace(/[‌‍]/g, '').replace(/\s+/g, ' ').trim()
  return n(a) !== '' && n(a) === n(b)
}

// Attach the decoder reading to an assembled unit and route it. Never changes unit.text.
//   * agreement on an otherwise confidence-only unit (MEDIUM/LOW, no flag, no digit mismatch):
//     OCR_DECODER_AGREE — the unit becomes an optional verification; the text stays the OCR's;
//   * agreement anywhere else: recorded only (other problems still need the teacher);
//   * disagreement: OCR_DECODER_DISAGREE — blocking (HIGH drops to MEDIUM); the decoder text is kept
//     only as a suggestion the teacher may accept explicitly;
//   * refused / not applicable: recorded only; routing unchanged.
export function withDecoderReading(unit, reading) {
  const decoder = { name: LEGACY_DECODER, version: LEGACY_DECODER_VERSION, status: reading.status, ...(reading.reason ? { reason: reading.reason } : {}) }
  if (reading.status !== 'DECODED') return { ...unit, decoder }
  const flags = unit.flags || []
  if (sameTeluguText(reading.text, unit.text)) {
    const confidenceOnly = ['MEDIUM', 'LOW'].includes(unit.verdict) && !flags.length && unit.digitCheck !== 'MISMATCH'
    return { ...unit, flags: confidenceOnly ? [...flags, OCR_DECODER_AGREE] : flags, decoder: { ...decoder, agree: true, routed: confidenceOnly } }
  }
  return { ...unit, flags: [...flags, OCR_DECODER_DISAGREE], verdict: unit.verdict === 'HIGH' ? 'MEDIUM' : unit.verdict,
    decoder: { ...decoder, agree: false, suggestion: reading.text, verdictBefore: unit.verdict } }
}
