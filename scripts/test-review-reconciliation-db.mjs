import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { createLocalKscDb, prepareGoldenDraft, GOLDEN_PDF, PG_BIN } from './lib/local-draft-db.mjs'

// B4.8.2 — migration 0031 (review-item reconciliation after teacher edits) on a THROWAWAY local
// PostgreSQL with the full KSC chain and the golden paper prepared by the production orchestrator.
// The chain is applied through 0030 first, so edits made BEFORE 0031 (the live Q28 case) can be replayed,
// then 0031 is applied exactly as the SQL editor would. Never connects to Supabase.

const HAVE_PG = ['initdb', 'pg_ctl', 'psql'].every(n => fs.existsSync(path.join(PG_BIN, process.platform === 'win32' ? `${n}.exe` : n)))
const skip = !HAVE_PG ? 'local PostgreSQL binaries not found' : !fs.existsSync(GOLDEN_PDF) ? 'golden PDF not available' : false
const M0030 = '202609240030_draft_media_source_region_provenance_restore.sql'
const M0031 = '202609240031_draft_review_item_reconciliation.sql'

let db, paper
const rows = async (sql, args = []) => (await db.pool.query(sql, args)).rows
const asTeacher = (sql, args = [], uid = db.teacher) => db.runner.asUser(uid, c => c.query(sql, args))
const rpc = (name, args, uid = db.teacher) => db.runner.rpc(uid, name, args)
const qid = async n => (await rows(`SELECT id FROM draft_questions WHERE draft_paper_id = $1 AND source_question_number = $2`, [paper, String(n)]))[0].id
const opt = async (n, m) => (await rows(`SELECT o.id FROM draft_options o JOIN draft_questions q ON q.id = o.draft_question_id
  WHERE q.draft_paper_id = $1 AND q.source_question_number = $2 AND o.marker = $3`, [paper, String(n), m]))[0].id
const items = async (n, type) => rows(`SELECT i.* FROM draft_review_items i LEFT JOIN draft_options o ON o.id = i.draft_option_id
  JOIN draft_questions q ON q.id = coalesce(i.draft_question_id, o.draft_question_id)
  WHERE i.draft_paper_id = $1 AND q.source_question_number = $2 AND i.item_type = $3 ORDER BY o.marker NULLS FIRST, i.item_key`, [paper, String(n), type])
const one = async (n, type) => { const r = await items(n, type); assert.equal(r.length, 1, `Q${n} ${type}`); return r[0] }
const setOption = (n, m, text) => opt(n, m).then(id => asTeacher(`UPDATE draft_options SET content = $2 WHERE id = $1`, [id, text]))
const answerState = () => rows(`SELECT count(*) FILTER (WHERE o.is_proposed_correct)::int proposed, count(*) FILTER (WHERE o.is_confirmed_correct)::int confirmed,
  string_agg(o.id::text, ',' ORDER BY o.id) FILTER (WHERE o.is_proposed_correct) ids
  FROM draft_options o JOIN draft_questions q ON q.id = o.draft_question_id WHERE q.draft_paper_id = $1`, [paper]).then(r => r[0])
const languageFingerprint = () => rows(`SELECT md5(string_agg(t::text, '|' ORDER BY t.id)) h FROM (
  SELECT qt.* FROM draft_question_texts qt JOIN draft_questions q ON q.id = qt.draft_question_id WHERE q.draft_paper_id = $1
  UNION ALL SELECT ot.* FROM draft_option_texts ot JOIN draft_options o ON o.id = ot.draft_option_id JOIN draft_questions q ON q.id = o.draft_question_id WHERE q.draft_paper_id = $1) t`, [paper]).then(r => r[0].h)
const teluguItemStates = () => rows(`SELECT md5(string_agg(id::text || status || coalesce(resolution, ''), '|' ORDER BY id)) h FROM draft_review_items
  WHERE draft_paper_id = $1 AND item_type IN ('TELUGU_STEM','TELUGU_OPTION','TELUGU_VERIFY','TELUGU_STRUCTURE_AMBIGUOUS','MATERIAL_TELUGU')`, [paper]).then(r => r[0].h)
async function rejects(p, pattern) {
  try { await p } catch (e) { assert.match([e.message, e.hint, e.detail].filter(Boolean).join(' '), pattern); return }
  assert.fail(`expected rejection matching ${pattern}`)
}

let answersBefore, languageBefore, teluguBefore
before(async () => {
  if (skip) return
  db = await createLocalKscDb({ upTo: M0030 })
  paper = (await prepareGoldenDraft(db)).draftPaperId
  answersBefore = await answerState()
  // The live KSC sequence on Q28, made BEFORE 0031: the teacher types option D, marks the empty-option
  // item fixed, and defers the other two items. Plus an early Q41 edit (option A typed).
  await setOption(28, 'D', 'Second to the right')
  await rpc('ksc_resolve_review_item', { p_item_id: (await one(28, 'OPTION_EMPTY')).id, p_resolution: 'RESOLVED', p_note: null })
  await rpc('ksc_resolve_review_item', { p_item_id: (await one(28, 'ANSWER_KEY')).id, p_resolution: 'DEFER', p_note: null })
  await rpc('ksc_resolve_review_item', { p_item_id: (await one(28, 'OPTION_SET_ABNORMAL')).id, p_resolution: 'DEFER', p_note: null })
  await setOption(41, 'A', '6/77')
  languageBefore = await languageFingerprint()
  teluguBefore = await teluguItemStates()
})
after(async () => { await db?.stop() })

test('0031 applies after 0030, is idempotent, and 0017-0030 are unchanged on disk', { skip }, async () => {
  assert.equal((await one(28, 'ANSWER_KEY')).status, 'DEFERRED', 'without 0031 the Q28 answer-key item is stale')
  db.applyMigration(M0031)
  db.applyMigration(M0031)
  const cons = await rows(`SELECT conname FROM pg_constraint WHERE conrelid = 'draft_review_items'::regclass AND pg_get_constraintdef(oid) LIKE '%resolution = ANY%' AND pg_get_constraintdef(oid) NOT LIKE '%status%'`)
  assert.deepEqual(cons.map(c => c.conname), ['draft_review_items_resolution_v2'])
  const locked = { '202609230027_draft_review_items.sql': 'd26d5457463fbbdceb8fd8b5d1212627db95064c946cc759ff83491d76673a17' }
  for (const [f, h] of Object.entries(locked)) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join('supabase/migrations', f))).digest('hex'), h, f)
  const fn = await rows(`SELECT proname, prosecdef FROM pg_proc WHERE proname IN ('ksc_reconcile_review_items','ksc_reconcile_question_review_items','ksc_review_item_defect_present','ksc_reconcile_after_draft_edit')`)
  assert.equal(fn.length, 4); assert.ok(fn.every(f => f.prosecdef))
  const grants = await rows(`SELECT p.proname, has_function_privilege('authenticated', p.oid, 'EXECUTE') a, has_function_privilege('anon', p.oid, 'EXECUTE') n
    FROM pg_proc p WHERE p.proname LIKE 'ksc_re%concil%' OR p.proname = 'ksc_review_item_defect_present'`)
  for (const g of grants) { assert.equal(g.n, false, `${g.proname}: no anon`); assert.equal(g.a, g.proname === 'ksc_reconcile_review_items', `${g.proname}: client-callable only as the catch-up RPC`) }
})

test('owner verification SQL (docs/ksc/deploy/B4-05) runs READ ONLY: all PASS, and its preview names exactly what the catch-up will close', { skip }, async () => {
  const sql = fs.readFileSync('docs/ksc/deploy/B4-05-0031-VERIFY-READONLY.sql', 'utf8')
  const [q1, q2] = sql.split(/^-- QUERY 2.*$/m).map(s => s.replace(/--[^\n]*(\n|$)/g, '\n').trim().replace(/;\s*$/, ''))
  const c = await db.pool.connect()
  try {
    await c.query('BEGIN READ ONLY')
    const checks = (await c.query(q1)).rows
    assert.equal(checks.length, 8)
    assert.deepEqual(checks.filter(r => r.result !== 'PASS'), [])
    const preview = (await c.query(q2)).rows.map(r => `Q${r.question} ${r.item_type}`)
    assert.deepEqual(preview, ['Q28 ANSWER_KEY', 'Q41 OPTION_EMPTY'])
  } finally { await c.query('ROLLBACK').catch(() => {}); c.release() }
})

test('catch-up: the live Q28 case — stale answer-key item closes; the duplicate-marker item stays with the teacher', { skip }, async () => {
  await rejects(rpc('ksc_reconcile_review_items', { p_draft_paper_id: paper }, db.otherTeacher), /not found or unauthorized/)
  const r = await rpc('ksc_reconcile_review_items', { p_draft_paper_id: paper })
  assert.equal(r.reconciled, 2, 'Q28 ANSWER_KEY + Q41 OPTION_EMPTY(A) — nothing else')
  const ak = await one(28, 'ANSWER_KEY')
  assert.equal(ak.status, 'RESOLVED'); assert.equal(ak.resolution, 'RECONCILED'); assert.equal(ak.resolved_by, db.teacher)
  assert.match(ak.resolution_note, /no longer has this defect.*KEY_POINTS_AT_EMPTY_OPTION/)
  const set = await one(28, 'OPTION_SET_ABNORMAL')
  assert.equal(set.status, 'DEFERRED', '"Third to the rightD) Second to the right" is still in option C')
  assert.deepEqual(set.machine_reasons, ['DUPLICATE_OPTION_MARKERS'])
  const q41 = await items(41, 'OPTION_EMPTY')
  assert.deepEqual(q41.map(i => i.status), ['RESOLVED', 'OPEN', 'OPEN', 'OPEN'])
  assert.equal((await one(41, 'ANSWER_KEY')).status, 'OPEN', 'the proposed option (C) is still empty')
  assert.equal((await rpc('ksc_reconcile_review_items', { p_draft_paper_id: paper })).reconciled, 0, 'idempotent')
})

test('at the edit: an empty option / answer-key blocker disappears only when its own defect is gone', { skip }, async () => {
  await setOption(41, 'B', '5/77')
  assert.deepEqual((await items(41, 'OPTION_EMPTY')).map(i => i.status), ['RESOLVED', 'RESOLVED', 'OPEN', 'OPEN'])
  assert.equal((await one(41, 'ANSWER_KEY')).status, 'OPEN')
  await setOption(41, 'C', '15/77')                                   // the proposed option now has text
  assert.equal((await one(41, 'ANSWER_KEY')).status, 'RESOLVED')
  assert.equal((await one(41, 'ANSWER_KEY')).resolution, 'RECONCILED')
  await setOption(41, 'C', '   ')                                     // blanking it again brings both defects back
  assert.deepEqual((await items(41, 'OPTION_EMPTY')).map(i => i.status), ['RESOLVED', 'RESOLVED', 'OPEN', 'OPEN'])
  const ak = await one(41, 'ANSWER_KEY')
  assert.equal(ak.status, 'OPEN'); assert.equal(ak.resolution, null); assert.match(ak.resolution_note, /Reopened automatically/)
  await setOption(41, 'C', '15/77')
  assert.equal((await one(41, 'ANSWER_KEY')).resolution, 'RECONCILED')
  // Q28's empty-option item was closed BY HAND before 0031; a later edit never reopens a teacher decision.
  await setOption(28, 'D', '')
  assert.equal((await one(28, 'OPTION_EMPTY')).resolution, 'RESOLVED')
  await setOption(28, 'D', 'Second to the right')
})

test('duplicate option text: closes when the options really differ (Q157); never while a maths bitmap is unverified (Q75)', { skip }, async () => {
  // Q157 prints A and D identically in the source; no bitmaps.
  assert.deepEqual((await one(157, 'OPTION_SET_ABNORMAL')).machine_reasons, ['DUPLICATE_OPTION_TEXT'])
  await setOption(157, 'D', '1, 2, 4, 5')
  assert.equal((await one(157, 'OPTION_SET_ABNORMAL')).resolution, 'RECONCILED')
  // B4.8.3B: Q75's A/B carry √3 bitmaps, so the set item also says NOTATION_IMAGE_IN_OPTIONS(A,B). Making
  // the texts different proves nothing about the bitmaps: it stays for the teacher.
  const set = await one(75, 'OPTION_SET_ABNORMAL')
  assert.deepEqual(set.machine_reasons, ['DUPLICATE_OPTION_TEXT', 'NOTATION_IMAGE_IN_OPTIONS(A,B)'])
  await setOption(75, 'C', '35√3')
  const empty = await one(75, 'OPTION_EMPTY')
  assert.deepEqual(empty.machine_reasons, ['EMPTY_OPTION_TEXT', 'NOTATION_IMAGE'])
  assert.equal(empty.status, 'RESOLVED', 'the empty option now has text: its own defect is gone')
  await setOption(75, 'D', '70√3')
  assert.equal((await one(75, 'OPTION_SET_ABNORMAL')).status, 'OPEN', 'never auto-closed while a bitmap value is unverified')
})

test('never auto-closed: duplicate-marker evidence (Q43), short stems (Q3), and edits with no accountable user', { skip }, async () => {
  await setOption(43, 'D', '16 4/11 min past 4')
  assert.equal((await one(43, 'OPTION_SET_ABNORMAL')).status, 'OPEN', 'DUPLICATE_OPTION_MARKERS is source-layout evidence')
  await asTeacher(`UPDATE draft_questions SET content = 'Odd one' WHERE id = $1`, [await qid(3)])
  assert.equal((await one(3, 'ENGLISH_STEM_MISSING')).status, 'OPEN', '7 characters is still under the generator threshold')
  await asTeacher(`UPDATE draft_questions SET content = 'Choose the pair that is different.' WHERE id = $1`, [await qid(3)])
  assert.equal((await one(3, 'ENGLISH_STEM_MISSING')).resolution, 'RECONCILED')
  await db.pool.query(`UPDATE draft_options SET content = '1/2' WHERE id = $1`, [await opt(66, 'A')])   // database administrator, no auth.uid()
  assert.equal((await items(66, 'OPTION_EMPTY'))[0].status, 'OPEN')
})

test('answers, language rows and Telugu items are never touched by reconciliation', { skip }, async () => {
  const now = await answerState()
  assert.equal(now.confirmed, 0); assert.equal(answersBefore.confirmed, 0)
  assert.equal(now.proposed, answersBefore.proposed); assert.equal(now.ids, answersBefore.ids)
  assert.equal(await languageFingerprint(), languageBefore)
  assert.equal(await teluguItemStates(), teluguBefore)
  const reconciled = await rows(`SELECT DISTINCT item_type FROM draft_review_items WHERE draft_paper_id = $1 AND resolution = 'RECONCILED'`, [paper])
  assert.ok(reconciled.every(r => ['OPTION_EMPTY', 'ANSWER_KEY', 'OPTION_SET_ABNORMAL', 'ENGLISH_STEM_MISSING'].includes(r.item_type)))
})

test('a fresh preparation with 0031 applied: triggers are harmless and the catch-up closes nothing', { skip, timeout: 600_000 }, async () => {
  const fresh = (await prepareGoldenDraft(db)).draftPaperId
  const st = (await rows(`SELECT status, count(*)::int n FROM draft_review_items WHERE draft_paper_id = $1 GROUP BY 1`, [fresh]))
  assert.deepEqual(st, [{ status: 'OPEN', n: st[0].n }], 'every item OPEN')
  assert.equal((await rpc('ksc_reconcile_review_items', { p_draft_paper_id: fresh })).reconciled, 0, 'generator and reconciliation rules agree')
  assert.equal((await rows(`SELECT public.ksc_draft_has_teacher_work($1) t`, [fresh]))[0].t, false)
})
