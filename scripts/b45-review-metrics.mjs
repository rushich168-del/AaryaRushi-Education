// B4.5 — routing metrics for the persisted golden Draft.
//
// Reads reports/b4-preview/draft-dump.json (written by scripts/b4-persist-local.mjs after the real
// writers 0023-0027 ran on throwaway PostgreSQL) and reports readiness, review items by type,
// route and effort, and teacher actions with/without shared-material de-duplication. Readiness is
// taken from the database view (draft_question_readiness) and cross-checked against the pure
// derivation. Writes reports/b45/b45-metrics.json and reports/b45/b45-report.md. Read-only.

import fs from 'fs'
import path from 'path'
import { deriveReadiness, actionCounts } from './lib/review-items.mjs'

const OUT = 'reports/b45'
const dump = JSON.parse(fs.readFileSync('reports/b4-preview/draft-dump.json', 'utf8'))
const items = dump.reviewItems
const tally = (xs, f) => xs.reduce((o, x) => { const k = f(x); o[k] = (o[k] || 0) + 1; return o }, {})

const dbReadiness = tally(dump.readiness, r => r.readiness)
const jsReadiness = deriveReadiness(dump, items)
const agree = dump.readiness.every(r => jsReadiness.find(j => j.draft_question_id === r.draft_question_id)?.readiness === r.readiness)

const blocking = items.filter(i => i.blocking)
const advisory = items.filter(i => !i.blocking)
const group = {
  telugu: i => ['TELUGU_STEM', 'TELUGU_OPTION', 'TELUGU_STRUCTURE_AMBIGUOUS', 'TELUGU_VERIFY'].includes(i.item_type),
  sharedMaterial: i => !!i.draft_material_id,
  visual: i => /VISUAL/.test(i.item_type) && !i.draft_material_id,
  optionStructure: i => ['OPTION_SET_ABNORMAL', 'OPTION_EMPTY', 'UNASSIGNED_TEXT', 'ENGLISH_STEM_MISSING', 'STRUCTURE'].includes(i.item_type),
  answerKey: i => i.item_type === 'ANSWER_KEY',
}
const counts = Object.fromEntries(Object.entries(group).map(([k, f]) => [k, { blocking: blocking.filter(f).length, advisory: advisory.filter(f).length }]))
const actions = actionCounts(dump, items)
const effort = tally(blocking, i => i.effort)

// A deliberately simple, stated time model — to be replaced by timings recorded in the prototype.
const SECONDS = { ONE_CLICK_ACCEPT: 5, SHORT_CORRECTION: 30, TRANSCRIPTION: 120, MANUAL_INVESTIGATION: 120 }
const reviewSeconds = blocking.reduce((n, i) => n + SECONDS[i.effort], 0)
const advisorySeconds = advisory.length * SECONDS.ONE_CLICK_ACCEPT

const byQuestion = new Map(dump.questions.map(q => [q.row.id, Number(q.row.source_question_number)]))
const q105 = items.filter(i => i.detail?.number === 105).map(i => ({ type: i.item_type, marker: i.detail.marker ?? null, route: i.route, value: i.extracted_value, confidence: i.confidence }))
const metrics = {
  generated: new Date().toISOString(),
  readiness: dbReadiness, readinessSource: 'draft_question_readiness view (0027)', readinessMatchesPureDerivation: agree,
  items: { total: items.length, blocking: blocking.length, advisory: advisory.length, byType: tally(items, i => i.item_type), byRoute: tally(items, i => i.route) },
  groups: counts,
  teacherActions: { ...actions, note: 'blocking items; a shared-material item counted once vs once per linked question' },
  effortBlocking: effort,
  advisoryOneClick: advisory.length,
  timeModelSeconds: SECONDS,
  estimatedReviewMinutes: Math.round(reviewSeconds / 60),
  estimatedAdvisoryMinutes: Math.round(advisorySeconds / 60),
  q105CounterExample: q105,
  manualReviewQuestions: dump.readiness.filter(r => r.readiness === 'MANUAL_REVIEW').map(r => byQuestion.get(r.draft_question_id)).sort((a, b) => a - b),
}
fs.mkdirSync(OUT, { recursive: true })
fs.writeFileSync(path.join(OUT, 'b45-metrics.json'), JSON.stringify(metrics, null, 2))

const L = []
L.push('# B4.5 — Readiness and exception review (golden paper)', '')
L.push(`Persisted Draft (writers 0023–0027 on throwaway PostgreSQL) · generated ${metrics.generated}`, '')
L.push('## Question readiness (derived from open blocking items)', '', '| READY | QUICK_CHECK | MANUAL_REVIEW |', '|---|---|---|')
L.push(`| ${dbReadiness.READY || 0} | ${dbReadiness.QUICK_CHECK || 0} | ${dbReadiness.MANUAL_REVIEW || 0} |`, '')
L.push(`Database view and pure derivation agree: **${agree}**.`, '')
L.push('## Review items', '', '| Group | Blocking | Advisory (non-blocking) |', '|---|---|---|')
for (const [k, v] of Object.entries(counts)) L.push(`| ${k} | ${v.blocking} | ${v.advisory} |`)
L.push(`| **total** | **${blocking.length}** | **${advisory.length}** |`, '')
L.push('| Item type | Count |', '|---|---|')
for (const [k, v] of Object.entries(metrics.items.byType).sort((a, b) => b[1] - a[1])) L.push(`| ${k} | ${v} |`)
L.push('', '## Teacher actions', '')
L.push(`- If every blocking item were resolved per question: **${actions.independent}** actions.`)
L.push(`- With shared-material items resolved once: **${actions.actual}** actions (**${actions.savedBySharing}** saved).`)
L.push(`- Advisory verifications (optional, one click each): ${advisory.length}.`, '')
L.push('## Effort estimate (blocking items)', '', '| Effort | Items | Assumed seconds |', '|---|---|---|')
for (const k of Object.keys(SECONDS)) L.push(`| ${k} | ${effort[k] || 0} | ${SECONDS[k]} |`)
L.push('', `Estimated review time with this stated model: ~${metrics.estimatedReviewMinutes} min (+ ~${metrics.estimatedAdvisoryMinutes} min for the optional advisory checks). Replace with measured timings from the prototype.`)
L.push('', '## Confidence is not correctness (Q105)', '')
for (const r of q105) L.push(`- ${r.type}${r.marker ? ` ${r.marker}` : ''} · ${r.route} · confidence ${r.confidence ?? '—'} · \`${r.value ?? ''}\``)
L.push('', 'Q105\'s stem is HIGH confidence and still wrong ("వ దేశంలో" for "ఏ దేశంలో"), so HIGH OCR is an ADVISORY verification item — it never silently counts as verified.')
fs.writeFileSync(path.join(OUT, 'b45-report.md'), L.join('\n'))
console.log(JSON.stringify({ readiness: dbReadiness, agree, items: metrics.items.total, blocking: blocking.length, advisory: advisory.length, groups: counts, actions, effort, minutes: metrics.estimatedReviewMinutes }))
