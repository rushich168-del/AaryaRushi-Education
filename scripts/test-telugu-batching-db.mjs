// B4.8.4C — migration 0033 (Telugu teacher-work compression) on THROWAWAY local PostgreSQL clusters with the full
// KSC chain and fresh golden preparations through the production orchestrator. Never touches Supabase.
//
// Covers: forward-only (0017-0032 unchanged) + read-only verify SQL; migration over an older (0032) Draft with
// teacher work; owner-only RPCs (other teacher, student, anonymous), no direct writes, frozen source evidence;
// question verification (stale, atomic refusal, idempotent double click, text + answers invariant);
// repeated identical source (verify / correct, one stale occurrence never overwritten, forged occurrence,
// correction history, retry); shared-passage OCR proposal -> accept / edit, write-once OCR history;
// append-only evidence and its classes; re-preparation protection; paper deletion.
// Decisions here are SIMULATED test inputs, not teacher evidence.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import crypto, { randomUUID } from 'node:crypto'
import { createLocalKscDb, prepareGoldenDraft, createImport, GOLDEN_PDF } from './lib/local-draft-db.mjs'
import { readDraftFlatAs } from './lib/local-pg-api.mjs'
import { indexDraft, teluguContent, isOpen } from '../src/services/draftReviewModel.js'

const skip = !fs.existsSync(GOLDEN_PDF) && 'golden PDF not available'
const MIGRATION = '202609250033_draft_telugu_review_batching.sql'
const VERIFY_SQL = 'docs/ksc/deploy/B4-07-0033-VERIFY-READONLY.sql'
let db, paperId, student, answersAtStart
const report = {}

const rpc = (uid, name, args) => db.runner.rpc(uid, name, args)
const asT = fn => db.runner.asUser(db.teacher, fn)
const q1 = async (sql, params = []) => (await db.pool.query(sql, params)).rows
const TELUGU = ['TELUGU_STEM', 'TELUGU_OPTION', 'TELUGU_VERIFY']
const CONFIDENCE = new Set(['MEDIUM', 'LOW', 'OCR_DECODER_AGREE', 'OCR_CONFIDENCE_MEDIUM', 'OCR_CONFIDENCE_LOW', 'OCR_HIGH_CONFIDENCE_UNVERIFIED'])
const items = async () => q1(`SELECT i.*, coalesce(i.draft_question_id, o.draft_question_id) AS qid, m.detection_detail->>'sourceFp' AS fp
  FROM draft_review_items i LEFT JOIN draft_options o ON o.id = i.draft_option_id LEFT JOIN draft_media m ON m.id = i.source_media_id
  WHERE i.draft_paper_id = $1 ORDER BY i.item_key`, [paperId])
const ownerOf = i => (i.target_question_text_id ? 'QUESTION' : 'OPTION')
const rowOf = i => i.target_question_text_id || i.target_option_text_id
const view = async i => (await q1('SELECT public.ksc_telugu_unit_view($1, $2, $3) v', [ownerOf(i), rowOf(i), paperId]))[0].v
const occ = async list => Promise.all(list.map(async i => ({ item_id: i.id, expected: await view(i) })))
const textRow = async i => (await q1(`SELECT * FROM ${ownerOf(i) === 'QUESTION' ? 'draft_question_texts' : 'draft_option_texts'} WHERE id = $1`, [rowOf(i)]))[0]
const eligible = i => i.status !== 'RESOLVED' && TELUGU.includes(i.item_type) && i.machine_reasons.length && i.machine_reasons.every(r => CONFIDENCE.has(r)) && i.detail?.decoder?.agree !== false
const answers = async () => q1(`SELECT o.id, o.is_proposed_correct, o.is_confirmed_correct, o.marker, o.position, o.content FROM draft_options o
  JOIN draft_questions q ON q.id = o.draft_question_id WHERE q.draft_paper_id = $1 ORDER BY o.id`, [paperId])
const teacherWork = async () => (await asT(c => c.query('SELECT public.ksc_draft_has_teacher_work($1) t', [paperId]))).rows[0].t
const decisions = async () => q1('SELECT * FROM draft_telugu_decisions WHERE draft_paper_id = $1 ORDER BY decided_at, id', [paperId])
const logItems = async (decisionId) => q1('SELECT * FROM draft_telugu_decision_items WHERE decision_id = $1 ORDER BY id', [decisionId])
const used = new Set()   // items consumed by one test, never reused by another

before(async () => {
  if (skip) return
  db = await createLocalKscDb()
  const prep = await prepareGoldenDraft(db)
  paperId = prep.draftPaperId
  student = randomUUID()
  await db.pool.query(`INSERT INTO auth.users (id, email, role) VALUES ($1, 'student@ksc.local', 'authenticated')`, [student])
  answersAtStart = await answers()
})
after(async () => {
  if (db) { fs.mkdirSync('reports/b484c', { recursive: true }); fs.writeFileSync('reports/b484c/db-test-report.json', JSON.stringify(report, null, 1)) }
  await db?.stop()
})

test('0033 is forward-only: 0017-0032 unchanged; no Exam Engine / answer writes; verify SQL all PASS on a fresh chain', { skip }, async () => {
  const locked = {
    '202609220017_draft_paper_foundation.sql': '255c022d8febdc3ed6d49f3dad99b4ca306aaf97443562914c285512d26b5eba',
    '202609220022_draft_language_texts.sql': 'c89c8c13c6abcc6ee6f6622f67f3fcba510ff061963bf90d88e9376bde70c90a',
    '202609230026_draft_shared_materials.sql': '57e5774e840f7c1dfa1d3cdfedfe3593085cfa13f4b8399ceb2a3d4b1f7d8f36',
    '202609230027_draft_review_items.sql': 'd26d5457463fbbdceb8fd8b5d1212627db95064c946cc759ff83491d76673a17',
    '202609230028_draft_language_history_protection.sql': '03849731c2db96337b03793eb7a1f2fe7120fd4a19a5b8f895ffd74dd3ebdc0e',
    '202609240031_draft_review_item_reconciliation.sql': '12ecc8eb61284a14037d7e9f4a7026adb30cf90112a2d68e2a1ecefe854e3804',
    '202609250032_draft_math_image_recovery.sql': 'dff0ea52e6b1cccde06e84513fce3994f0e039fe054bafc2e5b8f9a28b96457a',
  }   // the full 0017-0031 list is locked in test-paper-preparation-db
  for (const [f, h] of Object.entries(locked)) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(`supabase/migrations/${f}`)).digest('hex'), h, f)
  const sql = fs.readFileSync(`supabase/migrations/${MIGRATION}`, 'utf8').replace(/--.*$/gm, '')
  for (const forbidden of ['publish_test', 'test_attempts', 'attempt_answers', 'question_bank', 'test_question_snapshots', 'is_confirmed_correct =', 'is_proposed_correct =',
    'UPDATE public.draft_options', 'UPDATE public.draft_questions', 'storage.objects'])
    assert.ok(!sql.includes(forbidden), `0033 must not reference ${forbidden}`)
  report.sha256 = crypto.createHash('sha256').update(fs.readFileSync(`supabase/migrations/${MIGRATION}`)).digest('hex')
  const fresh = await createLocalKscDb()
  try {
    const verify = (await fresh.pool.query(fs.readFileSync(VERIFY_SQL, 'utf8'))).rows
    assert.ok(verify.length >= 12 && verify.every(r => r.result === 'PASS'), JSON.stringify(verify.filter(r => r.result !== 'PASS')))
    report.verifySql = verify.map(r => `${r.result} ${r.check_name}`)
  } finally { await fresh.stop() }
})

test('fresh preparation: passage OCR is stored as an unverified proposal and is NOT teacher work', { skip }, async () => {
  const texts = await q1(`SELECT mx.* FROM draft_material_texts mx JOIN draft_materials m ON m.id = mx.draft_material_id WHERE m.draft_paper_id = $1`, [paperId])
  assert.equal(texts.length, 10)
  for (const t of texts) {
    assert.equal(t.source, 'AUTO_OCR'); assert.equal(t.verification_state, null); assert.ok(t.ocr_original_content && t.ocr_engine && t.ocr_version)
    assert.ok(t.text_quality === 'MISSING' ? t.content === null : t.content === t.ocr_original_content)
  }
  const passageItems = (await items()).filter(i => i.item_type === 'MATERIAL_TELUGU')
  assert.equal(passageItems.length, 10)
  assert.ok(passageItems.every(i => i.blocking && i.machine_reasons[0] === 'TELUGU_MATERIAL_OCR_PROPOSAL'))
  assert.equal(await teacherWork(), false, 'automatic OCR proposals are not teacher work')
  assert.equal((await decisions()).length, 0)
  report.passages = texts.map(t => `${t.text_quality} ${t.ocr_verdict}`)
})

test('the server shows the teacher exactly what the Review Center shows (expected-text parity)', { skip }, async () => {
  const ix = indexDraft({ ...(await readDraftFlatAs(db.runner, db.teacher, paperId)), items: await items(),
    readiness: await q1('SELECT * FROM draft_question_readiness WHERE draft_paper_id = $1', [paperId]) })
  let n = 0
  for (const i of ix.items.filter(x => isOpen(x) && TELUGU.includes(x.item_type))) {
    assert.equal(await view(i), teluguContent(ix, i).current, i.item_key); n++
  }
  report.parityChecked = n
})

test('security: owner teacher only; no direct evidence writes; frozen source evidence; OCR history immutable', { skip }, async () => {
  const all = await items()
  const q = all.find(eligible)
  const args = { p_question_id: q.qid, p_items: await occ([q]), p_note: null }
  await assert.rejects(rpc(db.otherTeacher, 'ksc_verify_question_telugu', args), /not found or unauthorized/)
  await assert.rejects(rpc(student, 'ksc_verify_question_telugu', args), /Teacher access required/)
  await assert.rejects(rpc(null, 'ksc_verify_question_telugu', args), /permission denied/)
  const g = all.find(i => i.fp)
  const src = { p_draft_paper_id: paperId, p_fingerprint: g.fp, p_mode: 'VERIFY_SOURCE_AS_CORRECT', p_text: 'తెలుగు', p_occurrences: await occ([g]), p_note: null }
  await assert.rejects(rpc(db.otherTeacher, 'ksc_apply_telugu_source_decision', src), /not found or unauthorized/)
  await assert.rejects(rpc(null, 'ksc_apply_telugu_source_decision', src), /permission denied/)
  const p = all.find(i => i.item_type === 'MATERIAL_TELUGU')
  await assert.rejects(rpc(db.otherTeacher, 'ksc_resolve_shared_passage', { p_item_id: p.id, p_action: 'ACCEPT', p_expected: 'x' }), /not found or unauthorized/)
  await assert.rejects(rpc(student, 'ksc_resolve_shared_passage', { p_item_id: p.id, p_action: 'ACCEPT', p_expected: 'x' }), /Teacher access required/)
  for (const t of ['draft_telugu_decisions', 'draft_telugu_decision_items']) {
    await assert.rejects(db.runner.asUser(null, c => c.query(`SELECT * FROM public.${t}`)), /permission denied/)
    assert.equal((await db.runner.asUser(student, c => c.query(`SELECT * FROM public.${t}`))).rows.length, 0)
    await assert.rejects(asT(c => c.query(`INSERT INTO public.${t} (draft_paper_id) VALUES ($1)`, [paperId])), /permission denied/)
    await assert.rejects(asT(c => c.query(`UPDATE public.${t} SET draft_paper_id = draft_paper_id`)), /permission denied/)
    await assert.rejects(asT(c => c.query(`DELETE FROM public.${t}`)), /permission denied/)
  }
  await assert.rejects(asT(c => c.query('UPDATE public.draft_material_texts SET content = $1', ['x'])), /permission denied/)
  await assert.rejects(rpc(db.teacher, 'ksc_open_telugu_decision', { p_paper: paperId, p_kind: 'UNIT_DECISION', p_question: null, p_material: null, p_fp: null,
    p_old: null, p_new: null, p_items: [], p_note: null }), /permission denied/)
  // A teacher cannot re-point a crop's fingerprint (the evidence propagation trusts).
  await assert.rejects(asT(c => c.query(`UPDATE public.draft_media SET detection_detail = detection_detail || '{"sourceFp":"tg1:000000000000000000000000"}'::jsonb WHERE id = $1`, [g.source_media_id])),
    /KSC_SOURCE_EVIDENCE_READ_ONLY/)
  // OCR history is write-once even for a database administrator's direct write.
  await assert.rejects(q1(`UPDATE draft_material_texts SET ocr_original_content = 'మార్పు' WHERE draft_material_id = $1`, [p.draft_material_id]), /KSC_OCR_HISTORY_PROTECTED/)
  await assert.rejects(q1(`DELETE FROM draft_material_texts WHERE draft_material_id = $1`, [p.draft_material_id]), /KSC_OCR_HISTORY_PROTECTED/)
  await assert.rejects(q1(`INSERT INTO draft_material_texts (draft_material_id, language, content, text_quality, source, ocr_original_content, ocr_engine, ocr_version, created_by)
    SELECT id, 'xx', 'అ', 'OCR_EXTRACTED', 'AUTO_OCR', 'అ', 'e', 'v', $2 FROM draft_materials WHERE draft_paper_id = $1 LIMIT 1`, [paperId, db.teacher]), /KSC_MATERIAL_OCR_WRITER_ONLY/)
  assert.equal((await decisions()).length, 0, 'refused calls leave no evidence')
  assert.equal(await teacherWork(), false)
})

test('question verification: stale view and one ineligible unit each resolve NOTHING; then one atomic decision; double click is idempotent', { skip }, async () => {
  const all = await items()
  const byQ = new Map()
  for (const i of all.filter(eligible)) { if (!byQ.has(i.qid)) byQ.set(i.qid, []); byQ.get(i.qid).push(i) }
  const [qid, units] = [...byQ.entries()].filter(([, us]) => us.length >= 2).sort((a, b) => b[1].length - a[1].length)[0]
  const intruder = all.find(i => i.qid !== qid && i.status !== 'RESOLVED' && i.machine_reasons.includes('OCR_DECODER_DISAGREE'))
  const sameQExc = all.find(i => i.qid === qid && i.status !== 'RESOLVED' && TELUGU.includes(i.item_type) && !eligible(i))
  const good = await occ(units)
  const before = await Promise.all(units.map(textRow))
  // Stale: one unit's text changed since the page was loaded.
  await assert.rejects(rpc(db.teacher, 'ksc_verify_question_telugu', { p_question_id: qid, p_items: good.map((o, k) => k ? o : { ...o, expected: `${o.expected} x` }), p_note: null }), /KSC_STALE_VIEW/)
  // Atomic refusal: an item of another question, or an ineligible unit of this question.
  await assert.rejects(rpc(db.teacher, 'ksc_verify_question_telugu', { p_question_id: qid, p_items: [...good, ...(await occ([intruder]))], p_note: null }), /KSC_ITEM_NOT_OF_QUESTION/)
  if (sameQExc) await assert.rejects(rpc(db.teacher, 'ksc_verify_question_telugu', { p_question_id: qid, p_items: [...good, ...(await occ([sameQExc]))], p_note: null }), /KSC_ITEM_NOT_ELIGIBLE/)
  const exc = all.find(i => i.status !== 'RESOLVED' && TELUGU.includes(i.item_type) && !eligible(i) && i.machine_reasons.some(r => /DIGIT|NOTATION|INVALID|DISAGREE|EMPTY/.test(r)))
  await assert.rejects(rpc(db.teacher, 'ksc_verify_question_telugu', { p_question_id: exc.qid, p_items: await occ([exc]), p_note: null }), /KSC_ITEM_NOT_ELIGIBLE/)
  const afterRefusals = await items()
  for (const u of units) assert.notEqual(afterRefusals.find(i => i.id === u.id).status, 'RESOLVED', 'nothing resolved by a refused call')
  assert.equal((await decisions()).length, 0)
  // The decision, twice at once (a double click): one resolves, the other sees it done.
  const call = () => rpc(db.teacher, 'ksc_verify_question_telugu', { p_question_id: qid, p_items: good, p_note: null })
  const [a, b] = await Promise.all([call(), call()])
  const results = [a, b].map(r => r.status).sort()
  assert.deepEqual(results, ['ALREADY_APPLIED', 'RESOLVED'])
  const third = await call()
  assert.equal(third.status, 'ALREADY_APPLIED')
  const ds = await decisions()
  assert.equal(ds.length, 1); assert.equal(ds[0].decision_kind, 'QUESTION_VERIFY'); assert.equal(ds[0].draft_question_id, qid)
  assert.deepEqual([...ds[0].item_ids].sort(), units.map(u => u.id).sort(), 'the decision names exactly the resolved items')
  const logged = await logItems(ds[0].id)
  assert.deepEqual(logged.map(l => l.review_item_id).sort(), units.map(u => u.id).sort())
  assert.ok(logged.every(l => l.evidence_class === 'QUESTION_ACCEPTED_UNCHANGED' && l.outcome === 'RESOLVED' && l.actor === db.teacher))
  const afterRows = await Promise.all(units.map(textRow))
  for (const [k, u] of units.entries()) {
    assert.equal(await view(u), good[k].expected, 'Telugu text never altered')
    assert.equal(afterRows[k].verification_state, 'VERIFIED_OCR')
    if (before[k].text_quality === 'OCR_EXTRACTED') assert.equal(afterRows[k].content, before[k].content)
  }
  assert.deepEqual(await answers(), answersAtStart, 'answers untouched')
  assert.equal(await teacherWork(), true)
  units.forEach(u => used.add(u.id))
  report.questionVerify = { question: qid, items: units.length, reasons: units.map(u => u.machine_reasons.join('+')), concurrent: results }
})

test('repeated identical source: correct once; a stale occurrence is never overwritten and is reported; retry is idempotent; forged occurrence refused', { skip }, async () => {
  const all = (await items()).filter(i => !used.has(i.id))
  const groups = new Map()
  for (const i of all.filter(i => i.fp && i.status !== 'RESOLVED' && TELUGU.includes(i.item_type))) { if (!groups.has(i.fp)) groups.set(i.fp, []); groups.get(i.fp).push(i) }
  const withViews = await Promise.all([...groups.entries()].filter(([, g]) => g.length >= 3).map(async ([fp, g]) => ({ fp, g, views: await Promise.all(g.map(view)) })))
  const pick = withViews.filter(x => new Set(x.views).size > 1).sort((a, b) => b.g.length - a.g.length)[0]
  assert.ok(pick, 'a repeated print read differently in >= 3 places exists')
  // The teacher's corrected reading (a test value: the most common reading plus nothing invented).
  const counts = {}; for (const v of pick.views) counts[v] = (counts[v] || 0) + 1
  const text = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]
  const occs = pick.g.map((i, k) => ({ item_id: i.id, expected: pick.views[k] }))
  const staleIdx = pick.views.findIndex(v => v !== text)
  const sent = occs.map((o, k) => (k === staleIdx ? { ...o, expected: `${o.expected} (old view)` } : o))
  // Forged: an item of another print joins -> nothing happens at all.
  const other = all.find(i => i.fp && i.fp !== pick.fp && i.status !== 'RESOLVED')
  await assert.rejects(rpc(db.teacher, 'ksc_apply_telugu_source_decision', { p_draft_paper_id: paperId, p_fingerprint: pick.fp, p_mode: 'CORRECT_SOURCE_TEXT', p_text: text,
    p_occurrences: [...sent, ...(await occ([other]))], p_note: null }), /KSC_OCCURRENCE_NOT_OF_FINGERPRINT/)
  await assert.rejects(rpc(db.teacher, 'ksc_apply_telugu_source_decision', { p_draft_paper_id: paperId, p_fingerprint: 'tg1:000000000000000000000000', p_mode: 'CORRECT_SOURCE_TEXT',
    p_text: text, p_occurrences: sent, p_note: null }), /KSC_OCCURRENCE_NOT_OF_FINGERPRINT/)
  assert.equal((await decisions()).filter(d => d.source_fingerprint).length, 0)
  const beforeStale = await textRow(pick.g[staleIdx])
  const res = await rpc(db.teacher, 'ksc_apply_telugu_source_decision', { p_draft_paper_id: paperId, p_fingerprint: pick.fp, p_mode: 'CORRECT_SOURCE_TEXT', p_text: text, p_occurrences: sent, p_note: null })
  const byId = new Map(res.occurrences.map(o => [o.item_id, o]))
  assert.equal(byId.get(pick.g[staleIdx].id).outcome, 'CONFLICT'); assert.equal(byId.get(pick.g[staleIdx].id).reason, 'STALE_VIEW')
  assert.deepEqual(await textRow(pick.g[staleIdx]), beforeStale, 'the stale occurrence is untouched')
  for (const [k, i] of pick.g.entries()) {
    if (k === staleIdx) continue
    const o = byId.get(i.id)
    assert.equal(o.outcome, pick.views[k] === text ? 'VERIFIED' : 'CORRECTED')
    const row = await textRow(i)
    assert.equal(row.content, text)
    if (o.outcome === 'CORRECTED') { assert.equal(row.verification_state, 'EDITED_FROM_OCR'); assert.equal(row.ocr_original_content, pick.views[k], 'the OCR reading is kept') }
  }
  const [d] = (await decisions()).filter(x => x.source_fingerprint === pick.fp)
  assert.equal(d.decision_kind, 'CORRECT_SOURCE_TEXT'); assert.equal(d.new_text, text); assert.equal(d.actor, db.teacher); assert.ok(d.decided_at)
  assert.deepEqual([...d.item_ids].sort(), pick.g.map(i => i.id).sort(), 'every affected occurrence is named')
  const logged = await logItems(d.id)
  assert.equal(logged.length, pick.g.length, 'one evidence row per occurrence')
  const stale = logged.find(l => l.review_item_id === pick.g[staleIdx].id)
  assert.equal(stale.outcome, 'CONFLICT'); assert.equal(stale.reason, 'STALE_VIEW'); assert.equal(stale.evidence_class, 'NONE')
  for (const l of logged.filter(l => l.outcome === 'RESOLVED')) {
    assert.ok(['REPEATED_SOURCE_VERIFIED', 'REPEATED_SOURCE_CORRECTED'].includes(l.evidence_class)); assert.equal(l.text_after, text); assert.equal(l.source_fingerprint, pick.fp)
  }
  // Retry with the teacher's fresh view: the applied ones are idempotent, the stale one now applies.
  const fresh = await Promise.all(pick.g.map(async i => ({ item_id: i.id, expected: await view(i) })))
  const retry = await rpc(db.teacher, 'ksc_apply_telugu_source_decision', { p_draft_paper_id: paperId, p_fingerprint: pick.fp, p_mode: 'CORRECT_SOURCE_TEXT', p_text: text, p_occurrences: fresh, p_note: null })
  const rb = new Map(retry.occurrences.map(o => [o.item_id, o.outcome]))
  assert.ok(pick.g.filter((_, k) => k !== staleIdx).every(i => rb.get(i.id) === 'ALREADY_APPLIED'))
  assert.equal(rb.get(pick.g[staleIdx].id), 'CORRECTED')
  const again = await rpc(db.teacher, 'ksc_apply_telugu_source_decision', { p_draft_paper_id: paperId, p_fingerprint: pick.fp, p_mode: 'CORRECT_SOURCE_TEXT', p_text: text, p_occurrences: fresh, p_note: null })
  assert.equal(again.reused, true); assert.ok(again.occurrences.every(o => o.outcome === 'ALREADY_APPLIED'))
  assert.equal((await decisions()).filter(x => x.source_fingerprint === pick.fp).length, 2, 'the idempotent repeat adds no decision')
  pick.g.forEach(i => used.add(i.id))
  // VERIFY mode never corrects: a reading that differs is reported, not overwritten.
  const verifyGroup = withViews.find(x => x !== pick && x.g.every(i => !used.has(i.id)))
  if (verifyGroup) {
    const vtext = verifyGroup.views[0]
    const vr = await rpc(db.teacher, 'ksc_apply_telugu_source_decision', { p_draft_paper_id: paperId, p_fingerprint: verifyGroup.fp, p_mode: 'VERIFY_SOURCE_AS_CORRECT', p_text: vtext,
      p_occurrences: verifyGroup.g.map((i, k) => ({ item_id: i.id, expected: verifyGroup.views[k] })), p_note: null })
    for (const [k, i] of verifyGroup.g.entries()) {
      const o = vr.occurrences.find(x => x.item_id === i.id)
      if (verifyGroup.views[k] === vtext) assert.equal(o.outcome, 'VERIFIED'); else { assert.equal(o.outcome, 'CONFLICT'); assert.equal(o.reason, 'READING_DIFFERS'); assert.equal(await view(i), verifyGroup.views[k]) }
    }
    verifyGroup.g.forEach(i => used.add(i.id))
    report.verifyMode = vr.occurrences.map(o => o.outcome)
  }
  assert.deepEqual(await answers(), answersAtStart)
  report.repeated = { fp: pick.fp, occurrences: pick.g.length, readings: Object.keys(counts).length, first: res.occurrences.map(o => `${o.outcome}${o.reason ? `(${o.reason})` : ''}`),
    retry: retry.occurrences.map(o => o.outcome) }
})

test('shared passage: OCR proposal -> teacher accept / edit once; stale refused; OCR kept; linked questions updated; idempotent', { skip }, async () => {
  const ps = (await items()).filter(i => i.item_type === 'MATERIAL_TELUGU')
  const mt = async i => (await q1(`SELECT * FROM draft_material_texts WHERE draft_material_id = $1 AND language = 'te'`, [i.draft_material_id]))[0]
  const linked = async i => q1(`SELECT r.* FROM draft_question_readiness r JOIN draft_questions q ON q.id = r.draft_question_id WHERE q.shared_material_id = $1`, [i.draft_material_id])
  const [acc, ed, st] = ps
  const accText = await mt(acc)
  await assert.rejects(rpc(db.teacher, 'ksc_resolve_shared_passage', { p_item_id: st.id, p_action: 'ACCEPT', p_expected: 'పాతది' }), /KSC_STALE_VIEW/)
  const beforeLinked = await linked(acc)
  const r1 = await rpc(db.teacher, 'ksc_resolve_shared_passage', { p_item_id: acc.id, p_action: 'ACCEPT', p_expected: accText.ocr_original_content, p_note: null })
  assert.equal(r1.status, 'RESOLVED')
  const a = await mt(acc)
  assert.equal(a.content, accText.ocr_original_content); assert.equal(a.text_quality, 'OCR_EXTRACTED'); assert.equal(a.verification_state, 'VERIFIED_OCR')
  assert.equal(a.verified_by, db.teacher); assert.ok(a.verified_at); assert.equal(a.source, 'AUTO_OCR'); assert.equal(a.ocr_version, accText.ocr_version)
  const afterLinked = await linked(acc)
  for (const q of afterLinked) assert.equal(Number(q.open_blocking), Number(beforeLinked.find(x => x.draft_question_id === q.draft_question_id).open_blocking) - 1, 'each linked question loses the passage blocker')
  const again = await rpc(db.teacher, 'ksc_resolve_shared_passage', { p_item_id: acc.id, p_action: 'ACCEPT', p_expected: accText.ocr_original_content, p_note: null })
  assert.equal(again.status, 'ALREADY_APPLIED')
  const edText = await mt(ed)
  const edited = `${edText.ocr_original_content.split('\n')[0]}\nసవరించిన పంక్తి`
  await rpc(db.teacher, 'ksc_resolve_shared_passage', { p_item_id: ed.id, p_action: 'EDIT', p_expected: edText.ocr_original_content, p_text: edited, p_note: 'test edit' })
  const e = await mt(ed)
  assert.equal(e.content, edited); assert.equal(e.text_quality, 'TEACHER_ENTERED'); assert.equal(e.verification_state, 'EDITED_FROM_OCR')
  assert.equal(e.ocr_original_content, edText.ocr_original_content, 'the OCR proposal is kept beside the teacher text')
  const ds = (await decisions()).filter(d => d.draft_material_id)
  assert.deepEqual(ds.map(d => d.decision_kind), ['PASSAGE_ACCEPT', 'PASSAGE_EDIT'])
  assert.equal(ds[1].old_text, edText.ocr_original_content); assert.equal(ds[1].new_text, edited)
  assert.deepEqual((await logItems(ds[0].id)).map(l => l.evidence_class), ['PASSAGE_ACCEPTED'])
  assert.deepEqual((await logItems(ds[1].id)).map(l => l.evidence_class), ['PASSAGE_EDITED'])
  // The pre-0033 transcription path on an OCR row keeps the OCR and records an edit, never "typed from scratch".
  await rpc(db.teacher, 'ksc_resolve_telugu_review_item', { p_item_id: st.id, p_action: 'EDIT', p_text: 'టైప్ చేసిన పాఠం', p_note: null })
  const s = await mt(st)
  assert.equal(s.verification_state, 'EDITED_FROM_OCR'); assert.ok(s.ocr_original_content)
  report.passageDecisions = ds.map(d => d.decision_kind)
})

test('single-unit decisions are captured as append-only evidence with server-derived classes', { skip }, async () => {
  const all = (await items()).filter(i => !used.has(i.id) && i.status !== 'RESOLVED' && TELUGU.includes(i.item_type))
  const sug = []
  for (const i of all.filter(i => i.detail?.decoder?.agree === false && i.detail.decoder.suggestion)) if (await view(i)) sug.push(i)
  // Printed-digit evidence only where the unit still shows exactly the text the evidence was computed on.
  const pd = []
  for (const i of all.filter(i => i.detail?.printedDigits?.status === 'REPAIRABLE' && !sug.includes(i))) {
    if (((await view(i)).match(/\d+/g) || []).join(' ') === (i.detail.printedDigits.before || []).join(' ')) pd.push(i)
  }
  const plain = all.filter(i => eligible(i))
  const tag = i => `${i.item_key} ${JSON.stringify(i.machine_reasons)} ${i.status}`
  assert.ok(sug.length >= 2 && pd.length >= 2 && plain.length >= 1, `candidates: sug ${sug.length}, printed ${pd.length}, plain ${plain.length}`)
  const revise = (i, text, note = null) => rpc(db.teacher, 'ksc_revise_language_text', { p_text_id: rowOf(i), p_owner: ownerOf(i), p_action: 'REPLACE', p_text: text, p_note: note })
  const cls = async i => (await q1('SELECT evidence_class, outcome FROM draft_telugu_decision_items WHERE review_item_id = $1 ORDER BY id', [i.id])).map(r => r.evidence_class)
  await rpc(db.teacher, 'ksc_resolve_telugu_review_item', { p_item_id: sug[0].id, p_action: 'ACCEPT', p_text: null, p_note: null })
  assert.deepEqual(await cls(sug[0]), ['OCR_KEPT_OVER_SUGGESTION'], `keep over suggestion: ${tag(sug[0])}`)
  await revise(sug[1], sug[1].detail.decoder.suggestion)
  assert.deepEqual(await cls(sug[1]), ['SUGGESTION_ACCEPTED'], `suggestion: ${tag(sug[1])}`)
  await revise(pd[0], pd[0].detail.printedDigits.text)
  assert.deepEqual(await cls(pd[0]), ['PRINTED_DIGITS_USED'], `printed digits: ${tag(pd[0])}`)
  const assisted = pd[1].detail.printedDigits.text.replace(/[అ-హ]/, 'అ')
  await revise(pd[1], assisted === pd[1].detail.printedDigits.text ? `${assisted} అ` : assisted)
  assert.deepEqual(await cls(pd[1]), ['PRINTED_DIGITS_ASSISTED_EDIT'], `assisted: ${tag(pd[1])} ${JSON.stringify(pd[1].detail.printedDigits)}`)
  await revise(plain[0], 'సవరణ')
  assert.deepEqual(await cls(plain[0]), ['TEACHER_EDITED'], `edit: ${tag(plain[0])}`)
  await revise(plain[0], 'మరో సవరణ', 'second thought')            // a later revision of a decided unit
  assert.deepEqual(await cls(plain[0]), ['TEACHER_EDITED', 'REVISED'])
  const units = await q1(`SELECT decision_kind, count(*)::int n FROM draft_telugu_decisions WHERE draft_paper_id = $1 GROUP BY 1`, [paperId])
  assert.ok(units.find(u => u.decision_kind === 'UNIT_DECISION').n >= 5); assert.equal(units.find(u => u.decision_kind === 'REVISION').n, 1)
  // Append-only even for a database administrator.
  await assert.rejects(q1('UPDATE draft_telugu_decision_items SET outcome = outcome'), /APPEND_ONLY/)
  await assert.rejects(q1('DELETE FROM draft_telugu_decisions'), /APPEND_ONLY/)
  const tally = await q1(`SELECT evidence_class, count(*)::int n FROM draft_telugu_decision_items WHERE draft_paper_id = $1 GROUP BY 1 ORDER BY 1`, [paperId])
  report.evidenceClasses = Object.fromEntries(tally.map(t => [t.evidence_class, t.n]))
})

test('re-preparation protection, answers invariant and paper deletion', { skip }, async () => {
  assert.equal(await teacherWork(), true)
  const run = (await q1(`SELECT id FROM draft_analysis_runs WHERE draft_paper_id = $1 AND preparation_state = 'PREPARED'`, [paperId]))[0].id
  await assert.rejects(rpc(db.teacher, 'ksc_replace_review_items', { p_draft_paper_id: paperId, p_run_id: run, p_generator: 'test', p_items: [] }), /KSC_DRAFT_HAS_TEACHER_WORK/)
  await assert.rejects(rpc(db.teacher, 'ksc_replace_auto_material_telugu', { p_draft_paper_id: paperId, p_run_id: run, p_texts: [] }), /KSC_DRAFT_HAS_TEACHER_WORK/)
  assert.deepEqual(await answers(), answersAtStart)
  assert.equal((await answers()).filter(o => o.is_confirmed_correct).length, 0)
  const n = (await q1('SELECT count(*)::int n FROM draft_telugu_decision_items WHERE draft_paper_id = $1', [paperId]))[0].n
  assert.ok(n > 0)
  // Deletion: a small separate paper (deleting the whole prepared golden Draft is governed by earlier migrations).
  const imp = await createImport(db)
  const [{ id: p2 }] = await q1('INSERT INTO draft_papers (source_import_id, created_by) VALUES ($1, $2) RETURNING id', [imp.id, db.teacher])
  const [{ id: d2 }] = await q1(`INSERT INTO draft_telugu_decisions (draft_paper_id, decision_kind, actor) VALUES ($1, 'UNIT_DECISION', $2) RETURNING id`, [p2, db.teacher])
  await q1(`INSERT INTO draft_telugu_decision_items (decision_id, draft_paper_id, review_item_id, item_type, outcome, evidence_class, actor)
    VALUES ($1, $2, gen_random_uuid(), 'TELUGU_STEM', 'RESOLVED', 'OCR_ACCEPTED_UNCHANGED', $3)`, [d2, p2, db.teacher])
  await assert.rejects(q1('DELETE FROM draft_telugu_decision_items WHERE draft_paper_id = $1', [p2]), /APPEND_ONLY/)
  await q1('DELETE FROM draft_papers WHERE id = $1', [p2])          // the evidence goes only with its paper
  assert.equal((await q1('SELECT count(*)::int n FROM draft_telugu_decision_items WHERE draft_paper_id = $1', [p2]))[0].n, 0)
  assert.equal((await q1('SELECT count(*)::int n FROM draft_telugu_decision_items WHERE draft_paper_id = $1', [paperId]))[0].n, n, 'the golden evidence is intact')
  report.evidenceRows = n
})

test('migration over an OLDER (0032) Draft with teacher work: history kept, protection kept, new RPCs work, nothing retroactive', { skip }, async () => {
  const old = await createLocalKscDb({ upTo: '202609250032_draft_math_image_recovery.sql' })
  try {
    // This app build on a database WITHOUT 0033 (live KSC today): preparation still succeeds; passages stay
    // transcription items because the 0033 writer does not exist yet.
    const prep = await prepareGoldenDraft(old)
    assert.equal(prep.summary.passageOcrProposals, 'UNAVAILABLE (0033 not applied)')
    const P = prep.draftPaperId
    const qo = async (sql, p = []) => (await old.pool.query(sql, p)).rows
    const its = await qo(`SELECT i.*, coalesce(i.draft_question_id, o.draft_question_id) qid FROM draft_review_items i LEFT JOIN draft_options o ON o.id = i.draft_option_id
      WHERE i.draft_paper_id = $1 ORDER BY i.item_key`, [P])
    const quick = its.filter(eligible)
    const passage = its.find(i => i.item_type === 'MATERIAL_TELUGU')
    // Teacher work made before 0033: one Telugu acceptance and one typed passage (the 0027 paths).
    await old.runner.rpc(old.teacher, 'ksc_resolve_telugu_review_item', { p_item_id: quick[0].id, p_action: 'ACCEPT', p_text: null, p_note: null })
    await old.runner.rpc(old.teacher, 'ksc_resolve_telugu_review_item', { p_item_id: passage.id, p_action: 'EDIT', p_text: 'టైప్ చేసిన సూచనలు', p_note: null })
    const before = await qo(`SELECT * FROM draft_material_texts WHERE draft_material_id = $1`, [passage.draft_material_id])
    old.applyMigration(MIGRATION)
    const verify = (await old.pool.query(fs.readFileSync(VERIFY_SQL, 'utf8'))).rows
    assert.ok(verify.every(r => r.result === 'PASS'), JSON.stringify(verify.filter(r => r.result !== 'PASS')))
    const after = await qo(`SELECT * FROM draft_material_texts WHERE draft_material_id = $1`, [passage.draft_material_id])
    assert.equal(after[0].content, before[0].content); assert.equal(after[0].source, 'TEACHER'); assert.equal(after[0].verification_state, 'TEACHER_TRANSCRIBED')
    assert.equal((await old.runner.asUser(old.teacher, c => c.query('SELECT public.ksc_draft_has_teacher_work($1) t', [P]))).rows[0].t, true)
    assert.equal((await qo('SELECT count(*)::int n FROM draft_telugu_decisions'))[0].n, 0, 'nothing retroactive')
    // The new question verification works on the older Draft; propagation refuses (it has no fingerprints).
    const next = quick.slice(1).find(i => i.qid !== quick[0].qid)
    const viewOld = async i => (await qo('SELECT public.ksc_telugu_unit_view($1, $2, $3) v', [ownerOf(i), rowOf(i), P]))[0].v
    const r = await old.runner.rpc(old.teacher, 'ksc_verify_question_telugu', { p_question_id: next.qid, p_items: [{ item_id: next.id, expected: await viewOld(next) }], p_note: null })
    assert.equal(r.status, 'RESOLVED')
    await assert.rejects(old.runner.rpc(old.teacher, 'ksc_apply_telugu_source_decision', { p_draft_paper_id: P, p_fingerprint: 'tg1:000000000000000000000000',
      p_mode: 'VERIFY_SOURCE_AS_CORRECT', p_text: 'తెలుగు', p_occurrences: [{ item_id: next.id, expected: 'x' }], p_note: null }), /KSC_OCCURRENCE_NOT_OF_FINGERPRINT/)
    // A second, untouched older Draft stays re-preparable (no teacher work appears from the migration).
    report.olderDraft = { verify: verify.length, teacherWorkKept: true }
  } finally { await old.stop() }
})
