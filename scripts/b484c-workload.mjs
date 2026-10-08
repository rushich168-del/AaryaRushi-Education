// B4.8.4C — teacher-workload measurement over a persisted golden Draft dump (read-only).
//
//   node scripts/b484c-workload.mjs <dump.json> [out.json]
//
// Uses the SAME pure view models as the Review Center (draftReviewModel.js + teluguReviewModel.js), so the
// lane/decision counts are what the page shows. Action counts are exact for the given state; minutes use the
// stated per-action ASSUMPTIONS (a timed pilot with a real teacher should replace them).
import fs from 'node:fs'
import { indexDraft, isOpen, summarize } from '../src/services/draftReviewModel.js'
import { buildTeluguReview, laneCounts, UNIT_TYPES } from '../src/services/teluguReviewModel.js'

export function flatten(d) {
  return {
    paper: d.paper, questions: d.questions.map(q => q.row),
    options: d.questions.flatMap(q => (q.options || []).map(o => o.row)),
    questionTexts: d.questions.flatMap(q => q.texts), optionTexts: d.questions.flatMap(q => (q.options || []).flatMap(o => o.texts)),
    media: [...d.questions.flatMap(q => q.media), ...d.materials.flatMap(m => m.media)],
    materials: d.materials.map(m => m.row), materialTexts: d.materialTexts || [], items: d.reviewItems, readiness: d.readiness,
  }
}

// Seconds per action (ASSUMPTIONS, low-high). The item-level baseline is B4.8.4A's 80–190 min for 299 items.
export const SECONDS = {
  itemLevel: [16, 38],          // today's item-by-item queue, incl. navigation back to the list
  quickUnit: [5, 10],           // one unit read + Enter inside the question view (no navigation)
  quickQuestion: [8, 15],       // a whole confidence-only question, one "Looks correct"
  choice: [10, 20],             // compare current vs suggestion / printed digits, one key
  repeated: [5, 10],            // one repeated printed unit, verified once
  edit: [30, 75],               // genuine exception: type or correct
  passageType: [120, 300], passageCheck: [30, 90],
}
const mins = (plan) => {
  const lo = Object.entries(plan).reduce((s, [k, n]) => s + n * SECONDS[k][0], 0) / 60
  const hi = Object.entries(plan).reduce((s, [k, n]) => s + n * SECONDS[k][1], 0) / 60
  return [Math.round(lo), Math.round(hi)]
}

export function workload(dump) {
  const ix = indexDraft(flatten(dump))
  const s = summarize(ix)
  const review = buildTeluguReview(ix)
  const lanes = laneCounts(review)
  const openTeluguBlocking = ix.items.filter(i => isOpen(i) && i.blocking && (UNIT_TYPES.has(i.item_type) || i.item_type === 'MATERIAL_TELUGU'))
  const units = review.questions.flatMap(q => q.openUnits.map(u => ({ ...u, q })))
  const blockingUnits = units.filter(u => u.blocking)
  const exceptionUnits = blockingUnits.filter(u => u.lane === 'exception')
  const quickUnits = blockingUnits.filter(u => u.lane === 'quick')
  const issueTally = {}
  for (const u of exceptionUnits) for (const i of u.issues) issueTally[i.code] = (issueTally[i.code] || 0) + 1
  const withSuggestion = exceptionUnits.filter(u => u.suggestion)
  const digitOneClick = exceptionUnits.filter(u => u.digitRepair?.oneClick)
  const digitPrefill = exceptionUnits.filter(u => u.digitRepair && !u.digitRepair.oneClick)
  const choiceOnly = exceptionUnits.filter(u => u.suggestion || u.digitRepair?.oneClick)
  const needsTyping = exceptionUnits.filter(u => !(u.suggestion || u.digitRepair?.oneClick))
  const passagesOpen = review.passages.filter(p => p.open).length

  // Repeated identical source: groups with >= 2 open BLOCKING members (one decision would cover them all).
  const openByFp = new Map()
  for (const u of blockingUnits) if (u.repeat?.fp) { if (!openByFp.has(u.repeat.fp)) openByFp.set(u.repeat.fp, []); openByFp.get(u.repeat.fp).push(u) }
  const repeatedGroups = [...openByFp.values()].filter(g => g.length > 1)
  const coveredByRepeat = new Set(repeatedGroups.flat().map(u => u.id))

  // A. Today (B4.8.4B item queue): one decision per blocking Telugu item; passages typed.
  const before = { decisions: openTeluguBlocking.length, plan: { itemLevel: openTeluguBlocking.length - passagesOpen, passageType: passagesOpen } }
  // B. This build (no migration): same decisions (each an atomic single-item RPC), but in the question view:
  //    confidence-only units one Enter each, choices one key, typing only where nothing better exists.
  const thisBuild = { decisions: blockingUnits.length + passagesOpen,
    plan: { quickUnit: quickUnits.length, choice: choiceOnly.length, edit: needsTyping.length, passageType: passagesOpen } }
  // C. After the proposed migration 0033: one atomic "Looks correct" per question for its confidence-only
  //    units; one decision per repeated printed unit; passages OCR'd and checked once.
  let qLooks = 0, exc = 0, choice = 0
  for (const q of review.questions) {
    const open = q.openUnits.filter(u => u.blocking && !coveredByRepeat.has(u.id))
    const e = open.filter(u => u.lane === 'exception')
    exc += e.filter(u => !(u.suggestion || u.digitRepair?.oneClick)).length
    choice += e.filter(u => u.suggestion || u.digitRepair?.oneClick).length
    if (open.some(u => u.lane === 'quick')) qLooks++
  }
  const after0033 = { decisions: qLooks + exc + choice + repeatedGroups.length + passagesOpen,
    plan: { quickQuestion: qLooks, choice, edit: exc, repeated: repeatedGroups.length, passageCheck: passagesOpen } }
  for (const x of [before, thisBuild, after0033]) x.minutes = mins(x.plan)

  const readiness = {}
  for (const r of ix.readinessByQuestion.values()) readiness[r.readiness] = (readiness[r.readiness] || 0) + 1
  return {
    state: { questions: s.totalQuestions, blocking: s.blockingOpen, optional: s.optionalOpen, readiness, confirmedAnswers: ix.options.filter(o => o.is_confirmed_correct).length },
    telugu: { blockingItems: openTeluguBlocking.length, affectedQuestions: new Set(openTeluguBlocking.flatMap(i => i.draft_material_id
      ? (ix.questionsByMaterial.get(i.draft_material_id) || []).map(q => q.id) : [ix.optionById.get(i.draft_option_id)?.draft_question_id || i.draft_question_id])).size },
    lanes, units: { blocking: blockingUnits.length, quick: quickUnits.length, exception: exceptionUnits.length, optionalOpen: units.filter(u => !u.blocking).length },
    exceptionIssues: issueTally,
    suggestionDecisions: withSuggestion.length, highDisagreements: exceptionUnits.filter(u => u.content.crop?.detection_detail?.decoder?.verdictBefore === 'HIGH').length,
    digitRepairs: { oneClick: digitOneClick.length, prefillEditor: digitPrefill.length,
      list: [...digitOneClick, ...digitPrefill].map(u => ({ q: u.q.number, unit: u.label, from: u.digitRepair.before, to: u.digitRepair.after, oneClick: u.digitRepair.oneClick })) },
    repeated: { groupsInPaper: review.repeated.length, unitsInPaper: review.repeated.reduce((n, g) => n + g.members.length, 0),
      groupsWithOpenBlocking: repeatedGroups.length, blockingUnitsCovered: coveredByRepeat.size,
      list: repeatedGroups.map(g => ({ count: g.length, places: g.map(u => `Q${u.q.number} ${u.label}`), readings: [...new Set(g.map(u => u.content.current))] })) },
    passages: { open: passagesOpen, total: review.passages.length },
    actions: { before, thisBuild, after0033 },
    assumptionsSeconds: SECONDS,
  }
}

if (String(process.argv[1] ?? '').replace(/\\/g, '/').endsWith('scripts/b484c-workload.mjs')) {
  const [dumpFile, outFile] = process.argv.slice(2)
  if (!dumpFile) { console.error('usage: node scripts/b484c-workload.mjs <dump.json> [out.json]'); process.exit(2) }
  const w = workload(JSON.parse(fs.readFileSync(dumpFile, 'utf8')))
  if (outFile) fs.writeFileSync(outFile, JSON.stringify({ generated: new Date().toISOString(), dump: dumpFile, ...w }, null, 1))
  console.log(JSON.stringify({ ...w, digitRepairs: { ...w.digitRepairs, list: w.digitRepairs.list.length }, repeated: { ...w.repeated, list: w.repeated.list.slice(0, 12) } }, null, 1))
}
