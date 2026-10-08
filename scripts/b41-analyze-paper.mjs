// B4.1 — offline golden-paper analysis runner.
//
// Reads a LOCAL PDF with pdf.js, builds the page model (text items + image rectangles),
// runs the pure layout engine, and writes a machine-readable JSON plus a human report.
//
// No database, no Supabase, no auth, no Retry, no OCR, no migrations, no writes of any kind
// beyond the two local output files.
//
// Usage:
//   node scripts/b41-analyze-paper.mjs "C:\path\SI-CONSTABLE TEST-10.pdf"
//   node scripts/b41-analyze-paper.mjs paper.pdf --json b41.json --report b41-report.md
//   node scripts/b41-analyze-paper.mjs paper.pdf --pages 1-5 --fixture fixtures/pages.json

import fs from 'fs'
import path from 'path'
import { analysePaper } from './lib/paper-layout.mjs'
import { buildPageModels } from './lib/pdf-page-model.mjs'

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

function renderReport(result, meta) {
  const s = result.stats
  const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : 'n/a')
  const L = []
  L.push('# B4.1 — Golden-Paper Layout Engine report', '')
  L.push(`**Paper:** \`${meta.file}\``)
  L.push(`**Pages analysed:** ${s.pages} of ${meta.numPages} · generated ${new Date().toISOString()}`)
  L.push('', 'Offline analysis only: no OCR, no database, no network. Legacy Telugu is kept as source regions, never as text.', '')

  L.push('## Headline numbers', '')
  L.push('| Metric | Value |', '|---|---|')
  L.push(`| Questions detected / expected | ${s.questionsDetected} / ${s.expectedQuestions} |`)
  L.push(`| Missing question numbers | ${s.missingNumbers.length ? s.missingNumbers.join(', ') : 'none'} |`)
  L.push(`| Duplicate question numbers | ${s.duplicateNumbers.length ? s.duplicateNumbers.join(', ') : 'none'} |`)
  L.push(`| Questions with exactly 4 options | ${s.optionsExactlyFour} (${pct(s.optionsExactlyFour, s.questionsDetected)}) |`)
  L.push(`| Questions with 0 options | ${s.optionsNone} |`)
  L.push(`| Questions with <4 options | ${s.optionsFewerThanFour} |`)
  L.push(`| Questions with >4 options | ${s.optionsMoreThanFour} |`)
  L.push(`| Questions with a Telugu region | ${s.questionsWithTelugu} (${pct(s.questionsWithTelugu, s.questionsDetected)}) |`)
  L.push(`| Telugu regions detected | ${s.teluguRegionsDetected} |`)
  L.push(`| Visual candidates attached | ${s.visualsAttached} |`)
  L.push(`| Visual candidates rejected as decoration | ${s.visualsRejectedAsDecoration} (${s.decorationSignatures} decoration signatures) |`)
  L.push(`| Answer-key page | ${s.answerKeyPage ?? 'not found'} |`)
  L.push(`| Answer-key entries parsed | ${s.answerKeyEntries} |`)
  L.push(`| Answer-key entries with no matching question | ${s.answerKeyUnmapped.length ? s.answerKeyUnmapped.join(', ') : 'none'} |`)
  L.push(`| Cross-column questions | ${s.crossColumnQuestions} |`)
  L.push(`| Cross-page questions | ${s.crossPageQuestions} |`)
  L.push(`| READY (no teacher intervention) | ${s.ready} (${pct(s.ready, s.questionsDetected)}) |`)
  L.push(`| NEEDS_REVIEW | ${s.needsReview} |`)
  L.push(`| UNRESOLVED | ${s.unresolved} |`)
  L.push('')

  L.push('## Review reasons (frequency)', '')
  const freq = new Map()
  for (const q of result.questions) {
    for (const r of q.reviewReasons) {
      const key = r.replace(/\(.*\)/, '').trim()
      freq.set(key, (freq.get(key) || 0) + 1)
    }
  }
  L.push('| Reason | Questions |', '|---|---|')
  for (const [reason, n] of [...freq.entries()].sort((a, b) => b[1] - a[1])) L.push(`| ${reason} | ${n} |`)
  L.push('')

  for (const number of [6, 10]) {
    const q = result.questions.find(x => x.number === number)
    L.push(`## Q${number} (named golden case)`, '')
    if (!q) { L.push('**Not detected.**', ''); continue }
    L.push(`- pages: ${q.pages.join(', ')} · column keys: ${q.columns.join(', ')} · crossColumn=${q.crossColumn} crossPage=${q.crossPage}`)
    L.push(`- status: **${q.status}**${q.reviewReasons.length ? ` — ${q.reviewReasons.join('; ')}` : ''}`)
    L.push(`- English stem: ${JSON.stringify(q.englishText.slice(0, 160))}`)
    L.push(`- options (${q.options.length}): ${q.options.map(o => `${o.marker}) ${o.text}`).join(' | ') || 'none'}`)
    L.push(`- Telugu regions: ${q.teluguRegions.length} ${q.teluguRegions.map(r => `[p${r.page} ${Math.round(r.w)}x${Math.round(r.h)}pt, ${r.lines} lines]`).join(' ')}`)
    L.push(`- visuals attached: ${q.visuals.attached.length} ${q.visuals.attached.map(v => `[p${v.page} ${Math.round(v.rect.w)}x${Math.round(v.rect.h)}pt containment ${v.containment}]`).join(' ')}`)
    L.push(`- proposed answer: ${q.proposedAnswer ? `${q.proposedAnswer.letter} (position ${q.proposedAnswer.position}, from ${q.proposedAnswer.source})` : 'none'}`)
    L.push('')
  }

  L.push('## Cross-column / cross-page questions', '')
  const crossing = result.questions.filter(q => q.crossColumn || q.crossPage)
  L.push(crossing.length ? crossing.map(q => `- Q${q.number}: pages ${q.pages.join(',')} columns ${q.columns.join(',')} → ${q.status}`).join('\n') : '- none')
  L.push('')

  L.push('## Answer key', '')
  L.push(`Parsed from page ${s.answerKeyPage ?? '?'}: ${result.answerKey.entries.length} entries${result.answerKey.duplicates.length ? `, duplicates for ${result.answerKey.duplicates.join(', ')}` : ''}.`, '')
  const rows = []
  for (let i = 0; i < result.answerKey.entries.length; i += 10) {
    rows.push(result.answerKey.entries.slice(i, i + 10).map(e => `${e.number}) ${e.letter}`).join('  '))
  }
  L.push('```', ...rows, '```', '')

  L.push('## Questions routed to review', '')
  L.push('| Q | status | options | telugu | visuals | answer | reasons |', '|---|---|---|---|---|---|---|')
  for (const q of result.questions.filter(x => x.status !== 'READY')) {
    L.push(`| ${q.number} | ${q.status} | ${q.options.length} | ${q.teluguRegions.length} | ${q.visuals.attached.length} | ${q.proposedAnswer?.letter ?? '—'} | ${q.reviewReasons.join('; ')} |`)
  }
  L.push('')
  L.push(`**Estimated share proceeding without teacher intervention: ${pct(s.ready, s.questionsDetected)}**`)
  return L.join('\n')
}

async function main() {
  const file = process.argv[2]
  if (!file || file.startsWith('--')) {
    console.error('Usage: node scripts/b41-analyze-paper.mjs <file.pdf> [--pages 1-28] [--json out.json] [--report out.md] [--fixture fixture.json]')
    process.exit(2)
  }
  if (!fs.existsSync(file)) { console.error(`File not found: ${path.resolve(file)}`); process.exit(2) }

  const { pages, numPages } = await buildPageModels(file, arg('pages'))
  const result = analysePaper(pages, { expectedQuestions: Number(arg('expect')) || null })

  const jsonOut = arg('json', 'b41-paper-model.json')
  fs.writeFileSync(jsonOut, JSON.stringify({ meta: { file: path.resolve(file), numPages, generated: new Date().toISOString() }, ...result }, null, 2))
  const reportOut = arg('report', 'b41-report.md')
  fs.writeFileSync(reportOut, renderReport(result, { file: path.resolve(file), numPages }))

  const fixtureOut = arg('fixture')
  if (fixtureOut) {
    fs.mkdirSync(path.dirname(fixtureOut), { recursive: true })
    fs.writeFileSync(fixtureOut, JSON.stringify({ pages }, null, 1))
  }

  const s = result.stats
  console.log(`questions ${s.questionsDetected}/${s.expectedQuestions} · exactly4 ${s.optionsExactlyFour} · telugu ${s.questionsWithTelugu} · visuals ${s.visualsAttached} · key ${s.answerKeyEntries} · READY ${s.ready} (${((s.ready / Math.max(1, s.questionsDetected)) * 100).toFixed(1)}%)`)
  console.log(`JSON: ${path.resolve(jsonOut)}\nReport: ${path.resolve(reportOut)}`)
}

main().catch(e => { console.error('B4.1 analysis failed:', e); process.exit(1) })
