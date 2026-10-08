// B4.8.4C — fresh golden preparation (Node, production orchestrator) on a THROWAWAY local PostgreSQL
// cluster (never KSC), plus the 21 maths values of the B4.8.3C simulated-teacher fixture through the real
// ksc_resolve_math_image RPC (the state the accepted baselines were measured in). Dumps read-only.
//
//   node scripts/b484c-golden-prepare.mjs [out.json]      (default reports/b484c/node-dump.json)
import fs from 'node:fs'
import path from 'node:path'
import { createLocalKscDb, prepareGoldenDraft, dumpDraft, cleanupStaleClusters } from './lib/local-draft-db.mjs'
import { groupMathImages, friendlyToLatex } from './lib/math-image-recovery.mjs'

const out = process.argv[2] || 'reports/b484c/node-dump.json'
fs.mkdirSync(path.dirname(out), { recursive: true })
cleanupStaleClusters()
const fixture = JSON.parse(fs.readFileSync('scripts/fixtures/b483c-simulated-teacher-math.json', 'utf8')).resolutions
const db = await createLocalKscDb()
try {
  const t0 = Date.now()
  const { runId, draftPaperId, summary } = await prepareGoldenDraft(db, {})
  const prepMs = Date.now() - t0
  const questions = (await db.pool.query('SELECT * FROM draft_questions WHERE draft_paper_id = $1', [draftPaperId])).rows
  const options = (await db.pool.query('SELECT o.* FROM draft_options o JOIN draft_questions q ON q.id = o.draft_question_id WHERE q.draft_paper_id = $1', [draftPaperId])).rows
  let applied = 0
  for (const g of groupMathImages(questions).filter(x => x.fp && fixture[x.fp])) {
    const placements = g.occurrences.map(o => {
      const t = o.side === 'te' ? null : o.owner === 'stem' ? questions.find(q => q.id === o.questionId) : options.find(x => x.draft_question_id === o.questionId && x.marker === o.owner)
      return { question_id: o.questionId, key: `${o.page}@${o.box.x},${o.box.y}`, expected: t ? t.content : null }
    })
    const r = await db.runner.rpc(db.teacher, 'ksc_resolve_math_image', { p_draft_paper_id: draftPaperId, p_fingerprint: g.fp, p_input: fixture[g.fp].input,
      p_representation: friendlyToLatex(fixture[g.fp].input).latex, p_placements: placements, p_note: 'B4.8.4C benchmark (simulated teacher, local only)' })
    applied += r.placements.filter(p => p.outcome === 'APPLIED').length
  }
  const dump = await dumpDraft(db, draftPaperId, runId)
  fs.writeFileSync(out, JSON.stringify({ ...dump, generated: new Date().toISOString(), source: 'node-prepared, throwaway local PostgreSQL', prepMs, mathPlacementsApplied: applied }, null, 1))
  const items = dump.reviewItems || []
  const r = {}; for (const x of dump.readiness || []) r[x.readiness] = (r[x.readiness] || 0) + 1
  console.log(JSON.stringify({ out, prepMs, applied, blocking: items.filter(i => i.blocking && i.status !== 'RESOLVED').length,
    optional: items.filter(i => !i.blocking && i.status !== 'RESOLVED').length, readiness: r, sourceEvidence: summary?.telugu?.sourceEvidence ?? null }, null, 1))
} finally { await db.stop() }
