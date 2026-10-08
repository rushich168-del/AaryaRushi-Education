// EXPERIMENT (not production) — run the unchanged B4.4 pipeline with different Telugu models.
//
// Same page model, Telugu structure, 4x render, binary<170 preparation, PSM 7 per run, same unit
// assembly and verdicts as scripts/b44-ocr-benchmark.mjs. Only the traineddata differs. The worker
// factory is local to this file, so scripts/lib/telugu-ocr.mjs (production) is untouched.
// Also records each Telugu run's legacy glyph codes (for the glyph-map feasibility test) and
// writes unprocessed 2x unit crops for the benchmark fixture.
//
// Usage: node scripts/ocr-bench/run-models.mjs "<paper>.pdf" [--models fast,int] [--out reports/ocr-bench]

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { analysePaper } from '../lib/paper-layout.mjs'
import { openPdf, buildPageModels } from '../lib/pdf-page-model.mjs'
import { buildTeluguStructures } from '../lib/telugu-structure.mjs'
import { prepareCrop, assembleUnit, digitTokens, stemDigits } from '../lib/telugu-ocr.mjs'
import { hybridRun, runGlyphStream, RATIO } from '../lib/telugu-glyph-hybrid.mjs'
export { glyphTokens, ocrSegments, hybridRun, DETERMINISTIC, DETERMINISTIC_PAIRS, RATIO } from '../lib/telugu-glyph-hybrid.mjs'

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d }
export const MODELS = {
  fast: { dir: 'vendor/tessdata/fast', sha256: 'd10691fddd5b67802e1c12800ebb321d3b8bcd8d24a2ac3ff206f93188c04ab5', label: 'tessdata_fast (production)' },
  int: { dir: 'vendor/tessdata/int', sha256: '7d092812889dc8bb1f42d93b8d98f6985278009e31ced30ff434ee0e3b44983d', label: 'tessdata (integer, main)' },
}
const SCALE = 4, WORKERS = 4, THRESHOLD = 170, PSM = '7'

// ---- B4.4R-H glyph layer: now the production module (B4.5R); imported so the experiment and
// production run the identical algorithm.
async function worker(langPath) {
  const { createWorker, OEM } = await import('tesseract.js')
  const w = await createWorker('tel', OEM.LSTM_ONLY, { langPath: path.resolve(langPath), gzip: false, cacheMethod: 'none', logger: () => {}, errorHandler: () => {} })
  await w.setParameters({ tessedit_pageseg_mode: PSM, preserve_interword_spaces: '1' })
  return { recognize: async png => { const { data } = await w.recognize(png); return { text: data.text || '', confidence: Number.isFinite(data.confidence) ? data.confidence : 0 } }, terminate: () => w.terminate() }
}

async function render(pdf, n) {
  const page = await pdf.getPage(n)
  const vp = page.getViewport({ scale: SCALE })
  const { canvas, context } = pdf.canvasFactory.create(Math.floor(vp.width), Math.floor(vp.height))
  context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height)
  await page.render({ canvasContext: context, canvas, viewport: vp }).promise
  return { canvas, heightPt: page.getViewport({ scale: 1 }).height }
}

async function main() {
  const file = process.argv[2]
  const out = arg('out', 'reports/ocr-bench')
  const names = arg('models', 'fast,int').split(',')
  fs.mkdirSync(path.join(out, 'crops'), { recursive: true })
  for (const m of names) {
    const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(MODELS[m].dir, 'tel.traineddata'))).digest('hex')
    if (sha !== MODELS[m].sha256) throw new Error(`${m} model checksum mismatch`)
  }
  const opened = await openPdf(file)
  const { pages } = await buildPageModels(file, null, opened)
  const model = analysePaper(pages)
  const structures = buildTeluguStructures(pages, model)
  const runsByPage = new Map()
  for (const q of structures) for (const u of q.units) for (const l of u.lineRuns) for (const r of l.runs) if (r.type === 'TE') {
    if (!runsByPage.has(r.rect.page)) runsByPage.set(r.rect.page, [])
    runsByPage.get(r.rect.page).push(r)
  }
  const pools = Object.fromEntries(await Promise.all(names.map(async m => [m, await Promise.all(Array.from({ length: WORKERS }, () => worker(MODELS[m].dir)))])))
  const results = Object.fromEntries(names.map(m => [m, new Map()]))
  const ms = Object.fromEntries(names.map(m => [m, 0]))
  const cropFiles = new Map()
  for (const [pageNumber, runs] of [...runsByPage].sort((a, b) => a[0] - b[0])) {
    const { canvas, heightPt } = await render(opened.pdf, pageNumber)
    const preps = runs.map(run => prepareCrop(opened.pdf, canvas, run.rect, { scale: SCALE, pageHeightPt: heightPt, strategy: 'binary', threshold: THRESHOLD, skipLeadingGlyph: run.skipLeadingParen }))
    for (const m of names) {
      const t0 = Date.now()
      let next = 0
      await Promise.all(pools[m].map(async ocr => {
        while (next < runs.length) {
          const k = next++
          if (preps[k].empty) { results[m].set(runs[k], { text: '', confidence: 0, skipped: true }); continue }
          results[m].set(runs[k], await ocr.recognize(preps[k].png))
        }
      }))
      ms[m] += Date.now() - t0
    }
    for (const q of structures) q.units.forEach(u => u.rects.filter(r => r.page === pageNumber).forEach((rect, k) => {
      const f = `crops/q${q.number}-${u.kind}${u.marker ?? ''}-p${pageNumber}-${k}.png`
      fs.writeFileSync(path.join(out, f), prepareCrop(opened.pdf, canvas, rect, { scale: SCALE, outScale: 2, pageHeightPt: heightPt, strategy: 'none', marginPx: 0 }).png)
      if (!cropFiles.has(u)) cropFiles.set(u, [])
      cropFiles.get(u).push(f)
    }))
  }
  for (const m of names) await Promise.all(pools[m].map(w => w.terminate()))

  // Production drops run items after computing rects; recover each run's legacy strings from the
  // page items whose baseline and start fall inside the run rect (reading order).
  const PUA = new RegExp('[' + String.fromCharCode(0xE000) + '-' + String.fromCharCode(0xF8FF) + ']')
  const teGlyphs = rect => {
    const its = pages.find(p => p.page === rect.page).items
      .filter(i => PUA.test(i.str) && i.x >= rect.x0 - 0.5 && i.x < rect.x1 && i.y >= rect.y0 && i.y <= rect.y1)
      .sort((a, b) => b.y - a.y || a.x - b.x)
    return { te: its.map(i => i.str).join(' '), font: [...new Set(its.map(i => i.fontName))].join(',') }
  }
  // ---- B4.4R-H glyph-layer hybrid (bounded) ------------------------------------------------
  const runStream = run => runGlyphStream(pages.find(p => p.page === run.rect.page).items, run)
  const hybridSystems = names.map(m => `${m}+glyph`)
  const hybridResults = Object.fromEntries(names.map(m => [m, new Map()]))
  const runStatus = Object.fromEntries(names.map(m => [m, new Map()]))
  const evidence = Object.fromEntries(names.map(m => [m, {}]))
  const ratios = []
  for (const m of names) for (const [run, res] of results[m]) {
    if (res.skipped) { hybridResults[m].set(run, res); continue }
    const h = hybridRun(runStream(run), res.text)
    runStatus[m].set(run, h)
    hybridResults[m].set(run, h.status === 'ALIGNED' ? { ...res, text: h.text } : res)
    if (h.status === 'ALIGNED') {
      h.ratios.forEach(x => ratios.push(x))
      for (const [det, ocrGap] of h.gaps) for (const ch of det) if (ch !== ' ') {
        const e = evidence[m][ch] = evidence[m][ch] || { glyph: 0, ocrAgrees: 0 }
        e.glyph++; if (ocrGap.includes(ch)) e.ocrAgrees++
      }
    }
  }
  const byNumber = new Map(model.questions.map(q => [q.number, q]))
  const units = []
  for (const s of structures) {
    const q = byNumber.get(s.number)
    for (const u of s.units) {
      const englishDigits = u.kind === 'OPTION' ? digitTokens(q.options.find(o => o.marker === u.marker)?.text) : u.kind === 'STEM' ? stemDigits(q.englishText, q.options.map(o => o.text)) : null
      const glyphs = u.lineRuns.map(l => l.runs.map(r => (r.type === 'TE' ? teGlyphs(r.rect) : { text: r.text })))
      const row = { id: `${s.number}${u.kind === 'STEM' ? 'S' : u.kind === 'OPTION' ? 'O' + u.marker : 'B'}`, q: s.number, kind: u.kind, marker: u.marker, structure: s.structure,
        english: u.kind === 'OPTION' ? q.options.find(o => o.marker === u.marker)?.text ?? null : q.englishText, englishDigits, crops: cropFiles.get(u) || [], glyphs, models: {} }
      for (const m of names) {
        const a = assembleUnit(u, results[m], { englishDigits })
        row.models[m] = { text: a.text, verdict: a.verdict, minConfidence: +a.minConfidence.toFixed(1), digitCheck: a.digitCheck, flags: a.flags }
        // Hybrid: same assembly and verdict rules over the aligned runs. A run whose glyph layer
        // carries deterministic tokens but could not be aligned keeps OCR and is flagged for review.
        const b = assembleUnit(u, hybridResults[m], { englishDigits })
        const teRuns = u.lineRuns.flatMap(l => l.runs.filter(r => r.type === 'TE'))
        const st = teRuns.map(r => runStatus[m].get(r)).filter(Boolean)
        const flags = [...b.flags]
        let verdict = b.verdict
        if (st.some(s => s.status !== 'ALIGNED' && s.hasDeterministic)) { flags.push('GLYPH_ALIGNMENT_AMBIGUOUS'); if (verdict === 'HIGH') verdict = 'MEDIUM' }
        row.models[`${m}+glyph`] = { text: b.text, verdict, minConfidence: +b.minConfidence.toFixed(1), digitCheck: b.digitCheck, flags,
          runs: st.map(s => s.status) }
      }
      units.push(row)
    }
  }
  const statusTally = m => [...runStatus[m].values()].reduce((o, s) => (o[s.status] = (o[s.status] || 0) + 1, o), {})
  const hybridMeta = Object.fromEntries(names.map(m => [`${m}+glyph`, { label: `${MODELS[m].label} letters + deterministic glyph layer`, runStatus: statusTally(m), classEvidence: evidence[m] }]))
  const q = xs => { const s = [...xs].sort((a, b) => a - b); return [0, 0.01, 0.5, 0.99, 1].map(p => +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2)) }
  fs.writeFileSync(path.join(out, 'units.json'), JSON.stringify({ generated: new Date().toISOString(), models: { ...Object.fromEntries(names.map(m => [m, { ...MODELS[m], ocrMs: ms[m] }])), ...hybridMeta },
    hybrid: { segmentRatioBounds: RATIO, alignedSegmentRatioQuantiles: ratios.length ? q(ratios) : null },
    settings: { scale: SCALE, threshold: THRESHOLD, psm: PSM, workers: WORKERS, engine: 'tesseract.js OEM LSTM_ONLY' }, units }, null, 1))
  const tally = m => units.reduce((o, u) => (o[u.models[m].verdict] = (o[u.models[m].verdict] || 0) + 1, o), {})
  console.log(JSON.stringify({ units: units.length, ...Object.fromEntries([...names, ...hybridSystems].map(m => [m, { verdicts: tally(m), ...(hybridMeta[m] ? { runStatus: hybridMeta[m].runStatus } : { ocrSeconds: ms[m] / 1000 }) }])),
    identical: units.filter(u => names.every(m => u.models[m].text === u.models[names[0]].text)).length }))
}
main().catch(e => { console.error(e); process.exit(1) })
