// B4.4 / B4.7 — Telugu OCR rules, platform-neutral (shared by the Node tools and the in-browser
// preparation pipeline). Crop preparation, unit assembly, verdicts, digit/bracket checks, CER.
// No fs, no Node APIs, no OCR engine: the platform supplies the canvas factory and the worker.

export const OCR_ENGINE = 'tesseract.js'
// Self-hosted models (Apache-2.0). Production (B4.5R) = 'int' + the glyph-layer hybrid.
export const MODEL_LABELS = { best: 'tessdata_best/tel.traineddata', fast: 'tessdata_fast/tel.traineddata', int: 'tessdata/tel.traineddata (integer)' }
export const MODEL_SHA256 = {
  best: '81b0a1cfaf8bbf0f87da72b8c348264c6f24130766f5c4ade733fc20c05aaccc',
  fast: 'd10691fddd5b67802e1c12800ebb321d3b8bcd8d24a2ac3ff206f93188c04ab5',
  int: '7d092812889dc8bb1f42d93b8d98f6985278009e31ced30ff434ee0e3b44983d',
}
export const THRESHOLDS = Object.freeze({ high: 80, medium: 60, minTeluguRatio: 0.6 })

const TELUGU = /[ఀ-౿]/g
const PRIVATE_USE_OR_REPLACEMENT = /[-�]/g
const HAS_PRIVATE_USE = /[-�]/

// ---------- crop preparation ------------------------------------------------------------
// rect: PDF points (y up). Rendered canvas at `scale`. Returns the prepared canvas (the platform encodes it).
//   strategy 'gray'   — luminance only;
//   strategy 'binary' — luminance thresholded (removes the pale watermark behind the text);
//   strategy 'none'   — untouched pixels (the provenance/review crop).
// outScale (default = scale) resamples the crop, e.g. a 4x analysis canvas -> a 2x stored crop.
export function prepareCropCanvas(createCanvas, canvas, rect, { scale, pageHeightPt, strategy = 'binary', threshold = 170, marginPx = 12, skipLeadingGlyph = false, outScale = scale }) {
  if (skipLeadingGlyph) {
    const cut = leadingGlyphEndPt(canvas, rect, { scale, pageHeightPt, threshold })
    if (cut == null) return { canvas: null, pixel: null, empty: true }
    rect = { ...rect, x0: cut }
  }
  const sx = Math.max(0, Math.floor(rect.x0 * scale))
  const sy = Math.max(0, Math.floor((pageHeightPt - rect.y1) * scale))
  const sw = Math.min(canvas.width - sx, Math.ceil((rect.x1 - rect.x0) * scale))
  const sh = Math.min(canvas.height - sy, Math.ceil((rect.y1 - rect.y0) * scale))
  const k = outScale / scale
  const ow = Math.max(1, Math.round(sw * k)), oh = Math.max(1, Math.round(sh * k))
  const { canvas: out, context } = createCanvas(ow + 2 * marginPx, oh + 2 * marginPx)
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, out.width, out.height)
  context.drawImage(canvas, sx, sy, sw, sh, marginPx, marginPx, ow, oh)
  const pixel = { sx, sy, sw, sh, width: out.width, height: out.height, outScale }
  if (strategy === 'none') return { canvas: out, pixel }   // source-faithful
  const img = context.getImageData(0, 0, out.width, out.height)
  const d = img.data
  for (let p = 0; p < d.length; p += 4) {
    const y = (d[p] * 299 + d[p + 1] * 587 + d[p + 2] * 114) / 1000
    const v = strategy === 'binary' ? (y < threshold ? 0 : 255) : y
    d[p] = d[p + 1] = d[p + 2] = v; d[p + 3] = 255
  }
  context.putImageData(img, 0, 0)
  return { canvas: out, pixel }
}

// A bare-marker option ("A" + the Telugu font's ")") starts with that paren glyph. Find where
// the first ink blob ends and the following blank gap ends, in PDF points; null if nothing
// remains after the paren (the run was only ") ").
export function leadingGlyphEndPt(canvas, rect, { scale, pageHeightPt, threshold = 170 }) {
  const sx = Math.max(0, Math.floor(rect.x0 * scale)), sy = Math.max(0, Math.floor((pageHeightPt - rect.y1) * scale))
  const sw = Math.min(canvas.width - sx, Math.ceil((rect.x1 - rect.x0) * scale))
  const sh = Math.min(canvas.height - sy, Math.ceil((rect.y1 - rect.y0) * scale))
  if (sw <= 0 || sh <= 0) return null
  const d = canvas.getContext('2d').getImageData(sx, sy, sw, sh).data
  const ink = new Array(sw).fill(0)
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    const p = (y * sw + x) * 4
    if ((d[p] * 299 + d[p + 1] * 587 + d[p + 2] * 114) / 1000 < threshold) ink[x]++
  }
  const gap = Math.max(3, Math.round(0.05 * sh))   // about one space at 4x
  let x = ink.findIndex(v => v > 0)
  if (x < 0) return null
  let blank = 0
  for (; x < sw; x++) { if (ink[x] === 0) { if (++blank >= gap) break } else blank = 0 }
  while (x < sw && ink[x] === 0) x++
  if (x >= sw) return null
  return rect.x0 + (x - 2) / scale
}

// ---------- unit assembly ----------------------------------------------------------------
// runResults: Map(run -> { text, confidence }). Telugu runs contribute OCR text; TEXT runs
// contribute their text-layer string unchanged. The verdict is judged on the OCR'd part only
// and on its WEAKEST run (one bad run makes the whole unit reviewable).
// englishDigits: the digit tokens the English counterpart carries (option text, or the stem
// without its options). When given, the Telugu unit must carry exactly the same numbers.
export function assembleUnit(unit, runResults, { englishDigits = null } = {}) {
  const lines = [], ocrParts = [], confidences = []
  let emptyRuns = 0
  for (const line of unit.lineRuns) {
    const parts = []
    for (const run of line.runs) {
      if (run.type === 'TEXT') { parts.push(run.text); continue }
      const res = runResults.get(run)
      const t = normaliseOcrText(res?.text || '', { kind: 'STEM' })
      if (!t) { if (!res?.skipped) emptyRuns++; continue }
      parts.push(t); ocrParts.push(t); confidences.push(res.confidence)
    }
    if (parts.length) lines.push(parts.join(' '))
  }
  const text = normaliseOcrText(lines.join('\n'), { kind: unit.kind })
  const ocrText = ocrParts.join(' ')
  const minConfidence = confidences.length ? Math.min(...confidences) : 0
  const meanConfidence = confidences.length ? confidences.reduce((a, b) => a + b, 0) / confidences.length : 0
  let verdict = classifyOcr({ text: ocrText, confidence: minConfidence })
  const flags = []
  if (emptyRuns > 0) flags.push('EMPTY_RUN')                                          // part of the region read nothing
  if (!bracketsBalanced(ocrText)) flags.push('UNBALANCED_BRACKET')                   // e.g. the ra-vattu read as "("
  if (verdict === 'HIGH' && flags.length) verdict = 'MEDIUM'
  const digits = englishDigits ? digitCheck(text, englishDigits, { mode: unit.kind === 'OPTION' ? 'equal' : 'subset' }) : 'NONE'
  if (digits === 'MISMATCH' && ['HIGH', 'MEDIUM', 'LOW'].includes(verdict)) verdict = 'DIGIT_MISMATCH'
  return { kind: unit.kind, marker: unit.marker, text, ocrText, minConfidence, meanConfidence, runs: confidences.length, emptyRuns, flags, verdict, digitCheck: digits, teluguRatio: teluguRatio(ocrText) }
}

// Question-level outcome. Never guesses: anything short of clean structure + all-HIGH units
// is routed to review with reasons.
export function questionOutcome(structure, units) {
  const reasons = [...(structure.reasons || []).filter(r => r !== 'TELUGU_OPTIONS_NOT_IN_SOURCE')]
  if (structure.structure === 'NO_TELUGU') return { outcome: 'NO_TELUGU', reasons: [] }
  if (structure.structure === 'AMBIGUOUS_BLOCK') reasons.unshift('STRUCTURE_AMBIGUOUS')
  for (const u of units) if (u.verdict !== 'HIGH') reasons.push(`${u.kind}${u.marker ?? ''}_${u.verdict}`)
  return { outcome: reasons.length ? 'REVIEW' : 'AUTO_OCR', reasons }
}

// ---------- output normalisation and verdict ---------------------------------------------
export function normaliseOcrText(raw, { kind = 'STEM' } = {}) {
  let s = String(raw || '').normalize('NFC')
  s = s.replace(PRIVATE_USE_OR_REPLACEMENT, '')          // never persist legacy/replacement glyphs
  s = s.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim()
  if (kind === 'OPTION') s = s.replace(/^[\s)\].:,|-]+/, '').trim()   // the ")" printed after a bare marker
  return s
}

// Share of LETTERS that are Telugu. Digits, punctuation and symbols are script-neutral
// ("1వ, 8వ, 15వ" is Telugu text even though most of its characters are digits).
export function teluguRatio(text) {
  const letters = [...String(text)].filter(c => /\p{L}|\p{M}/u.test(c))
  if (!letters.length) return 0
  return letters.filter(c => /[ఀ-౿]/.test(c)).length / letters.length
}

// The Telugu model misreads digits ("30" -> "80", "4" -> "శ", "5" -> "శ్") with HIGH confidence,
// and numbers carry answer meaning. In this bilingual paper a Telugu unit prints the same numbers
// as its English counterpart. OPTIONS (short, parallel) must carry EQUAL digit multisets — a lost
// digit is as wrong as an invented one. STEMS only need a SUB-multiset: English stems restate
// series, figure labels and duplicated lines that the Telugu stem does not, so a stem can prove
// no digit was invented or misread, but cannot prove none was lost (known residual risk).
// NONE = neither side has digits.
export const digitTokens = text => String(text || '').match(/\d+/g) || []
export function digitCheck(teluguText, englishDigits, { mode = 'equal' } = {}) {
  const te = digitTokens(teluguText).sort()
  const en = [...englishDigits].sort()
  if (!te.length && (!en.length || mode === 'subset')) return 'NONE'
  if (mode === 'equal') return te.length === en.length && te.every((d, i) => d === en[i]) ? 'MATCH' : 'MISMATCH'
  const pool = [...en]
  for (const d of te) { const i = pool.indexOf(d); if (i < 0) return 'MISMATCH'; pool.splice(i, 1) }
  return 'MATCH'
}

// English stem digits = digits of the whole English run minus those of its options.
export function stemDigits(englishText, optionTexts) {
  const pool = digitTokens(englishText)
  for (const d of optionTexts.flatMap(digitTokens)) { const i = pool.indexOf(d); if (i > -1) pool.splice(i, 1) }
  return pool
}

// Character error rate against a reference, on NFC code points with joiners removed and
// whitespace collapsed ("క్‌" and "క్" are the same visible text).
export function characterErrorRate(hypothesis, reference) {
  const clean = s => [...String(s || '').normalize('NFC').replace(/[‌‍]/g, '').replace(/\s+/g, ' ').trim()]
  const h = clean(hypothesis), r = clean(reference)
  if (!r.length) return h.length ? 1 : 0
  let prev = Array.from({ length: h.length + 1 }, (_, j) => j)
  for (let i = 1; i <= r.length; i++) {
    const cur = [i]
    for (let j = 1; j <= h.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1))
    prev = cur
  }
  return { errors: prev[h.length], length: r.length, cer: prev[h.length] / r.length }
}

// B4.8.2 diagnostic: characters that cannot be right in OCR of a legacy-font Telugu paper, whatever the
// confidence says —
//   * Telugu numerals (U+0C66-0C6F): the legacy fonts draw digits as ASCII-mapped glyphs (proven in the
//     glyph atlases), so "౨" is a misread (of ఎ in "ఎ-2", of R in "(R)");
//   * currency/sign symbols the paper never prints (£ ¢ ¥ © ®), e.g. "జాబితా-£2" for "జాబితా-2";
//   * a vowel sign or virama with no Telugu letter before it ("ఎ-ా4"): not valid Telugu.
// It only ADDS a reason (HIGH becomes MEDIUM, like any other flag); it never makes anything ready.
export const OCR_SUSPECT_CHARACTERS = 'OCR_SUSPECT_CHARACTERS'
const SUSPECT = /[౦-౯£¢¥©®]|(^|[^ఀ-౿‌‍])[ా-్ౕౖౢౣ]/
export const hasSuspectCharacters = text => SUSPECT.test(String(text || ''))
export function withSuspectCharacterFlag(unit) {
  if (!unit?.text || !hasSuspectCharacters(unit.text) || (unit.flags || []).includes(OCR_SUSPECT_CHARACTERS)) return unit
  return { ...unit, flags: [...(unit.flags || []), OCR_SUSPECT_CHARACTERS], verdict: unit.verdict === 'HIGH' ? 'MEDIUM' : unit.verdict }
}

// B4.8.4B: an independent vowel followed by a dependent vowel sign ("అా", "ఏి") is not valid Telugu
// (a vowel letter already carries its vowel; the OCR split one letter into two). The suspect check above
// misses it because both characters are Telugu. Adds a reason only (HIGH becomes MEDIUM); the text is
// never changed.
export const INVALID_TELUGU_SEQUENCE = 'INVALID_TELUGU_SEQUENCE'
const INVALID_SEQUENCE = /[అ-ఔ][ా-ౌౕౖౢౣ]/u
export const hasInvalidTeluguSequence = text => INVALID_SEQUENCE.test(String(text || '').normalize('NFC'))
export function withInvalidSequenceFlag(unit) {
  if (!unit?.text || !hasInvalidTeluguSequence(unit.text) || (unit.flags || []).includes(INVALID_TELUGU_SEQUENCE)) return unit
  return { ...unit, flags: [...(unit.flags || []), INVALID_TELUGU_SEQUENCE], verdict: unit.verdict === 'HIGH' ? 'MEDIUM' : unit.verdict }
}

// B4.8.3B: the unit's region holds maths the OCR cannot carry (a bitmap fraction/radical, a raised digit
// after a Telugu word, an uncovered equation stub). Adds a reason only; never raises a verdict.
export const NOTATION_NOT_IN_OCR = 'NOTATION_NOT_IN_OCR'
export function withNotationFlag(unit, notation) {
  if (!notation?.length || (unit.flags || []).includes(NOTATION_NOT_IN_OCR)) return unit
  return { ...unit, flags: [...(unit.flags || []), NOTATION_NOT_IN_OCR], verdict: unit.verdict === 'HIGH' ? 'MEDIUM' : unit.verdict, notation }
}

export function bracketsBalanced(text) {
  const s = String(text)
  const n = c => (s.match(new RegExp(`\\${c}`, 'g')) || []).length
  return n('(') === n(')') && n('[') === n(']')
}

// HIGH: usable automatically as OCR_EXTRACTED. MEDIUM/LOW/EMPTY/NOT_TELUGU: review.
export function classifyOcr({ text, confidence }, t = THRESHOLDS) {
  if (!text) return 'EMPTY'
  if (HAS_PRIVATE_USE.test(text)) return 'NOT_TELUGU'
  const ratio = teluguRatio(text)
  if (ratio < t.minTeluguRatio) return 'NOT_TELUGU'
  if (confidence >= t.high) return 'HIGH'
  if (confidence >= t.medium) return 'MEDIUM'
  return 'LOW'
}
