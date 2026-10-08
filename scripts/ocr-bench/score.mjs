// EXPERIMENT — score OCR systems against the fixed Telugu benchmark (measured errors, not confidence).
//
// Inputs: reports/ocr-bench/units.json (run-models.mjs), scripts/fixtures/telugu-ocr-benchmark-truth.json,
// optional reports/ocr-bench/glyphmap-output.json ({ id: text } for the glyph-map sample).
// Writes reports/ocr-bench/scores.json. Pure scoring helpers are exported for tests/reuse.
import fs from 'fs'

export const clean = s => [...String(s || '').normalize('NFC').replace(/[‌‍]/g, '').replace(/\s+/g, ' ').trim()]
export function align(hyp, ref) {
  const h = clean(hyp), r = clean(ref)
  const D = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)])
  for (let j = 0; j <= h.length; j++) D[0][j] = j
  for (let i = 1; i <= r.length; i++) for (let j = 1; j <= h.length; j++) {
    D[i][j] = Math.min(D[i - 1][j] + 1, D[i][j - 1] + 1, D[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1))
  }
  const ops = []
  let i = r.length, j = h.length
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && D[i][j] === D[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1)) { if (r[i - 1] !== h[j - 1]) ops.push({ op: 'S', ref: r[i - 1], hyp: h[j - 1], at: i - 1 }); i--; j-- }
    else if (i > 0 && D[i][j] === D[i - 1][j] + 1) { ops.push({ op: 'D', ref: r[i - 1], at: i - 1 }); i-- }
    else { ops.push({ op: 'I', hyp: h[j - 1], at: i }); j-- }
  }
  return { errors: D[r.length][h.length], length: r.length, ops: ops.reverse() }
}
export function wordErrors(hyp, ref) {
  const w = s => clean(s).join('').split(' ').filter(Boolean)
  const h = w(hyp), r = w(ref)
  let prev = Array.from({ length: h.length + 1 }, (_, j) => j)
  for (let i = 1; i <= r.length; i++) {
    const cur = [i]
    for (let j = 1; j <= h.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1))
    prev = cur
  }
  return { errors: prev[h.length], words: r.length }
}
export function charClass(c) {
  if (c == null) return 'NONE'
  const cp = c.codePointAt(0)
  if (/\d/.test(c)) return 'DIGIT'
  if (/[A-Za-z]/.test(c)) return 'LATIN'
  if (c === ' ') return 'SPACE'
  if (cp === 0x0C4D) return 'VIRAMA'
  if ((cp >= 0x0C3E && cp <= 0x0C4C) || cp === 0x0C55 || cp === 0x0C56 || cp === 0x0C62 || cp === 0x0C63) return 'VOWEL_SIGN'
  if (cp >= 0x0C00 && cp <= 0x0C03) return 'ANUSVARA_VISARGA'
  if (cp >= 0x0C05 && cp <= 0x0C14) return 'VOWEL'
  if ((cp >= 0x0C15 && cp <= 0x0C39) || (cp >= 0x0C58 && cp <= 0x0C5A)) return 'CONSONANT'
  if (cp >= 0x0C66 && cp <= 0x0C6F) return 'TELUGU_DIGIT'
  return 'PUNCT_SYMBOL'
}
const digits = s => (String(s || '').match(/\d+/g) || []).join(',')
// Unit-level failure types a teacher would recognise.
export function failureTypes(hyp, ref, ops) {
  const t = new Set()
  if (!clean(hyp).length && clean(ref).length) t.add('EMPTY_OUTPUT')
  if (digits(hyp) !== digits(ref)) t.add('NUMBER_WRONG')
  if (/[౦-౯]/.test(hyp)) t.add('TELUGU_DIGIT_EMITTED')
  if (ref.includes('॥') && (hyp.match(/॥/g) || []).length !== (ref.match(/॥/g) || []).length) t.add('ABBREVIATION_MARK')
  if (/[()[\]{}]/.test(hyp) && (hyp.match(/[()[\]{}]/g) || []).length !== (ref.match(/[()[\]{}]/g) || []).length) t.add('SPURIOUS_OR_LOST_BRACKET')
  if (/[£!|]/.test(hyp) && !/[£!|]/.test(ref)) t.add('JUNK_SYMBOL')
  for (const o of ops) {
    const cls = charClass(o.ref ?? o.hyp), cls2 = charClass(o.hyp)
    if (o.op === 'S' && cls === 'CONSONANT' && cls2 === 'CONSONANT') t.add('CONSONANT_CONFUSION')
    if ((o.ref && charClass(o.ref) === 'VOWEL_SIGN') || (o.hyp && charClass(o.hyp) === 'VOWEL_SIGN')) t.add('VOWEL_SIGN_ERROR')
    if ((o.ref && charClass(o.ref) === 'VIRAMA') || (o.hyp && charClass(o.hyp) === 'VIRAMA')) t.add('CONJUNCT_VIRAMA_ERROR')
    if (o.op === 'S' && charClass(o.ref) === 'VOWEL' && charClass(o.hyp) === 'VOWEL') t.add('INDEPENDENT_VOWEL_CONFUSION')
    if ((o.ref === ' ' || o.hyp === ' ')) t.add('SPACING')
    if (['“', '”', '‘', '’', '"', "'"].includes(o.ref) || ['“', '”', '‘', '’', '"', "'"].includes(o.hyp)) t.add('QUOTE_MARK')
  }
  return [...t]
}

export function scoreSystem(truth, hypOf) {
  const rows = truth.map(t => {
    const hyp = hypOf(t.id)
    if (hyp == null) return null
    const a = align(hyp, t.text), w = wordErrors(hyp, t.text)
    const cls = {}
    for (const o of a.ops) { const k = charClass(o.ref ?? o.hyp); cls[k] = (cls[k] || 0) + 1 }
    return { id: t.id, hyp, ref: t.text, errors: a.errors, length: a.length, cer: a.errors / a.length, wordErrors: w.errors, words: w.words,
      exact: a.errors === 0, digitsRight: digits(hyp) === digits(t.text), errorClasses: cls, failures: failureTypes(hyp, t.text, a.ops) }
  }).filter(Boolean)
  const sum = k => rows.reduce((n, r) => n + r[k], 0)
  const tally = f => rows.reduce((o, r) => { for (const k of f(r)) o[k] = (o[k] || 0) + 1; return o }, {})
  return {
    units: rows.length, exact: rows.filter(r => r.exact).length, charErrors: sum('errors'), chars: sum('length'), cer: sum('errors') / sum('length'),
    wordErrors: sum('wordErrors'), words: sum('words'), wer: sum('wordErrors') / sum('words'),
    unitsWithNumberError: rows.filter(r => !r.digitsRight).length,
    errorCharClasses: rows.reduce((o, r) => { for (const [k, v] of Object.entries(r.errorClasses)) o[k] = (o[k] || 0) + v; return o }, {}),
    failureUnits: tally(r => r.failures), rows,
  }
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  const truth = JSON.parse(fs.readFileSync('scripts/fixtures/telugu-ocr-benchmark-truth.json', 'utf8')).units
  const { units, models } = JSON.parse(fs.readFileSync('reports/ocr-bench/units.json', 'utf8'))
  const byId = new Map(units.map(u => [u.id, u]))
  const out = { truthUnits: truth.length, systems: {} }
  for (const m of Object.keys(models)) out.systems[m] = scoreSystem(truth, id => byId.get(id)?.models[m].text ?? '')
  // Verdict honesty on the benchmark: HIGH-but-wrong (silently risky) and not-HIGH-but-exact (wasted review).
  for (const m of Object.keys(models)) {
    const s = out.systems[m]
    const v = id => byId.get(id).models[m].verdict
    s.verdicts = s.rows.reduce((o, r) => (o[v(r.id)] = (o[v(r.id)] || 0) + 1, o), {})
    s.highButWrong = s.rows.filter(r => v(r.id) === 'HIGH' && !r.exact).map(r => r.id)
    s.flaggedButExact = s.rows.filter(r => v(r.id) !== 'HIGH' && r.exact).map(r => r.id)
  }
  const gm = 'reports/ocr-bench/glyphmap-output.json'
  if (fs.existsSync(gm)) {
    const g = JSON.parse(fs.readFileSync(gm, 'utf8'))
    const ids = Object.keys(g.outputs)
    const sub = truth.filter(t => ids.includes(t.id))
    out.glyphmap = { sample: ids, heldOut: g.heldOut, system: scoreSystem(sub, id => g.outputs[id]),
      sameSubset: Object.fromEntries(Object.keys(models).map(m => [m, scoreSystem(sub, id => byId.get(id)?.models[m].text ?? '')])) }
  }
  fs.writeFileSync('reports/ocr-bench/scores.json', JSON.stringify(out, null, 1))
  const brief = s => ({ units: s.units, exact: s.exact, cer: +(s.cer * 100).toFixed(2), wer: +(s.wer * 100).toFixed(2), charErrors: s.charErrors, wordErrors: s.wordErrors, numberErrors: s.unitsWithNumberError, highButWrong: s.highButWrong?.length, flaggedButExact: s.flaggedButExact?.length })
  console.log(JSON.stringify(Object.fromEntries(Object.entries(out.systems).map(([k, s]) => [k, brief(s)])), null, 1))
}
