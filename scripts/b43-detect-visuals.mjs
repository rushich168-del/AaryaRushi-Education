// B4.3 — offline automatic visual detection & cropping runner.
//
// Reads a LOCAL PDF, rebuilds the B4.1 paper model, renders every page through pdf.js,
// runs the pure B4.3 detector, and writes (all local, nothing else):
//   <out>/b43-manifest.json   every candidate with verdict, reasons, confidence, region
//   <out>/crops/*.png         accepted crops (and review previews of rejected candidates)
//   <out>/b43-report.md       measured results
//   <out>/b43-contact-sheet.html  accepted crops beside their source context, for inspection
//
// No database, no Supabase, no storage upload, no network.
//
// Usage:
//   node scripts/b43-detect-visuals.mjs "<paper>.pdf" --out reports/b43

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { analysePaper } from './lib/paper-layout.mjs'
import { buildPageModelsFromPdf } from './lib/pdf-page-model-core.mjs'
import { B43_DETECTOR, B43_DETECTOR_VERSION, DEFAULTS } from './lib/visual-detection.mjs'
import { runVisualStage } from './lib/visual-stage.mjs'
import { createNodePlatform } from './lib/preparation-platform-node.mjs'

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

function renderReport(meta, summary, detection) {
  const L = []
  const rows = detection.rows.filter(r => !r.noise)
  const accepted = rows.filter(r => r.status === 'ACCEPTED')
  L.push('# B4.3 — Automatic visual detection & cropping report', '')
  L.push(`**Paper:** \`${meta.file}\` (sha256 \`${meta.sha256.slice(0, 16)}…\`)`)
  L.push(`**Detector:** ${B43_DETECTOR} ${B43_DETECTOR_VERSION} · render scale ${DEFAULTS.scale}× · accept ≥ ${DEFAULTS.acceptConfidence} · generated ${meta.generated}`)
  L.push('', 'Offline only: pdf.js render → pixel evidence → crop manifest. No database, no storage, no network.', '')
  L.push('## Headline numbers', '', '| Metric | Value |', '|---|---|')
  L.push(`| Pages / questions | ${meta.pages} / ${meta.questions} |`)
  L.push(`| Questions predicted to require a visual | ${summary.questionsPredictedVisual} |`)
  L.push(`| Questions automatically cropped | ${summary.questionsAutoCropped} (${summary.cropsAccepted} crops) |`)
  L.push(`| Candidates considered (after noise filter) | ${summary.candidatesConsidered} |`)
  L.push(`| Candidates rejected / left for review | ${summary.candidatesRejected} |`)
  L.push(`| Predicted-visual questions left for review | ${summary.questionsLeftForReview.length}${summary.questionsLeftForReview.length ? ` (Q${summary.questionsLeftForReview.join(', Q')})` : ''} |`)
  L.push(`| Glyph-overflow / rule / speck residue discarded as noise | ${summary.noiseRejected} |`)
  L.push(`| Decoration components rejected (frame, column rule, repeated ink) | ${summary.decorationComponentsRejected} |`)
  L.push(`| Decoration attached as a question visual | ${summary.decorationAttached} |`)
  L.push(`| Questions receiving > 1 visual | ${summary.questionsWithMultipleVisuals.length ? summary.questionsWithMultipleVisuals.join(', ') : '0'} |`)
  L.push(`| Option-owned visual candidates | ${summary.optionOwnedCandidates.length ? summary.optionOwnedCandidates.map(o => `Q${o.questionNumber}`).join(', ') : '0'} (never attached) |`)
  L.push('')
  L.push('## Confidence distribution (non-noise candidates)', '', '| Bucket | Accepted | Rejected |', '|---|---|---|')
  for (const b of ['0.95-1.00', '0.85-0.94', '0.70-0.84', '<0.70']) {
    const v = summary.confidenceBuckets[b] || { accepted: 0, rejected: 0 }
    L.push(`| ${b} | ${v.accepted} | ${v.rejected} |`)
  }
  const unscored = rows.filter(r => !r.confidence).length
  L.push(`| not scored (rejected before scoring: outside/crossing a question) | 0 | ${unscored} |`, '')
  L.push('## Rejection reasons (all candidates, including noise)', '', '| Reason | Count |', '|---|---|')
  for (const [k, v] of Object.entries(summary.reasonCounts).sort((a, b) => b[1] - a[1])) L.push(`| ${k} | ${v} |`)
  L.push('')
  const q6 = accepted.find(r => r.questionNumber === 6)
  L.push('## Q6 (golden case)', '')
  if (q6) {
    L.push(`- **ACCEPTED** · owner: question 6 (not an option) · page ${q6.page} · tier ${q6.tier} · confidence **${q6.confidence}**`)
    L.push(`- crop: ${q6.pixel.sw}×${q6.pixel.sh}px at ${q6.renderScale}× · PDF pt x ${q6.cropPt.x0}–${q6.cropPt.x1}, y ${q6.cropPt.y0}–${q6.cropPt.y1}`)
    L.push(`- normalized region (top-left origin): x ${q6.region.x}, y ${q6.region.y}, w ${q6.region.w}, h ${q6.region.h}`)
    L.push(`- ink box: ${JSON.stringify(q6.inkBoxPt)} · signals ${JSON.stringify(q6.signals)} · file \`${q6.file}\``)
  } else L.push('- **NOT accepted** — see candidates below.')
  L.push('')
  L.push('## Accepted crops', '', '| id | Q | page | tier | confidence | crop px | labels absorbed |', '|---|---|---|---|---|---|---|')
  for (const r of accepted) L.push(`| ${r.id} | ${r.questionNumber} | ${r.page} | ${r.tier} | ${r.confidence} | ${r.pixel.sw}×${r.pixel.sh} | ${(r.absorbedLabels || []).join(' ') || '—'} |`)
  L.push('')
  L.push('## Rejected candidates (non-noise)', '', '| id | Q | page | tier | confidence | reasons |', '|---|---|---|---|---|---|')
  for (const r of rows.filter(r => r.status !== 'ACCEPTED')) {
    L.push(`| ${r.id} | ${r.questionNumber ?? (r.candidateOwners ? r.candidateOwners.join('/') : (r.precedesQuestion ? `material before Q${r.precedesQuestion}` : '—'))} | ${r.page} | ${r.tier ?? '—'} | ${r.confidence || '—'} | ${r.reasons.join(', ')} |`)
  }
  L.push('')
  L.push('## Visual status changed from B4.1', '', '| Q | B4.1 | B4.3 | detail |', '|---|---|---|---|')
  for (const p of summary.changedFromB41) {
    L.push(`| ${p.number} | ${p.b41} | ${p.b43} | ${p.accepted.length ? `accepted ${p.accepted.join(', ')}` : p.rejected.map(x => `${x.id}: ${x.reasons.join('+')}`).join('; ') || 'no candidate'} |`)
  }
  L.push('')
  L.push('Question status (READY / NEEDS_REVIEW) is **not** changed by B4.3; re-routing is B4.5.')
  return L.join('\n')
}

// Self-contained: images are embedded, so the sheet can be opened or moved anywhere.
function renderContactSheet(meta, detection, out) {
  const rows = detection.rows.filter(r => !r.noise)
  const src = file => `data:image/png;base64,${fs.readFileSync(path.join(out, file)).toString('base64')}`
  const card = r => `
  <figure class="${r.status === 'ACCEPTED' ? 'ok' : 'no'}">
    <figcaption><b>${r.status === 'ACCEPTED' ? '✔' : '✖'} ${r.questionNumber ? `Q${r.questionNumber}` : (r.precedesQuestion ? `(material before Q${r.precedesQuestion})` : '(no owner)')}</b> · p${r.page} · ${r.tier ?? '—'} · conf ${r.confidence || '—'}<br><small>${r.id}${r.reasons.length ? ` · ${r.reasons.join(', ')}` : ''}</small></figcaption>
    <div class="pair">
      ${r.file ? `<div><small>crop</small><img src="${src(r.file)}" alt="crop ${r.id}"></div>` : ''}
      <div><small>source context</small><img src="${src(r.contextFile)}" alt="context ${r.id}"></div>
    </div>
  </figure>`
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>B4.3 contact sheet</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root{--bg:#f6f5f1;--fg:#1d2433;--ok:#1f7a4d;--no:#a33b2f;--card:#fff;--line:#d9d6cc}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#15181e;--fg:#e8e6df;--card:#1f232b;--line:#353a44}}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif}
h1{font-size:20px;margin:0 0 4px} h2{font-size:16px;margin:24px 0 8px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px}
figure{margin:0;background:var(--card);border:1px solid var(--line);border-left:4px solid var(--line);border-radius:6px;padding:10px}
figure.ok{border-left-color:var(--ok)} figure.no{border-left-color:var(--no)}
.pair{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px}.pair>div{flex:1 1 140px;min-width:0}
img{max-width:100%;height:auto;background:#fff;border:1px solid var(--line);display:block}
small{opacity:.75}
</style></head><body>
<h1>B4.3 automatic visuals — contact sheet</h1>
<p>${meta.file.split(/[\\/]/).pop()} · ${B43_DETECTOR} ${B43_DETECTOR_VERSION} · ${meta.generated}. Green = attached automatically; red = rejected / left for review.</p>
<h2>Accepted (${rows.filter(r => r.status === 'ACCEPTED').length})</h2>
<div class="grid">${rows.filter(r => r.status === 'ACCEPTED').map(card).join('')}</div>
<h2>Rejected candidates (${rows.filter(r => r.status !== 'ACCEPTED').length})</h2>
<div class="grid">${rows.filter(r => r.status !== 'ACCEPTED').map(card).join('')}</div>
</body></html>`
}

async function main() {
  const file = process.argv[2]
  if (!file || file.startsWith('--') || !fs.existsSync(file)) {
    console.error('Usage: node scripts/b43-detect-visuals.mjs <file.pdf> [--out reports/b43]')
    process.exit(2)
  }
  const out = arg('out', 'reports/b43')
  for (const dir of ['crops', 'materials']) {
    fs.mkdirSync(path.join(out, dir), { recursive: true })
    for (const f of fs.readdirSync(path.join(out, dir))) fs.rmSync(path.join(out, dir, f))
  }

  // B4.7: the same shared stage the in-browser preparation runs (scripts/lib/visual-stage.mjs).
  const platform = createNodePlatform()
  const bytes = fs.readFileSync(file)
  const opened = await platform.openPdf(bytes)
  const { pages, numPages } = await buildPageModelsFromPdf(opened.pdf, opened.pdfjs.OPS)
  const model = analysePaper(pages)
  const { manifest: stage, crops, detection, summary } = await runVisualStage({ pdf: opened.pdf, pages, model, platform, withContext: true })
  for (const [name, png] of crops) fs.writeFileSync(path.join(out, name), png)

  const meta = {
    file: path.resolve(file),
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    generated: new Date().toISOString(),
    pages: numPages,
    questions: model.questions.length,
    detector: B43_DETECTOR,
    detectorVersion: B43_DETECTOR_VERSION,
    renderScale: DEFAULTS.scale,
  }
  const manifest = { ...stage, meta }
  fs.writeFileSync(path.join(out, 'b43-manifest.json'), JSON.stringify(manifest, null, 2))
  fs.writeFileSync(path.join(out, 'b43-report.md'), renderReport(meta, summary, detection))
  fs.writeFileSync(path.join(out, 'b43-contact-sheet.html'), renderContactSheet(meta, detection, out))
  console.log(`predicted ${summary.questionsPredictedVisual} · auto-cropped ${summary.questionsAutoCropped} (${summary.cropsAccepted} crops) · rejected ${summary.candidatesRejected} · noise ${summary.noiseRejected} · decoration ${summary.decorationComponentsRejected}`)
  console.log(`Manifest: ${path.resolve(out, 'b43-manifest.json')}`)
}

main().catch(e => { console.error('B4.3 detection failed:', e); process.exit(1) })
