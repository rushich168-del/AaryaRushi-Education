// B4.8.4C — deterministic SOURCE evidence for the teacher's Telugu review (pure, platform-neutral).
//
// Two things are derived from the PDF itself (never from OCR confidence, never from the English):
//
// 1. A source fingerprint per Telugu unit ("tg1:" + 24 hex of SHA-256). It covers the WHOLE printed unit in
//    reading order: every legacy-font run (font names + its glyph stream) and every text-layer run (its
//    string, e.g. the digits of "రూ॥ 500"). Two units with the same fingerprint print exactly the same thing,
//    so one teacher reading could apply to both — the Telugu analogue of the B4.8.3C maths fingerprint.
//    Only the hash is kept; the legacy glyph stream is never stored or returned.
//
// 2. Printed digits. The legacy fonts draw digits as one-to-one digit glyphs (proven in the B4.5 glyph
//    atlases; DETERMINISTIC in telugu-glyph-hybrid.mjs). When the glyph hybrid could not align a run, the
//    unit's digits come from OCR and can be misread ("2 1 4 8" printed as "2 1 4 3"). For each Telugu run the
//    printed digit tokens are compared with the OCR digit tokens:
//      MATCH        every run's OCR digits are exactly the printed digits;
//      REPAIRABLE   every run has the same NUMBER of tokens and some differ: the candidate text is the unit
//                   re-assembled with each OCR token replaced, in order, by the printed token. Offered to the
//                   teacher as "Use printed digits"; never stored as content by itself;
//      CONFLICT     the candidate still disagrees with the English digits (not offered: something else is
//                   wrong, e.g. the English differs from the Telugu);
//      UNAVAILABLE  token counts differ (a digit read as a letter, or a lost digit): no safe alignment.
//    The English digits are used only as an extra refusal check, never as the source of a digit.

import { runGlyphStream, DETERMINISTIC } from './telugu-glyph-hybrid.mjs'

export const SOURCE_FP_VERSION = 'tg1'
export const PRINTED_DIGITS = 'ksc-printed-digits'
export const PRINTED_DIGITS_VERSION = '1.0.0'

const SP = String.fromCharCode(0xF020)
const PUA = /[-]/
const teRuns = unit => unit.lineRuns.flatMap(l => l.runs.filter(r => r.type === 'TE'))
// The fonts of the legacy items a run's glyph stream is read from (same overlap rule as runGlyphStream).
const runFonts = (pageItems, r) => [...new Set(pageItems.filter(i => PUA.test(i.str) && i.x < r.rect.x1 && i.x + (i.width || 0) > r.rect.x0 + 0.5
  && i.y >= r.rect.y0 && i.y <= r.rect.y1).map(i => i.fontName).filter(Boolean))].sort().join(',')

// Canonical in-memory description of the printed unit (never stored; only hashed).
export function unitSourceKey(unit, itemsByPage) {
  if (!teRuns(unit).length) return null
  const lines = unit.lineRuns.map(l => l.runs.map(r => {
    if (r.type !== 'TE') return `X${String(r.text ?? '')}`
    const fonts = runFonts(itemsByPage.get(r.rect.page) || [], r)
    return `T${fonts}\u0001${runGlyphStream(itemsByPage.get(r.rect.page) || [], r).split(SP).filter(Boolean).join(SP)}`
  }).join('\u0002'))
  return `${SOURCE_FP_VERSION}\u0000${unit.kind === 'OPTION' ? 'O' : unit.kind}\u0000${lines.join('\n')}`
}

// sha256: async (Uint8Array) -> hex (the platform's).
export async function unitSourceFingerprint(unit, itemsByPage, sha256) {
  const key = unitSourceKey(unit, itemsByPage)
  if (!key) return null
  return `${SOURCE_FP_VERSION}:${(await sha256(new TextEncoder().encode(key))).slice(0, 24)}`
}

// Digit tokens a legacy glyph stream prints (digit glyphs only; anything else separates tokens).
export function printedDigitTokens(stream) {
  let s = ''
  for (const ch of String(stream ?? '')) { const d = DETERMINISTIC.get(ch); s += d !== undefined && /\d/.test(d) ? d : ' ' }
  return s.match(/\d+/g) || []
}
const ocrDigitTokens = text => String(text ?? '').match(/\d+/g) || []

// results: the per-run results the unit was assembled from (hybrid results when the hybrid ran).
// assembleUnit: the production unit assembler (telugu-ocr-core.mjs). englishDigits: as for the digit check.
export function printedDigitEvidence(unit, results, itemsByPage, { assembleUnit, englishDigits = null, currentText }) {
  const runs = teRuns(unit)
  let printedAny = false, ocrAny = false, differs = false
  const replaced = new Map()
  for (const r of runs) {
    const res = results.get(r)
    if (!res || res.skipped) continue
    const printed = printedDigitTokens(runGlyphStream(itemsByPage.get(r.rect.page) || [], r))
    const ocr = ocrDigitTokens(res.text)
    printedAny ||= printed.length > 0; ocrAny ||= ocr.length > 0
    if (printed.length !== ocr.length) return { status: 'UNAVAILABLE', reason: 'TOKEN_COUNT_DIFFERS' }
    if (printed.some((t, i) => t !== ocr[i])) {
      differs = true
      let k = 0
      replaced.set(r, { ...res, text: String(res.text).replace(/\d+/g, () => printed[k++]) })
    }
  }
  if (!printedAny && !ocrAny) return { status: 'NO_DIGITS' }
  if (!differs) return { status: 'MATCH' }
  const merged = new Map(results)
  for (const [r, res] of replaced) merged.set(r, res)
  const candidate = assembleUnit(unit, merged, { englishDigits })
  if (!candidate.text || candidate.text === currentText) return { status: 'UNAVAILABLE', reason: 'NO_CHANGE' }
  const before = ocrDigitTokens(currentText), after = ocrDigitTokens(candidate.text)
  if (englishDigits && candidate.digitCheck === 'MISMATCH') return { status: 'CONFLICT', before, after }
  return { status: 'REPAIRABLE', name: PRINTED_DIGITS, version: PRINTED_DIGITS_VERSION, text: candidate.text, before, after }
}
