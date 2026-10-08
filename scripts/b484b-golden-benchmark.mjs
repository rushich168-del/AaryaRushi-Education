// B4.8.4B — fresh golden benchmark of hybrid Telugu extraction & safety routing.
//
// Two full preparations of the golden paper through the ONE production orchestrator on THROWAWAY local
// PostgreSQL clusters (never KSC): decoder OFF (the OCR-only routing, for attribution) and decoder ON
// (production). Each then gets the 21 math-image values of the B4.8.3C simulated-teacher fixture through
// the real ksc_resolve_math_image RPC — the state the 313/407 · 64/121/15 baseline was measured in — and
// is dumped read-only. Nothing is confirmed; no answer is touched.
//
// The "71 exceptions" and the proposal judgements are the B4.8.4A/A2 research artefacts
// (reports/b484a2/product-impact.json, proposal-judgements.json — ASSISTANT-judged against the source
// crops, not teacher-verified).
//
//   node scripts/b484b-golden-benchmark.mjs            -> reports/b484b/benchmark.json (+ dumps)
//   node scripts/b484b-golden-benchmark.mjs --analyse <off-dump.json> <on-dump.json> <out.json> "<environment>"
//        (no preparation: the same analysis over two existing dumps, e.g. browser-prepared ones)
import fs from 'node:fs'
import { createLocalKscDb, prepareGoldenDraft, dumpDraft, cleanupStaleClusters } from './lib/local-draft-db.mjs'
import { groupMathImages, friendlyToLatex } from './lib/math-image-recovery.mjs'

const OUT = 'reports/b484b'
fs.mkdirSync(OUT, { recursive: true })
const ANALYSE = process.argv.indexOf('--analyse')
if (ANALYSE < 0) cleanupStaleClusters()
const fixture = JSON.parse(fs.readFileSync('scripts/fixtures/b483c-simulated-teacher-math.json', 'utf8')).resolutions

async function prepared(decoderOn) {
  const db = await createLocalKscDb()
  try {
    const t0 = Date.now()
    const { runId, draftPaperId, summary } = await prepareGoldenDraft(db, { hooks: { teluguDecoder: decoderOn } })
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
        p_representation: friendlyToLatex(fixture[g.fp].input).latex, p_placements: placements, p_note: 'B4.8.4B benchmark (simulated teacher, local only)' })
      applied += r.placements.filter(p => p.outcome === 'APPLIED').length
    }
    const dump = await dumpDraft(db, draftPaperId, runId)
    return { prepMs, summary, applied, dump }
  } finally { await db.stop() }
}

// ---- per-unit view of a dump ---------------------------------------------------------------------------
function units(dump) {
  const media = new Map(dump.questions.flatMap(q => (q.media || []).map(m => [m.id, m])))
  const out = new Map()
  for (const q of dump.questions) {
    const n = q.row.source_question_number
    const add = (key, t) => { if (t && t.language === 'te') out.set(key, { key, row: t, crop: t.source_media_id ? media.get(t.source_media_id) : null }) }
    for (const t of q.texts || []) add(`${n}:STEM`, t)
    for (const o of q.options || []) for (const t of o.texts || []) add(`${n}:OPTION${o.row.marker}`, t)
  }
  const keyOfItem = new Map()
  for (const q of dump.questions) {
    for (const t of q.texts || []) keyOfItem.set(`qt:${t.id}`, `${q.row.source_question_number}:STEM`)
    for (const o of q.options || []) for (const t of o.texts || []) keyOfItem.set(`ot:${t.id}`, `${q.row.source_question_number}:OPTION${o.row.marker}`)
  }
  for (const i of dump.reviewItems) {
    const k = i.target_question_text_id ? keyOfItem.get(`qt:${i.target_question_text_id}`) : i.target_option_text_id ? keyOfItem.get(`ot:${i.target_option_text_id}`) : null
    if (k && out.has(k)) out.get(k).item = i
  }
  return out
}
const open = i => i && i.status !== 'RESOLVED'
const count = (xs, f) => xs.reduce((o, x) => { const k = f(x); o[k] = (o[k] || 0) + 1; return o }, {})
function headline(dump) {
  const items = dump.reviewItems.filter(open)
  return { blocking: items.filter(i => i.blocking).length, optional: items.filter(i => !i.blocking).length,
    readiness: count(dump.readiness, r => r.readiness),
    confirmedAnswers: dump.questions.flatMap(q => q.options || []).filter(o => o.row.is_confirmed_correct).length,
    teluguBlocking: items.filter(i => i.blocking && ['TELUGU_STEM', 'TELUGU_OPTION'].includes(i.item_type)).length,
    teluguOptional: items.filter(i => i.item_type === 'TELUGU_VERIFY').length }
}

const fromFile = f => { const dump = JSON.parse(fs.readFileSync(f, 'utf8')); return { dump, applied: dump.mathPlacementsApplied ?? null, prepMs: null, summary: null } }
const off = ANALYSE > -1 ? fromFile(process.argv[ANALYSE + 1]) : await prepared(false)
const on = ANALYSE > -1 ? fromFile(process.argv[ANALYSE + 2]) : await prepared(true)
const RESULT_FILE = ANALYSE > -1 ? process.argv[ANALYSE + 3] : `${OUT}/benchmark.json`
if (ANALYSE < 0) {
  fs.writeFileSync(`${OUT}/dump-decoder-off.json`, JSON.stringify(off.dump))
  fs.writeFileSync(`${OUT}/dump-decoder-on.json`, JSON.stringify(on.dump))
}

const U0 = units(off.dump), U1 = units(on.dump)
const withTelugu = [...U1.values()].filter(u => u.crop?.detection_detail?.decoder)
const dec = u => u.crop?.detection_detail?.decoder
const decStatus = count(withTelugu, u => (dec(u).status === 'REFUSED' ? `REFUSED:${dec(u).reason}` : dec(u).status))
const agree = withTelugu.filter(u => dec(u).agree === true), disagree = withTelugu.filter(u => dec(u).agree === false)
const highDisagree = disagree.filter(u => dec(u).verdictBefore === 'HIGH')

// Attribution: which units changed blocking status between OFF and ON, and why.
const blocking = u => !!(u?.item && open(u.item) && u.item.blocking)
const removed = [], added = []
for (const [k, u1] of U1) {
  const u0 = U0.get(k)
  if (blocking(u0) && !blocking(u1)) removed.push({ key: k, reasonsBefore: u0.item.machine_reasons, reasonsNow: u1.item?.machine_reasons ?? null })
  if (!blocking(u0) && blocking(u1)) added.push({ key: k, reasons: u1.item.machine_reasons, ocr: u1.crop?.detection_detail?.ocrText ?? null, suggestion: dec(u1)?.suggestion ?? null })
}
// Safety: stored content is ALWAYS the OCR text (a suggestion never becomes content).
const silentReplacement = [...U1.values()].filter(u => u.row.content != null && u.crop?.detection_detail && u.row.content !== u.crop.detection_detail.ocrText).map(u => u.key)
const suggestionAsContent = disagree.filter(u => u.row.content != null && u.row.content === dec(u).suggestion).map(u => u.key)

// Suggestions shown to the teacher: open blocking Telugu items carrying a decoder suggestion.
const suggestions = [...U1.values()].filter(u => open(u.item) && u.item.blocking && u.item.detail?.decoder?.suggestion)
const judgements = new Map(JSON.parse(fs.readFileSync('reports/b484a2/proposal-judgements.json', 'utf8')).rows.map(r => [r.unit, r]))
const proposalRows = new Map(JSON.parse(fs.readFileSync('reports/b484a2/proposal-rows.json', 'utf8')).map(r => [r.unit, r]))
const judge = u => {
  const j = judgements.get(u.key), p = proposalRows.get(u.key)
  if (!j || !p || p.dec !== u.item.detail.decoder.suggestion) return 'UNJUDGED'
  return j.decoderCorrect ? 'CORRECT' : 'WRONG'
}
const suggestionJudgement = count(suggestions, judge)

// The 71 B4.8.4A exceptions.
const exceptions = JSON.parse(fs.readFileSync('reports/b484a2/product-impact.json', 'utf8')).exceptions
const exceptionRows = exceptions.map(e => {
  const u = U1.get(e.unit)
  if (!u) return { unit: e.unit, cat: e.cat, fate: 'NOT_FOUND' }
  const d = dec(u), s = open(u.item) && u.item.blocking ? u.item.detail?.decoder?.suggestion : null
  const fate = s ? `SUGGESTED_${judge(u)}` : d?.agree === true ? 'OCR_CONFIRMED_BY_AGREEMENT_STILL_BLOCKING' : !open(u.item) || !u.item.blocking ? 'NOT_BLOCKING' : 'UNRESOLVED'
  return { unit: e.unit, cat: e.cat, fate, decoder: d?.status === 'REFUSED' ? `REFUSED:${d.reason}` : d?.status, ocr: u.crop?.detection_detail?.ocrText ?? null, suggestion: s }
})

const vidikadu = ['1:OPTIONA', '53:OPTIOND', '60:OPTIOND'].map(k => { const u = U1.get(k); return { unit: k, ocr: u?.crop?.detection_detail?.ocrText, verdictBefore: dec(u)?.verdictBefore ?? u?.row.ocr_verdict,
  suggestion: dec(u)?.suggestion ?? null, item: u?.item?.item_type, blocking: u?.item?.blocking } })

const result = {
  generated: new Date().toISOString(),
  environment: ANALYSE > -1 ? process.argv[ANALYSE + 4] : 'local throwaway PostgreSQL (full KSC chain), Node platform, production orchestrator; 21 simulated-teacher math values applied',
  baselineRecorded: { blocking: 313, optional: 407, READY: 64, QUICK_CHECK: 121, MANUAL_REVIEW: 15, note: 'B4.8.3C/B4.8.4A accepted state (browser-prepared)' },
  decoderOff: { ...headline(off.dump), mathPlacementsApplied: off.applied, prepSeconds: off.prepMs == null ? null : Math.round(off.prepMs / 1000) },
  decoderOn: { ...headline(on.dump), mathPlacementsApplied: on.applied, prepSeconds: on.prepMs == null ? null : Math.round(on.prepMs / 1000), timingsMs: on.summary?.timingsMs ?? null },
  decoder: {
    teluguUnits: withTelugu.length, status: decStatus,
    coverage: +(withTelugu.filter(u => dec(u).status === 'DECODED').length / withTelugu.length).toFixed(3),
    agreements: agree.length, agreementsRouted: withTelugu.filter(u => (u.row.ocr_review_reasons || []).includes('OCR_DECODER_AGREE')).length,
    disagreements: disagree.length, highDisagreements: highDisagree.length,
    highDisagreementsBlocking: highDisagree.filter(u => blocking(u)).length,
    highDisagreementList: highDisagree.map(u => ({ unit: u.key, ocr: u.crop.detection_detail.ocrText, suggestion: dec(u).suggestion, item: u.item?.item_type, blocking: blocking(u) })),
  },
  invalidSequence: { units: [...U1.values()].filter(u => (u.row.ocr_review_reasons || []).includes('INVALID_TELUGU_SEQUENCE')).map(u => u.key) },
  attribution: { confidenceOnlyBlockersRemoved: removed.length, removedByReason: count(removed, r => (r.reasonsNow || []).join('+')), newSafetyBlockers: added.length,
    addedByReason: count(added, a => a.reasons.filter(r => !['MEDIUM', 'LOW', 'HIGH'].includes(r)).join('+')), added, removed },
  suggestions: { count: suggestions.length, judgedAgainstA2: suggestionJudgement },
  exceptions71: { fates: count(exceptionRows, r => r.fate), rows: exceptionRows },
  vidikadu,
  safety: { silentReplacement, suggestionAsContent, confirmedAnswers: headline(on.dump).confirmedAnswers },
}
fs.writeFileSync(RESULT_FILE, JSON.stringify(result, null, 1))
console.log(JSON.stringify({ ...result, decoder: { ...result.decoder, highDisagreementList: result.decoder.highDisagreementList.length }, attribution: { ...result.attribution, added: undefined, removed: undefined },
  exceptions71: result.exceptions71.fates }, null, 1))
process.exit(0)
