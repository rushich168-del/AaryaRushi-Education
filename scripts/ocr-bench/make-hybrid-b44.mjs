// EXPERIMENT — B4.4 benchmark file with one system's unit results substituted (default int+glyph),
// so the UNCHANGED writers (0025) and B4.5 review-item rules can measure the routing effect.
// Question outcome/reasons are recomputed with the production questionOutcome.
// Usage: node scripts/ocr-bench/make-hybrid-b44.mjs [--system int+glyph] [--out reports/ocr-bench/b44-int-glyph]
import fs from 'fs'
import path from 'path'
import { questionOutcome } from '../lib/telugu-ocr.mjs'

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d }
const system = arg('system', 'int+glyph')
const out = arg('out', 'reports/ocr-bench/b44-int-glyph')
const b44 = JSON.parse(fs.readFileSync('reports/b44/b44-benchmark.json', 'utf8'))
const byId = new Map(JSON.parse(fs.readFileSync('reports/ocr-bench/units.json', 'utf8')).units.map(u => [u.id, u]))
const UNIT_REASON = /^(STEM|OPTION[A-D]|BLOCK)_|^STRUCTURE_AMBIGUOUS$/
let changed = 0
for (const q of b44.questions) {
  q.units = q.units.map(x => {
    const r = byId.get(`${q.number}${x.kind === 'STEM' ? 'S' : x.kind === 'OPTION' ? 'O' + x.marker : 'B'}`).models[system]
    if (r.text !== x.text || r.verdict !== x.verdict) changed++
    return { ...x, text: r.text, ocrText: r.text, minConfidence: r.minConfidence, flags: r.flags, verdict: r.verdict, digitCheck: r.digitCheck }
  })
  const { outcome, reasons } = questionOutcome({ structure: q.structure, reasons: q.reasons.filter(r => !UNIT_REASON.test(r)) }, q.units)
  q.outcome = outcome; q.reasons = reasons
}
b44.meta = { ...b44.meta, experiment: `B4.4R-H: units from ${system} (reports/ocr-bench/units.json)` }
fs.mkdirSync(out, { recursive: true })
fs.writeFileSync(path.join(out, 'b44-benchmark.json'), JSON.stringify(b44))
console.log(`${system}: ${changed} units changed · auto questions ${b44.questions.filter(q => q.outcome === 'AUTO_OCR').length}`)
