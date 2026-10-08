// B4.8.3C — migration 0032 (deduplicated math-image recovery) on a THROWAWAY local PostgreSQL with the full
// KSC chain and a fresh golden preparation through the production orchestrator. Never touches Supabase.
//
// Covers: SQL/JS parity (validator, placement), security (owner teacher only; other teacher, student,
// anonymous; no direct table writes; evidence read-only; append-only log; immutable history), forged
// placements, idempotency, a repeated fingerprint with one stale placement, correction history, edits after
// recovery never overwritten, Telugu never written, answers invariant, review items closed only when the
// resulting Draft proves the defect gone, teacher-work protection, and paper deletion.
// Values come from the SIMULATED teacher fixture (tests only); no count of the golden paper is pinned here.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { randomUUID } from 'node:crypto'
import { createLocalKscDb, prepareGoldenDraft, createImport, GOLDEN_PDF } from './lib/local-draft-db.mjs'
import { groupMathImages, friendlyToLatex, placeAtAnchor, validateMathLatex } from './lib/math-image-recovery.mjs'

const skip = !fs.existsSync(GOLDEN_PDF) && 'golden PDF not available'
const fixture = JSON.parse(fs.readFileSync('scripts/fixtures/b483c-simulated-teacher-math.json', 'utf8')).resolutions
let db, paperId, student
const report = {}

const rpc = (uid, name, args) => db.runner.rpc(uid, name, args)
const asT = fn => db.runner.asUser(db.teacher, fn)
const q1 = async (sql, params = []) => (await db.pool.query(sql, params)).rows
async function draft() {
  const questions = await q1('SELECT * FROM draft_questions WHERE draft_paper_id = $1 ORDER BY position', [paperId])
  const options = await q1('SELECT o.* FROM draft_options o JOIN draft_questions q ON q.id = o.draft_question_id WHERE q.draft_paper_id = $1', [paperId])
  return { questions, options, groups: groupMathImages(questions) }
}
const keyOf = o => `${o.page}@${o.box.x},${o.box.y}`
// What the Math Recovery queue sends: every placement of the fingerprint with the text the teacher sees.
function viewOf(d, fp, { only = null } = {}) {
  const g = d.groups.find(x => x.fp === fp)
  return g.occurrences.filter(o => !only || only(o)).map(o => {
    const target = o.side === 'te' ? null : o.owner === 'stem' ? d.questions.find(q => q.id === o.questionId)
      : d.options.find(x => x.draft_question_id === o.questionId && x.marker === o.owner)
    return { question_id: o.questionId, key: keyOf(o), expected: target ? target.content : null }
  })
}
const latexFor = fp => friendlyToLatex(fixture[fp].input).latex
const resolve = (fp, placements, { input = fixture[fp].input, latex = latexFor(fp), uid = db.teacher } = {}) =>
  rpc(uid, 'ksc_resolve_math_image', { p_draft_paper_id: paperId, p_fingerprint: fp, p_input: input, p_representation: latex, p_placements: placements, p_note: null })
const answers = async () => (await q1(`SELECT o.id, o.is_proposed_correct, o.is_confirmed_correct, o.marker, o.position FROM draft_options o
  JOIN draft_questions q ON q.id = o.draft_question_id WHERE q.draft_paper_id = $1 ORDER BY o.id`, [paperId]))
const counts = async () => {
  const r = await q1(`SELECT readiness, count(*)::int n FROM draft_question_readiness WHERE draft_paper_id = $1 GROUP BY 1`, [paperId])
  const b = await q1(`SELECT count(*)::int n FROM draft_review_items WHERE draft_paper_id = $1 AND blocking AND status <> 'RESOLVED'`, [paperId])
  const m = await q1(`SELECT count(*)::int n FROM draft_review_items WHERE draft_paper_id = $1 AND blocking AND status <> 'RESOLVED' AND machine_reasons::text LIKE '%NOTATION%'`, [paperId])
  return { blocking: b[0].n, mathBlocking: m[0].n, readiness: Object.fromEntries(r.map(x => [x.readiness, x.n])) }
}
let answersAtStart, countsAtStart

before(async () => {
  if (skip) return
  db = await createLocalKscDb()
  const prep = await prepareGoldenDraft(db)
  paperId = prep.draftPaperId
  student = randomUUID()
  await db.pool.query(`INSERT INTO auth.users (id, email, role) VALUES ($1, 'student@ksc.local', 'authenticated')`, [student])
  answersAtStart = await answers(); countsAtStart = await counts()
})
after(async () => {
  if (db) fs.writeFileSync('reports/b483c/db-test-report.json', JSON.stringify(report, null, 1))
  await db?.stop()
})

test('0032 is a forward migration: 0017-0031 unchanged, applied in the chain, no publish/attempt/Telugu-text writes', { skip }, async () => {
  const locked = {
    '202609220017_draft_paper_foundation.sql': '255c022d8febdc3ed6d49f3dad99b4ca306aaf97443562914c285512d26b5eba',
    '202609230027_draft_review_items.sql': 'd26d5457463fbbdceb8fd8b5d1212627db95064c946cc759ff83491d76673a17',
    '202609230029_draft_paper_preparation_lifecycle.sql': 'abe1082f2125dbac15f2182149dffdae70d4b27907f67c5e90bca70c3d7bb2c5',
    '202609240031_draft_review_item_reconciliation.sql': '12ecc8eb61284a14037d7e9f4a7026adb30cf90112a2d68e2a1ecefe854e3804',
    '202609250032_draft_math_image_recovery.sql': 'dff0ea52e6b1cccde06e84513fce3994f0e039fe054bafc2e5b8f9a28b96457a',   // B4.8.3C, as submitted for deployment review
  }   // the full 0017-0031 list is locked in test-paper-preparation-db
  for (const [f, h] of Object.entries(locked)) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(`supabase/migrations/${f}`)).digest('hex'), h, f)
  const sql = fs.readFileSync('supabase/migrations/202609250032_draft_math_image_recovery.sql', 'utf8').replace(/--.*$/gm, '')
  for (const forbidden of ['publish_test', 'test_attempts', 'attempt_answers', 'question_bank', 'test_question_snapshots', 'is_confirmed_correct =', 'is_proposed_correct =',
    'draft_question_texts SET', 'draft_option_texts SET', 'UPDATE public.draft_question_texts', 'UPDATE public.draft_option_texts', 'storage.objects'])
    assert.ok(!sql.includes(forbidden), `0032 must not reference ${forbidden}`)
  const fns = await q1(`SELECT to_regprocedure('public.ksc_resolve_math_image(uuid,text,text,text,jsonb,text)') f, to_regclass('public.draft_math_image_placement_log') l`)
  assert.ok(fns[0].f && fns[0].l)
  // The owner's read-only post-apply verification reads PASS on a freshly migrated database.
  const verify = await q1(fs.readFileSync('docs/ksc/deploy/B4-06-0032-VERIFY-READONLY.sql', 'utf8'))
  assert.ok(verify.length >= 9 && verify.every(r => r.result === 'PASS'), JSON.stringify(verify.filter(r => r.result !== 'PASS')))
  report.verifySql = verify.map(r => `${r.result} ${r.check_name}`)
})

test('server validator and placement agree with the client helpers (every golden placement + edge cases)', { skip }, async () => {
  const samples = ['\\(\\frac{8}{11}\\)', '\\(\\frac{70\\sqrt{3}}{3}\\)', '\\(10^{11}\\)', '\\(60^{\\circ}\\)', '\\(2 \\times 3\\)', '\\(\\frac{1}{2}\\) x',
    '\\(\\text{x}\\)', '\\(\\href{u}{v}\\)', '\\(<b>1</b>\\)', '\\(\\frac12\\)', '\\(days\\)', '\\(\\frac{}{2}\\)', '\\(\\frac{1}{\\)', '<script>alert(1)</script>',
    '\\(\\frac{1}{2}\\) and \\(3\\)', '\\(' + '1'.repeat(201) + '\\)', '\\(\\sqrt {3}\\)', '\\(a_{1}\\)', '\\(\\%\\)']
  for (const s of samples) {
    const [row] = await q1('SELECT public.ksc_math_representation_ok($1) ok', [s])
    assert.equal(row.ok, validateMathLatex(s) === null, s)
  }
  const d = await draft()
  let compared = 0
  for (const g of d.groups) for (const o of g.occurrences.filter(x => x.side === 'en')) {
    const target = o.owner === 'stem' ? d.questions.find(q => q.id === o.questionId) : d.options.find(x => x.draft_question_id === o.questionId && x.marker === o.owner)
    const latex = latexFor(g.fp)
    const js = placeAtAnchor(target.content, o.anchor, latex)
    const [{ r }] = await q1('SELECT public.ksc_math_place_at_anchor($1, $2::jsonb, $3) r', [target.content, JSON.stringify(o.anchor), latex])
    assert.deepEqual(r.ok ? { ok: true, content: r.content } : { ok: false, why: r.why }, js, `Q${o.question} ${o.owner}`)
    compared++
  }
  const edge = [['2 km or 2 km', { before: '2', after: 'km' }], ['3 km', { before: '2', after: 'km' }], ['', { before: '15', after: '' }], ['a.b (c)', { before: 'a.b', after: '(c)' }], ['x  y', { before: 'x', after: 'y' }]]
  for (const [c, a] of edge) {
    const [{ r }] = await q1('SELECT public.ksc_math_place_at_anchor($1, $2::jsonb, $3) r', [c, JSON.stringify(a), '\\(\\frac{1}{2}\\)'])
    assert.deepEqual(r.ok ? { ok: true, content: r.content } : { ok: false, why: r.why }, placeAtAnchor(c, a, '\\(\\frac{1}{2}\\)'), c)
  }
  report.parity = { validatorSamples: samples.length, goldenPlacementsCompared: compared }
  assert.ok(compared > 0)
})

test('security: owner teacher only; student, other teacher and anonymous get nothing; no direct writes; evidence read-only', { skip }, async () => {
  const d = await draft()
  const g = d.groups.find(x => x.fp && x.occurrences.some(o => o.side === 'en'))
  const view = viewOf(d, g.fp)
  await assert.rejects(resolve(g.fp, view, { uid: db.otherTeacher }), /not found or unauthorized/)
  await assert.rejects(resolve(g.fp, view, { uid: student }), /Teacher access required/)
  await assert.rejects(resolve(g.fp, view, { uid: null }), /permission denied/)
  for (const t of ['draft_math_image_resolutions', 'draft_math_image_placement_log']) {
    await assert.rejects(db.runner.asUser(null, c => c.query(`SELECT * FROM public.${t}`)), /permission denied/)
    assert.equal((await db.runner.asUser(student, c => c.query(`SELECT * FROM public.${t}`))).rows.length, 0)
    await assert.rejects(asT(c => c.query(`INSERT INTO public.${t} (draft_paper_id) VALUES ($1)`, [paperId])), /permission denied/)
    await assert.rejects(asT(c => c.query(`DELETE FROM public.${t}`)), /permission denied/)
  }
  await assert.rejects(asT(c => c.query(`UPDATE public.draft_questions SET analysis_regions = '{}'::jsonb WHERE id = $1`, [d.questions[0].id])), /KSC_ANALYSIS_EVIDENCE_READ_ONLY/)
  // Forged placements: a key of another fingerprint, a question of this paper without that bitmap, junk.
  const other = d.groups.find(x => x.fp && x.fp !== g.fp)
  await assert.rejects(resolve(g.fp, [...view, viewOf(d, other.fp)[0]]), /KSC_PLACEMENT_NOT_OF_FINGERPRINT/)
  await assert.rejects(resolve(g.fp, [{ question_id: d.questions[0].id, key: '1@0,0', expected: null }]), /KSC_PLACEMENT_NOT_OF_FINGERPRINT/)
  await assert.rejects(resolve(g.fp, []), /KSC_PLACEMENTS_REQUIRED/)
  await assert.rejects(resolve(g.fp, [view[0], view[0]]), /KSC_PLACEMENTS_DUPLICATED/)
  for (const bad of ['\\(\\text{1/2}\\)', '<img src=x onerror=alert(1)>', '\\(\\href{http://x}{1}\\)', '1/2'])
    await assert.rejects(resolve(g.fp, view, { latex: bad }), /KSC_MATH_REPRESENTATION_INVALID/)
  await assert.rejects(resolve('px:nothere00000000000000000', view, { input: '1/2', latex: '\\(\\frac{1}{2}\\)' }), /KSC_FINGERPRINT_INVALID/)
  await assert.rejects(resolve('px:000000000000000000000000', view, { input: '1/2', latex: '\\(\\frac{1}{2}\\)' }), /KSC_PLACEMENT_NOT_OF_FINGERPRINT/)
  const after = await draft()
  assert.deepEqual(after.options.map(o => o.content), d.options.map(o => o.content), 'nothing written by refused calls')
  assert.equal((await q1('SELECT count(*)::int n FROM draft_math_image_resolutions'))[0].n, 0)
})

test('teacher work: a recovery touching only Telugu placements still protects the Draft from re-preparation', { skip }, async () => {
  const d = await draft()
  assert.equal((await asT(c => c.query('SELECT public.ksc_draft_has_teacher_work($1) t', [paperId]))).rows[0].t, false)
  const teOnly = d.groups.find(g => g.fp && g.occurrences.every(o => o.side === 'te'))
  assert.ok(teOnly, 'a Telugu-only bitmap exists in the golden evidence')
  const teSql = `SELECT t.* FROM draft_question_texts t WHERE t.draft_question_id = ANY($1) ORDER BY t.id`
  const teBefore = await q1(teSql, [teOnly.occurrences.map(o => o.questionId)])
  const res = await resolve(teOnly.fp, viewOf(d, teOnly.fp))
  assert.ok(res.placements.every(p => p.outcome === 'TELUGU_REVIEW'))
  assert.deepEqual(await q1(teSql, [teOnly.occurrences.map(o => o.questionId)]), teBefore, 'Telugu text never written')
  assert.equal((await asT(c => c.query('SELECT public.ksc_draft_has_teacher_work($1) t', [paperId]))).rows[0].t, true)
  const run = (await q1(`SELECT id FROM draft_analysis_runs WHERE draft_paper_id = $1 AND preparation_state = 'PREPARED'`, [paperId]))[0].id
  await assert.rejects(rpc(db.teacher, 'ksc_replace_review_items', { p_draft_paper_id: paperId, p_run_id: run, p_generator: 'test', p_items: [] }), /KSC_DRAFT_HAS_TEACHER_WORK/)
  report.teluguOnly = { fp: teOnly.fp, placements: teOnly.occurrences.length }
})

test('one fingerprint, several placements, one stale: the stale one is never overwritten; the rest apply; retry is explicit', { skip }, async () => {
  let d = await draft()
  const g = [...d.groups].filter(x => x.fp && x.occurrences.filter(o => o.side === 'en' && o.owner !== 'stem').length >= 3)
    .sort((a, b) => b.occurrences.length - a.occurrences.length)[0]
  const view = viewOf(d, g.fp)
  // A placement at the END of its option ("18" + bitmap): the edit below makes its anchor unmatchable.
  const victimOcc = g.occurrences.find(o => o.side === 'en' && o.owner !== 'stem' && o.anchor?.before && !o.anchor.after)
  const victim = d.options.find(o => o.draft_question_id === victimOcc.questionId && o.marker === victimOcc.owner)
  // The teacher edits that option in another tab after opening the queue.
  await asT(c => c.query('UPDATE public.draft_options SET content = $2 WHERE id = $1', [victim.id, `${victim.content} (edited)`]))
  const res = await resolve(g.fp, view)
  const byKey = new Map(res.placements.map(p => [`${p.question_id}|${p.key}`, p]))
  const vk = `${victimOcc.questionId}|${keyOf(victimOcc)}`
  assert.equal(byKey.get(vk).outcome, 'CONFLICT'); assert.equal(byKey.get(vk).reason, 'STALE_VIEW')
  d = await draft()
  assert.equal(d.options.find(o => o.id === victim.id).content, `${victim.content} (edited)`, 'stale placement untouched')
  for (const p of res.placements.filter(p => `${p.question_id}|${p.key}` !== vk)) assert.ok(['APPLIED', 'TELUGU_REVIEW'].includes(p.outcome), JSON.stringify(p))
  // Retry with the fresh view: the anchor no longer matches the edited text -> refused, still untouched.
  const retry = await resolve(g.fp, viewOf(d, g.fp))
  assert.equal(retry.revision, res.revision); assert.equal(retry.reused, true)
  assert.equal(retry.placements.find(p => `${p.question_id}|${p.key}` === vk).outcome, 'REFUSED')
  assert.ok(retry.placements.filter(p => `${p.question_id}|${p.key}` !== vk).every(p => /^ALREADY_/.test(p.outcome)), 'the others are idempotent')
  // The teacher restores the printed text; the next retry applies it.
  await asT(c => c.query('UPDATE public.draft_options SET content = $2 WHERE id = $1', [victim.id, victim.content]))
  d = await draft()
  const third = await resolve(g.fp, viewOf(d, g.fp))
  assert.equal(third.placements.find(p => `${p.question_id}|${p.key}` === vk).outcome, 'APPLIED')
  const log = await q1(`SELECT outcome, reason, content_before, content_after FROM draft_math_image_placement_log WHERE fingerprint = $1 AND draft_question_id = $2 AND placement_key = $3 ORDER BY id`,
    [g.fp, victimOcc.questionId, keyOf(victimOcc)])
  assert.deepEqual(log.map(l => l.outcome), ['CONFLICT', 'REFUSED', 'APPLIED'])
  report.repeatedFingerprint = { fp: g.fp, placements: g.occurrences.length, victim: `Q${victimOcc.question} ${victimOcc.owner}`, log: log.map(l => `${l.outcome}${l.reason ? `(${l.reason})` : ''}`) }
})

test('idempotent: repeating a confirmation writes nothing, adds no revision and no log entry', { skip }, async () => {
  const d = await draft()
  const g = d.groups.find(x => x.fp && fixture[x.fp] && x.occurrences.every(o => o.side === 'en') && x.occurrences.length === 1)
  const first = await resolve(g.fp, viewOf(d, g.fp))
  assert.equal(first.placements[0].outcome, 'APPLIED')
  const logN = (await q1('SELECT count(*)::int n FROM draft_math_image_placement_log'))[0].n
  const d2 = await draft()
  const again = await resolve(g.fp, viewOf(d2, g.fp))
  assert.equal(again.placements[0].outcome, 'ALREADY_APPLIED'); assert.equal(again.reused, true); assert.equal(again.revision, first.revision)
  // A retry with the OLD view (e.g. a double-click / network retry of the same request) is also a no-op.
  const retryOld = await resolve(g.fp, viewOf(d, g.fp))
  assert.equal(retryOld.placements[0].outcome, 'ALREADY_APPLIED')
  assert.equal((await q1('SELECT count(*)::int n FROM draft_math_image_placement_log'))[0].n, logN)
  assert.deepEqual((await draft()).options.map(o => o.content), d2.options.map(o => o.content))
})

test('corrections are revisions: history kept, value re-placed from the original text; a later hand edit is never overwritten', { skip }, async () => {
  let d = await draft()
  const done = new Set((await q1('SELECT fingerprint FROM draft_math_image_resolutions')).map(r => r.fingerprint))
  const g = d.groups.find(x => x.fp && fixture[x.fp] && !done.has(x.fp) && x.occurrences.filter(o => o.side === 'en').length >= 2
    && !x.occurrences.some(o => o.side === 'en' && o.owner === 'stem'))
  const wrong = await resolve(g.fp, viewOf(d, g.fp), { input: '1/9', latex: '\\(\\frac{1}{9}\\)' })
  assert.equal(wrong.revision, 1)
  d = await draft()
  const right = await resolve(g.fp, viewOf(d, g.fp))
  assert.equal(right.revision, 2); assert.equal(right.reused, false)
  d = await draft()
  const en = g.occurrences.filter(o => o.side === 'en')
  for (const o of en) {
    const opt = d.options.find(x => x.draft_question_id === o.questionId && x.marker === o.owner)
    assert.ok(opt.content.includes(latexFor(g.fp)) && !opt.content.includes('\\frac{1}{9}'), opt.content)
  }
  const revs = await q1('SELECT revision, verification_state, superseded_at, supersedes, representation FROM draft_math_image_resolutions WHERE fingerprint = $1 ORDER BY revision', [g.fp])
  assert.deepEqual(revs.map(r => [r.revision, r.verification_state]), [[1, 'SUPERSEDED'], [2, 'TEACHER_VERIFIED']])
  assert.ok(revs[0].superseded_at && revs[1].supersedes)
  await assert.rejects(db.pool.query(`UPDATE draft_math_image_resolutions SET representation = '\\(1\\)' WHERE fingerprint = $1`, [g.fp]), /KSC_MATH_HISTORY_IMMUTABLE/)
  await assert.rejects(db.pool.query(`DELETE FROM draft_math_image_resolutions WHERE fingerprint = $1`, [g.fp]), /KSC_MATH_HISTORY_IMMUTABLE/)
  await assert.rejects(db.pool.query(`UPDATE draft_math_image_placement_log SET reason = 'x'`), /KSC_MATH_LOG_APPEND_ONLY/)
  await assert.rejects(db.pool.query(`DELETE FROM draft_math_image_placement_log`), /KSC_MATH_LOG_APPEND_ONLY/)
  // The teacher edits one placement by hand; a further correction must not overwrite it.
  const edited = en[0]
  const opt = d.options.find(x => x.draft_question_id === edited.questionId && x.marker === edited.owner)
  await asT(c => c.query('UPDATE public.draft_options SET content = $2 WHERE id = $1', [opt.id, `${opt.content} *`]))
  d = await draft()
  const third = await resolve(g.fp, viewOf(d, g.fp), { input: '1/8', latex: '\\(\\frac{1}{8}\\)' })
  const p = third.placements.find(x => x.question_id === edited.questionId && x.key === keyOf(edited))
  assert.equal(p.outcome, 'CONFLICT'); assert.equal(p.reason, 'EDITED_SINCE_RECOVERY')
  assert.equal((await q1('SELECT content FROM draft_options WHERE id = $1', [opt.id]))[0].content, `${opt.content} *`)
  // Restore the correct value everywhere for the acceptance run (revision 4 = the fixture value again).
  await asT(c => c.query('UPDATE public.draft_options SET content = $2 WHERE id = $1', [opt.id, opt.content]))
  d = await draft()
  const back = await resolve(g.fp, viewOf(d, g.fp))
  assert.equal(back.revision, 4)
  const log = await q1(`SELECT revision, outcome, base_content FROM draft_math_image_placement_log WHERE fingerprint = $1 AND side = 'en' AND outcome = 'APPLIED' ORDER BY id`, [g.fp])
  assert.ok(log.every(l => l.base_content !== null && !l.base_content.includes('\\(')), 'every revision re-placed from the pre-recovery text')
  report.correction = { fp: g.fp, revisions: (await q1('SELECT count(*)::int n FROM draft_math_image_resolutions WHERE fingerprint = $1', [g.fp]))[0].n, appliedEntries: log.length }
})

test('acceptance: every remaining bitmap resolved once; Telugu untouched; answers invariant; only proven defects closed', { skip }, async () => {
  let d = await draft()
  const teBefore = await q1(`SELECT id, content, text_quality FROM draft_question_texts ORDER BY id`)
  const toBefore = await q1(`SELECT id, content, text_quality FROM draft_option_texts ORDER BY id`)
  const openBefore = await q1(`SELECT id, item_type, machine_reasons FROM draft_review_items WHERE draft_paper_id = $1 AND blocking AND status <> 'RESOLVED'`, [paperId])
  const perResolution = []
  for (const g of d.groups.filter(x => x.fp && fixture[x.fp])) {
    d = await draft()
    const r = await resolve(g.fp, viewOf(d, g.fp))
    perResolution.push({ fp: g.fp, input: fixture[g.fp].input, placements: g.occurrences.length, outcomes: r.placements.map(p => p.outcome) })
  }
  d = await draft()
  // Every English placement carries its value exactly once in the stored text.
  for (const g of d.groups.filter(x => x.fp)) for (const o of g.occurrences.filter(x => x.side === 'en')) {
    const t = o.owner === 'stem' ? d.questions.find(q => q.id === o.questionId).content : d.options.find(x => x.draft_question_id === o.questionId && x.marker === o.owner).content
    assert.ok(t.includes(latexFor(g.fp)), `Q${o.question} ${o.owner}: ${t}`)
  }
  assert.deepEqual(await q1(`SELECT id, content, text_quality FROM draft_question_texts ORDER BY id`), teBefore, 'Telugu stems untouched')
  assert.deepEqual(await q1(`SELECT id, content, text_quality FROM draft_option_texts ORDER BY id`), toBefore, 'Telugu options untouched')
  assert.deepEqual(await answers(), answersAtStart, 'proposed/confirmed flags, markers and positions unchanged')
  assert.equal((await answers()).filter(a => a.is_confirmed_correct).length, 0)
  // Closed items: only by 0031 (text now present) or by the recovery rule; each is verifiable now.
  const closed = await q1(`SELECT i.*, q.source_question_number qn FROM draft_review_items i LEFT JOIN draft_options o ON o.id = i.draft_option_id
    LEFT JOIN draft_questions q ON q.id = coalesce(i.draft_question_id, o.draft_question_id)
    WHERE i.draft_paper_id = $1 AND i.id = ANY($2) AND i.status = 'RESOLVED'`, [paperId, openBefore.map(i => i.id)])
  for (const i of closed) {
    assert.equal(i.resolution, 'RECONCILED', `${i.item_type} Q${i.qn}`)
    if (i.item_type === 'OPTION_EMPTY') assert.ok((await q1('SELECT content FROM draft_options WHERE id = $1', [i.draft_option_id]))[0].content.trim())
    assert.ok(!['TELUGU_STEM', 'TELUGU_OPTION'].includes(i.item_type))
  }
  const stillOpen = await q1(`SELECT i.item_type, i.machine_reasons, q.source_question_number qn FROM draft_review_items i LEFT JOIN draft_options o ON o.id = i.draft_option_id
    LEFT JOIN draft_questions q ON q.id = coalesce(i.draft_question_id, o.draft_question_id)
    WHERE i.draft_paper_id = $1 AND i.blocking AND i.status <> 'RESOLVED' AND i.machine_reasons::text LIKE '%NOTATION%' ORDER BY q.position`, [paperId])
  for (const i of stillOpen) {
    const reasons = i.machine_reasons
    assert.ok(i.item_type.startsWith('TELUGU') || reasons.includes('DUPLICATE_OPTION_MARKERS') || i.item_type === 'OPTION_EMPTY',
      `an open maths item must have a reason the recovery cannot remove: ${i.item_type} Q${i.qn} ${reasons}`)
  }
  const now = await counts()
  report.acceptance = { before: countsAtStart, after: now, resolutions: perResolution.length, perResolution,
    closedByType: closed.reduce((m, i) => ({ ...m, [i.item_type]: (m[i.item_type] || 0) + 1 }), {}),
    remainingMathBlockers: stillOpen.map(i => `${i.item_type} Q${i.qn}: ${i.machine_reasons.join('+')}`) }
  assert.ok(now.blocking < countsAtStart.blocking)
})

test('deleting a paper removes its recovery rows; the history guards allow only that', { skip }, async () => {
  // A small separate paper (deleting the whole prepared golden Draft is governed by earlier migrations).
  const imp = await createImport(db)
  const [{ id: p2 }] = await q1('INSERT INTO draft_papers (source_import_id, created_by) VALUES ($1, $2) RETURNING id', [imp.id, db.teacher])
  const fp = 'px:' + 'a'.repeat(24)
  const [{ id: r2 }] = await q1(`INSERT INTO draft_math_image_resolutions (draft_paper_id, fingerprint, revision, representation, teacher_input, verified_by)
    VALUES ($1, $2, 1, '\\(1\\)', '1', $3) RETURNING id`, [p2, fp, db.teacher])
  await q1(`INSERT INTO draft_math_image_placement_log (draft_paper_id, resolution_id, fingerprint, revision, placement_key, side, draft_question_id, target, outcome, actor)
    VALUES ($1, $2, $3, 1, '1@0,0', 'en', gen_random_uuid(), 'STEM', 'APPLIED', $4)`, [p2, r2, fp, db.teacher])
  await assert.rejects(db.pool.query('DELETE FROM draft_math_image_placement_log WHERE draft_paper_id = $1', [p2]), /KSC_MATH_LOG_APPEND_ONLY/)
  await assert.rejects(db.pool.query('DELETE FROM draft_math_image_resolutions WHERE draft_paper_id = $1', [p2]), /KSC_MATH_HISTORY_IMMUTABLE/)
  await assert.rejects(q1(`INSERT INTO draft_math_image_resolutions (draft_paper_id, fingerprint, revision, representation, teacher_input, verified_by)
    VALUES ($1, $2, 2, '\\(\\text{x}\\)', 'x', $3)`, [p2, fp, db.teacher]), /check constraint/)
  await db.pool.query('DELETE FROM draft_papers WHERE id = $1', [p2])
  assert.equal((await q1('SELECT count(*)::int n FROM draft_math_image_resolutions WHERE draft_paper_id = $1', [p2]))[0].n, 0)
  assert.equal((await q1('SELECT count(*)::int n FROM draft_math_image_placement_log WHERE draft_paper_id = $1', [p2]))[0].n, 0)
  assert.ok((await q1('SELECT count(*)::int n FROM draft_math_image_placement_log WHERE draft_paper_id = $1', [paperId]))[0].n > 0, 'the golden paper\'s history is intact')
})
