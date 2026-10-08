// B4.4 — offline Telugu OCR benchmark on a LOCAL PDF.
//
// pdf.js page model -> B4.1 paper model -> Telugu stem/option structure (geometry only) ->
// render each page once -> OCR only the Telugu runs (never the PDF's legacy strings) ->
// glyph-layer hybrid (B4.5R: digits/punctuation/॥/quotes/spacing from the text layer when the run
// aligns; letters always OCR) -> assemble units -> verdicts. Writes, locally only:
//   <out>/b44-benchmark.json   per question/unit results, timings, metrics
//   <out>/b44-report.md        measured results
//   <out>/b44-contact-sheet.html  source crop beside OCR text for representative questions
// No database, no network (the Telugu model is read from vendor/tessdata).
//
// Usage: node scripts/b44-ocr-benchmark.mjs "<paper>.pdf" [--out reports/b44] [--model int] [--hybrid glyph|none] [--scale 4] [--workers 4]
// Production default (B4.5R): --model int --hybrid glyph. '--model fast --hybrid none' reproduces the B4.4 baseline.

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { analysePaper } from './lib/paper-layout.mjs'
import { buildPageModelsFromPdf } from './lib/pdf-page-model-core.mjs'
import { characterErrorRate, MODEL_SHA256, THRESHOLDS } from './lib/telugu-ocr-core.mjs'
import { runTeluguStage } from './lib/telugu-stage.mjs'
import { createNodePlatform } from './lib/preparation-platform-node.mjs'

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

async function main() {
  const file = process.argv[2]
  if (!file || file.startsWith('--') || !fs.existsSync(file)) { console.error('Usage: node scripts/b44-ocr-benchmark.mjs <file.pdf> [--out reports/b44]'); process.exit(2) }
  const out = arg('out', 'reports/b44')
  const modelName = arg('model', 'int')
  const hybridMode = arg('hybrid', 'glyph')
  if (!['glyph', 'none'].includes(hybridMode)) throw new Error('--hybrid must be glyph or none')
  const scale = Number(arg('scale', 4))
  const workers = Number(arg('workers', 4))
  const strategy = arg('strategy', 'binary')
  const threshold = Number(arg('threshold', 170))
  fs.mkdirSync(path.join(out, 'crops'), { recursive: true })
  for (const f of fs.readdirSync(path.join(out, 'crops'))) fs.rmSync(path.join(out, 'crops', f))

  // B4.7: the same shared stage the in-browser preparation runs (scripts/lib/telugu-stage.mjs).
  const t0 = Date.now()
  const platform = createNodePlatform()
  const opened = await platform.openPdf(fs.readFileSync(file))
  const { pages, fonts } = await buildPageModelsFromPdf(opened.pdf, opened.pdfjs.OPS)
  const model = analysePaper(pages)
  const modelSha = await platform.modelSha256(modelName)
  if (modelSha !== MODEL_SHA256[modelName]) throw new Error(`tel.traineddata (${modelName}) checksum mismatch`)
  const w0 = Date.now()
  const pool = await platform.createOcrPool({ model: modelName, workers })
  const workersMs = Date.now() - w0
  let stage
  try {
    stage = await runTeluguStage({ pdf: opened.pdf, pages, fonts, model, platform, ocrPool: pool, modelKey: modelName, modelSha256: modelSha, hybridMode, scale, strategy, threshold })
  } finally { await pool.terminate() }
  const { benchmark, crops, unitCropsByQuestion } = stage
  for (const [name, png] of crops) fs.writeFileSync(path.join(out, name), png)
  const questions = benchmark.questions.map((q, i) => ({ ...q, _crops: unitCropsByQuestion[i].map(list => list.map(png => Buffer.from(png).toString('base64'))) }))
  const metrics = { ...benchmark.metrics, timingsMs: { ...benchmark.metrics.timingsMs, total: Date.now() - t0, workers: workersMs } }

  // Spot-check accuracy against an assistant-transcribed reference (see fixture provenance).
  const truthFile = 'scripts/fixtures/b44-telugu-spot-truth.json'
  if (fs.existsSync(truthFile)) {
    const truth = JSON.parse(fs.readFileSync(truthFile, 'utf8'))
    const rows = truth.units.map(t => {
      const u = questions.find(q => q.number === t.q)?.units.find(x => x.kind === t.kind && (x.marker ?? null) === t.marker)
      const e = u ? characterErrorRate(u.text, t.text) : { errors: [...t.text].length, length: [...t.text].length, cer: 1 }
      return { q: t.q, unit: `${t.kind}${t.marker ?? ''}`, verdict: u?.verdict ?? 'MISSING', ocr: u?.text ?? '', truth: t.text, ...e }
    })
    const agg = rs => { const e = rs.reduce((n, r) => n + r.errors, 0), l = rs.reduce((n, r) => n + r.length, 0); return { units: rs.length, exact: rs.filter(r => r.errors === 0).length, cer: l ? +(e / l).toFixed(4) : 0 } }
    metrics.spotCheck = { provenance: truth.provenance, all: agg(rows), high: agg(rows.filter(r => r.verdict === 'HIGH')), rows }
  }
  const meta = { file: path.resolve(file), generated: new Date().toISOString(), ...benchmark.meta }
  delete meta.platform

  fs.writeFileSync(path.join(out, 'b44-benchmark.json'), JSON.stringify({ meta, metrics, questions: questions.map(({ _crops, ...q }) => q) }, null, 2))
  fs.writeFileSync(path.join(out, 'b44-report.md'), renderReport(meta, metrics, questions))
  fs.writeFileSync(path.join(out, 'b44-contact-sheet.html'), renderSheet(meta, metrics, questions))
  const verdicts = metrics.unitVerdicts
  console.log(`units ${metrics.unitsAttempted} · genuine Telugu ${metrics.unitsGenuineTelugu} · HIGH ${verdicts.HIGH || 0} · auto questions ${metrics.questionsAutoOcr}/${metrics.questionsWithTelugu} · ${(metrics.timingsMs.total / 1000).toFixed(1)} s`)
}

function renderReport(meta, m, questions) {
  const L = []
  L.push('# B4.4 — Telugu OCR benchmark (golden paper)', '')
  L.push(`**Engine:** ${meta.engine} ${meta.engineVersion} · model \`${meta.model}\` (sha256 \`${meta.modelSha256.slice(0, 16)}…\`) · render ${meta.scale}× · ${meta.preprocessing} · ${meta.workers} workers · ${meta.generated}`)
  if (meta.hybrid) {
    L.push('', `**Hybrid:** ${meta.hybrid.name} ${meta.hybrid.version}: ${meta.hybrid.classes}. A run is used only when its letter segments align one-to-one (ratio ${meta.hybrid.segmentRatioBounds.min}–${meta.hybrid.segmentRatioBounds.max}); otherwise OCR is kept.`)
    L.push(`Run status: ${Object.entries(m.hybrid.runStatus).map(([k, v]) => `${k} ${v}`).join(' · ')} · units changed by the glyph layer ${m.hybrid.unitsChangedByGlyphLayer} · units flagged GLYPH_ALIGNMENT_AMBIGUOUS ${m.hybrid.unitsAlignmentAmbiguous} · stored OCR version \`${meta.ocrVersion}\``)
  }
  L.push('', 'OCR reads rendered pixels of B4.1 Telugu runs only. Latin/number runs inside Telugu text keep their text-layer string. Nothing is translated or completed.', '')
  L.push('## Headline numbers', '', '| Metric | Value |', '|---|---|')
  L.push(`| Questions with Telugu (B4.1) | ${m.questionsWithTelugu} / ${m.questions} |`)
  L.push(`| Telugu units attempted (stem / option / block) | ${m.unitsAttempted} (${m.runsAttempted} pixel runs; ${m.runsSkippedMarkerOnly} were only a marker glyph) |`)
  L.push(`| Units OCR'd with text | ${m.unitsWithOcrText} |`)
  L.push(`| Units producing genuine Telugu Unicode (≥${THRESHOLDS.minTeluguRatio * 100}% Telugu code points) | ${m.unitsGenuineTelugu} |`)
  L.push(`| Units empty / unusable | ${m.unitsEmptyOrUnusable} |`)
  L.push(`| Units whose OCR digits disagree with the English counterpart (routed to review) | ${m.unitsDigitMismatch} (digits verified in ${m.unitsDigitVerified}) |`)
  L.push(`| Unit verdicts | ${Object.entries(m.unitVerdicts).map(([k, v]) => `${k} ${v}`).join(' · ')} |`)
  L.push(`| Run confidence mean / median | ${m.runConfidence.mean} / ${m.runConfidence.median} |`)
  L.push(`| Unit (weakest-run) confidence mean / median | ${m.unitMinConfidence.mean} / ${m.unitMinConfidence.median} |`)
  L.push(`| Questions structurally separated (stem + options, or stem + script-neutral options) | ${m.questionsStructurallySeparated} |`)
  L.push(`| Questions fully automatic (clean structure, every unit HIGH) | ${m.questionsAutoOcr} |`)
  L.push(`| Questions requiring review | ${m.questionsReview} |`)
  L.push(`| Telugu units needing a teacher (estimate) | ${m.unitsNeedingTeacher} of ${m.unitsAttempted} |`)
  L.push(`| Script-neutral options kept without OCR | ${m.scriptNeutralOptions} |`)
  L.push(`| Full-paper time | ${(m.timingsMs.total / 1000).toFixed(1)} s (render ${(m.timingsMs.render / 1000).toFixed(1)} s, OCR ${(m.timingsMs.ocr / 1000).toFixed(1)} s, workers ${(m.timingsMs.workers / 1000).toFixed(1)} s) |`)
  L.push('')
  L.push('## Structure', '', '| Structure | Questions |', '|---|---|')
  for (const [k, v] of Object.entries(m.structures)) L.push(`| ${k} | ${v} |`)
  L.push('', '## Unit confidence distribution (weakest run)', '', '| Bucket | Units |', '|---|---|')
  for (const b of ['90-100', '80-89', '70-79', '60-69', '<60']) L.push(`| ${b} | ${m.unitMinConfidence.distribution[b] || 0} |`)
  L.push('', '## Review reasons', '', '| Reason | Questions |', '|---|---|')
  const freq = {}
  for (const q of questions) for (const r of new Set(q.reasons.map(r => r.replace(/\(.*\)/, '').replace(/^(STEM|OPTION[A-D]|BLOCK)_/, 'UNIT_')))) freq[r] = (freq[r] || 0) + 1
  for (const [k, v] of Object.entries(freq).sort((a, b) => b[1] - a[1])) L.push(`| ${k} | ${v} |`)
  const q6 = questions.find(q => q.number === 6)
  L.push('', '## Q6', '', `- structure **${q6.structure}**, outcome **${q6.outcome}** ${q6.reasons.join('; ')}`)
  for (const u of q6.units) L.push(`- ${u.kind}: \`${u.text}\` (confidence ${u.minConfidence.toFixed(0)}, ${u.verdict})`)
  L.push(`- English options: ${q6.englishOptions.join(' · ')} → Telugu versions are SCRIPT_NEUTRAL (no OCR, no new options) · proposed ${q6.proposedAnswer} (proposed only)`)
  if (m.spotCheck) {
    const sc = m.spotCheck
    L.push('', '## Spot-check accuracy', '', `> ${sc.provenance}`, '')
    L.push(`All ${sc.all.units} units: ${sc.all.exact} exact, CER ${(sc.all.cer * 100).toFixed(1)}% · units still HIGH after all checks: ${sc.high.units}, ${sc.high.exact} exact, CER ${(sc.high.cer * 100).toFixed(1)}%`, '')
    L.push('| Q | unit | verdict | errors | OCR | reference |', '|---|---|---|---|---|---|')
    for (const r of sc.rows) L.push(`| ${r.q} | ${r.unit} | ${r.verdict} | ${r.errors}/${r.length} | ${r.ocr.split(String.fromCharCode(10)).join(' / ')} | ${r.truth} |`)
  }
  L.push('', '## Every question', '', '| Q | structure | outcome | units (verdict, min conf) | reasons |', '|---|---|---|---|---|')
  for (const q of questions) {
    L.push(`| ${q.number} | ${q.structure} | ${q.outcome} | ${q.units.map(u => `${u.kind[0]}${u.marker ?? ''}:${u.verdict}/${Math.round(u.minConfidence)}`).join(' ')} | ${q.reasons.join('; ')} |`)
  }
  return L.join('\n')
}

function renderSheet(meta, m, questions) {
  const pick = new Set()
  const add = qs => qs.forEach(q => q && pick.add(q.number))
  add([1, 5, 6, 8, 10, 12, 14, 104, 105].map(n => questions.find(q => q.number === n)))
  add(questions.filter(q => q.outcome === 'AUTO_OCR' && q.structure === 'STEM_AND_OPTIONS').slice(10, 16))
  add(questions.filter(q => q.units.some(u => u.verdict === 'MEDIUM')).slice(0, 5))
  add(questions.filter(q => q.units.some(u => ['LOW', 'EMPTY', 'NOT_TELUGU'].includes(u.verdict))).slice(0, 6))
  add(questions.filter(q => q.structure === 'AMBIGUOUS_BLOCK').slice(0, 3))
  const cls = v => ({ HIGH: 'ok', MEDIUM: 'mid' }[v] || 'bad')
  const card = q => `
<section class="q"><h3>Q${q.number} <small>${q.structure} · <b class="${q.outcome === 'AUTO_OCR' ? 'ok' : 'bad'}">${q.outcome}</b>${q.reasons.length ? ` · ${esc(q.reasons.join('; '))}` : ''}</small></h3>
<p class="en">${esc(q.englishStem.slice(0, 220))}<br><small>${esc(q.englishOptions.join('   '))}${q.proposedAnswer ? ` · proposed ${q.proposedAnswer} (proposed only)` : ''}</small></p>
${q.units.map((u, i) => `<div class="unit"><div class="src">${(q._crops[i] || []).map(b => `<img alt="source Q${q.number} ${u.kind}${u.marker ?? ''}" src="data:image/png;base64,${b}">`).join('')}</div>
<div class="ocr"><span class="tag ${cls(u.verdict)}">${u.kind}${u.marker ? ` ${u.marker}` : ''} · ${u.verdict} · ${Math.round(u.minConfidence)}</span><div lang="te">${esc(u.text) || '<i>(empty)</i>'}</div></div></div>`).join('')}
${q.structure === 'STEM_WITH_NEUTRAL_OPTIONS' ? '<p class="note">Options are script-neutral: the Telugu versions reuse them (no OCR, no extra options).</p>' : ''}
</section>`
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>B4.4 OCR contact sheet</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root{--bg:#f6f5f1;--fg:#1d2433;--card:#fff;--line:#d9d6cc;--ok:#1f7a4d;--mid:#9a6a00;--bad:#a33b2f}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#15181e;--fg:#e8e6df;--card:#1f232b;--line:#353a44}}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,"Noto Sans Telugu","Nirmala UI",sans-serif}
h1{font-size:20px;margin:0 0 4px}.q{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:12px;margin:12px 0}
h3{margin:0 0 6px;font-size:16px}.en{margin:0 0 8px}.unit{display:flex;gap:12px;flex-wrap:wrap;border-top:1px dashed var(--line);padding:6px 0}
.src{flex:1 1 280px;min-width:0}.src img{max-width:100%;height:auto;background:#fff;border:1px solid var(--line);display:block;margin-bottom:4px}
.ocr{flex:1 1 280px;min-width:0;font-size:17px;white-space:pre-wrap}.tag{font-size:12px;border-radius:3px;padding:1px 6px;color:#fff}
.tag.ok,b.ok{background:var(--ok);color:#fff;padding:0 4px;border-radius:3px}.tag.mid{background:var(--mid)}.tag.bad,b.bad{background:var(--bad);color:#fff;padding:0 4px;border-radius:3px}
small{opacity:.8}.note{font-size:13px;opacity:.8}
</style></head><body>
<h1>B4.4 Telugu OCR — source crop beside OCR output</h1>
<p>${esc(meta.file.split(/[\\/]/).pop())} · ${meta.engine} ${meta.engineVersion} · ${esc(meta.model)} · ${meta.scale}× · ${meta.generated}<br>
${m.questionsAutoOcr} questions fully automatic, ${m.questionsReview} to review, ${m.unitsGenuineTelugu}/${m.unitsAttempted} units genuine Telugu. Showing ${pick.size} representative questions.</p>
${questions.filter(q => pick.has(q.number)).map(card).join('')}
</body></html>`
}

main().catch(e => { console.error('B4.4 benchmark failed:', e); process.exit(1) })
