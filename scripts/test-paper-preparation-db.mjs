import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { createLocalKscDb, createImport, localPreparationApi, GOLDEN_PDF, PG_BIN } from './lib/local-draft-db.mjs'
import { runPaperPreparation, PreparationError, PREPARATION_ENGINE, PREPARATION_VERSION } from './lib/paper-preparation.mjs'
import { createNodePlatform } from './lib/preparation-platform-node.mjs'

// B4.7 — "Prepare Paper Automatically": migration 0029 lifecycle + the ONE orchestrator
// (scripts/lib/paper-preparation.mjs) on a THROWAWAY local PostgreSQL cluster with the full KSC
// chain. Failures are injected at several stages; retry, untouched rerun, concurrency and the
// teacher-work refusal are checked against persisted state. Never connects to Supabase.

const HAVE_PG = ['initdb', 'pg_ctl', 'psql'].every(n => fs.existsSync(path.join(PG_BIN, process.platform === 'win32' ? `${n}.exe` : n)))
const HAVE_PDF = fs.existsSync(GOLDEN_PDF)
const skip = !HAVE_PG ? 'local PostgreSQL binaries not found' : false
const skipGolden = skip || (!HAVE_PDF && 'golden PDF not available')

let db
const pdfBytes = () => fs.readFileSync(GOLDEN_PDF)
const rpc = (uid, name, args) => db.runner.rpc(uid, name, args)
const status = (importId, uid = db.teacher) => rpc(uid, 'ksc_paper_preparation_status', { p_import_id: importId })
const start = (importId, uid = db.teacher) => rpc(uid, 'ksc_start_paper_preparation', { p_import_id: importId, p_engine: PREPARATION_ENGINE, p_engine_version: PREPARATION_VERSION, p_client: { platform: 'test' } })
const rows = async (sql, args = []) => (await db.pool.query(sql, args)).rows
async function rejects(p, pattern) {
  try { await p } catch (e) { assert.match([e.message, e.hint, e.detail].filter(Boolean).join(' '), pattern); return e }
  assert.fail(`expected rejection matching ${pattern}`)
}
async function ageHeartbeat(runId, seconds) {
  const c = await db.pool.connect()
  try {
    await c.query('BEGIN'); await c.query(`SELECT set_config('ksc.preparation_rpc', 'on', true)`)
    await c.query(`UPDATE public.draft_analysis_runs SET heartbeat_at = now() - make_interval(secs => $2) WHERE id = $1`, [runId, seconds])
    await c.query('COMMIT')
  } finally { c.release() }
}
function prepare(importRecord, { api = localPreparationApi(db, db.teacher), hooks = {} } = {}) {
  return runPaperPreparation({ platform: createNodePlatform(), api, importRecord, teacherId: db.teacher, pdfBytes: pdfBytes(), hooks })
}

before(async () => { if (!skip) db = await createLocalKscDb() })
after(async () => { await db?.stop() })

test('migration chain 0017-0029 is hash-locked; 0029 touches no publish/attempt/Exam Engine object', () => {
  const locked = {
    '202609220017_draft_paper_foundation.sql': '255c022d8febdc3ed6d49f3dad99b4ca306aaf97443562914c285512d26b5eba',
    '202609220018_draft_manual_questions.sql': 'd4264129070b67e49afefcb37b78ac699997f53994851c5c02a442a6ebf48260',
    '202609220019_draft_media.sql': '82d92f025cc5b991dd6a8471960834a954653c0b9e70702e5296c2d926f66901',
    '202609220020_draft_option_conflict_resolution.sql': '7802f26c1636e7dedd4383727d57264aed3ab6fedc7fe39621a833a36afcbfcf',
    '202609220021_draft_option_uniqueness.sql': 'fa7e17d5ccdd90dcf8823dc34330cac25fe8746edf0aeb66b5d3c1dd3d9255de',
    '202609220022_draft_language_texts.sql': 'c89c8c13c6abcc6ee6f6622f67f3fcba510ff061963bf90d88e9376bde70c90a',
    '202609222350_draft_material_legacy_glyph_quarantine.sql': 'cd8d939c57c2e903109895491a0f32dbcaa475870e4a843fac7afe292b1f61d2',
    '202609230023_draft_analysis_automation.sql': '6da5b1db7a5aa19a367e99f0d2848d7cb738c7e9c2e5115a17a29024d40973c8',
    '202609230024_draft_auto_visuals.sql': 'b0df618931c391c906cc426a131491dc4e5ce7e2e5406a0344aaad5dba0451b3',
    '202609230025_draft_auto_telugu_ocr.sql': 'c60fab17bf7e2f3d7f505783565819db4a9505a02258057375177ee2254780c9',
    '202609230026_draft_shared_materials.sql': '57e5774e840f7c1dfa1d3cdfedfe3593085cfa13f4b8399ceb2a3d4b1f7d8f36',
    '202609230027_draft_review_items.sql': 'd26d5457463fbbdceb8fd8b5d1212627db95064c946cc759ff83491d76673a17',
    '202609230028_draft_language_history_protection.sql': '03849731c2db96337b03793eb7a1f2fe7120fd4a19a5b8f895ffd74dd3ebdc0e',
    '202609230029_draft_paper_preparation_lifecycle.sql': 'abe1082f2125dbac15f2182149dffdae70d4b27907f67c5e90bca70c3d7bb2c5',
    '202609240030_draft_media_source_region_provenance_restore.sql': '715b90412479ab093b8d6f239d81ce3f33ac15033945cfea58917fbca8df1315',
    '202609240031_draft_review_item_reconciliation.sql': '12ecc8eb61284a14037d7e9f4a7026adb30cf90112a2d68e2a1ecefe854e3804',   // B4.8.2
  }
  for (const [file, hash] of Object.entries(locked)) {
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(`supabase/migrations/${file}`)).digest('hex'), hash, `${file} changed`)
  }
  // 0031 writes review-item status only: never answers, options, texts, attempts or the Question Bank.
  const c31 = fs.readFileSync('supabase/migrations/202609240031_draft_review_item_reconciliation.sql', 'utf8').replace(/--.*$/gm, '')
  for (const forbidden of ['publish_test', 'test_attempts', 'attempt_answers', 'question_bank', 'is_confirmed_correct', 'UPDATE public.draft_options', 'UPDATE public.draft_questions',
    'draft_question_texts', 'draft_option_texts', 'DELETE FROM']) {
    assert.ok(!c31.includes(forbidden), `0031 must not reference ${forbidden}`)
  }
  const code = fs.readFileSync('supabase/migrations/202609230029_draft_paper_preparation_lifecycle.sql', 'utf8').replace(/--.*$/gm, '')
  for (const forbidden of ['publish_test', 'test_attempts', 'attempt_answers', 'test_question_snapshots', 'test_option_snapshots', 'question_bank', 'is_confirmed_correct = true']) {
    assert.ok(!code.includes(forbidden), `0029 must not reference ${forbidden}`)
  }
})

test('lifecycle: RPC-only state, one running run per import, stale run interrupted, failure recorded, isolation', { skip }, async () => {
  const imp = await createImport(db, { testName: 'lifecycle' })
  assert.equal((await status(imp.id)).state, 'UPLOADED')

  // Two tabs / double click: concurrent starts -> exactly one run.
  const both = await Promise.allSettled([start(imp.id), start(imp.id)])
  assert.equal(both.filter(r => r.status === 'fulfilled').length, 1)
  assert.match(both.find(r => r.status === 'rejected').reason.message, /KSC_PREPARATION_IN_PROGRESS/)
  const runA = both.find(r => r.status === 'fulfilled').value.run_id
  assert.equal((await rows(`SELECT count(*)::int n FROM public.draft_analysis_runs WHERE source_import_id = $1`, [imp.id]))[0].n, 1)
  assert.equal((await status(imp.id)).state, 'RUNNING')

  // State changes only through the RPCs: a teacher cannot mark the run prepared/succeeded directly.
  await rejects(db.runner.asUser(db.teacher, c => c.query(`UPDATE public.draft_analysis_runs SET preparation_state = 'PREPARED' WHERE id = $1`, [runA])), /KSC_PREPARATION_RPC_ONLY/)
  await rejects(db.runner.asUser(db.teacher, c => c.query(`UPDATE public.draft_analysis_runs SET status = 'SUCCEEDED' WHERE id = $1`, [runA])), /KSC_PREPARATION_RPC_ONLY/)
  // Completing without a written Draft and review items is refused.
  await rejects(rpc(db.teacher, 'ksc_complete_paper_preparation', { p_run_id: runA, p_summary: {} }), /KSC_PREPARATION_DRAFT_NOT_WRITTEN/)
  await rejects(rpc(db.teacher, 'ksc_paper_preparation_progress', { p_run_id: runA, p_stage: 'NOT_A_STAGE', p_detail: {} }), /KSC_PREPARATION_STAGE_INVALID/)

  // Another teacher: cannot start, read status or report progress on this import.
  await rejects(start(imp.id, db.otherTeacher), /not found or unauthorized/i)
  await rejects(rpc(db.otherTeacher, 'ksc_paper_preparation_progress', { p_run_id: runA, p_stage: 'READING_PAPER', p_detail: {} }), /not found or unauthorized/i)
  const other = await status(imp.id, db.otherTeacher).catch(e => e)
  assert.ok(other instanceof Error || other.state === 'UPLOADED' && !other.draft_paper_id, 'no preparation data leaks to another teacher')

  // Refresh / closed tab: no heartbeat for >120 s -> INTERRUPTED; a new start takes over and the old run is stopped.
  await ageHeartbeat(runA, 180)
  assert.equal((await status(imp.id)).state, 'INTERRUPTED')
  const runB = (await start(imp.id)).run_id
  assert.equal((await rows(`SELECT preparation_state FROM public.draft_analysis_runs WHERE id = $1`, [runA]))[0].preparation_state, 'INTERRUPTED')
  await rejects(rpc(db.teacher, 'ksc_paper_preparation_progress', { p_run_id: runA, p_stage: 'READING_PAPER', p_detail: {} }), /KSC_PREPARATION_NOT_RUNNING/)

  // Failure: stage, code and teacher message persisted; the technical cause stays in detail only.
  await rpc(db.teacher, 'ksc_fail_paper_preparation', { p_run_id: runB, p_stage: 'READING_TELUGU', p_code: 'OCR_MODEL_UNAVAILABLE', p_message: 'Reading Telugu: model unavailable', p_detail: { technical: 'HTTP 503' } })
  const failed = await status(imp.id)
  assert.equal(failed.state, 'FAILED'); assert.equal(failed.failure_stage, 'READING_TELUGU'); assert.equal(failed.failure_code, 'OCR_MODEL_UNAVAILABLE')
  assert.ok(!JSON.stringify(failed).includes('HTTP 503'), 'technical detail is not part of the teacher status')
  // A late failure report from a stale tab never overwrites a finished run's outcome.
  assert.deepEqual(await rpc(db.teacher, 'ksc_fail_paper_preparation', { p_run_id: runB, p_stage: 'SAVING_DRAFT', p_code: 'X', p_message: 'again', p_detail: {} }), { recorded: false, state: 'FAILED' })
  assert.equal((await status(imp.id)).failure_code, 'OCR_MODEL_UNAVAILABLE')
  // Retry after failure is allowed.
  const runC = (await start(imp.id)).run_id
  assert.notEqual(runC, runB)
  await rpc(db.teacher, 'ksc_fail_paper_preparation', { p_run_id: runC, p_stage: 'READING_PAPER', p_code: 'UNEXPECTED', p_message: 'stop', p_detail: {} })
})

test('unreadable PDF fails at "Reading paper" with no Draft', { skip }, async () => {
  const imp = await createImport(db, { testName: 'unreadable' })
  const err = await runPaperPreparation({ platform: createNodePlatform(), api: localPreparationApi(db, db.teacher), importRecord: imp, teacherId: db.teacher,
    pdfBytes: Buffer.from('%PDF-1.4\nnot a pdf\n%%EOF') }).catch(e => e)
  assert.ok(err instanceof PreparationError); assert.equal(err.code, 'PDF_UNREADABLE'); assert.equal(err.stage, 'READING_PAPER')
  const s = await status(imp.id)
  assert.equal(s.state, 'FAILED'); assert.equal(s.failure_stage, 'READING_PAPER'); assert.equal(s.draft_paper_id, null)
  assert.doesNotMatch(s.failure_message, /\n\s+at |Error:|stack|Invalid PDF structure/i, 'no stack trace or technical cause for teachers')
})

test('golden paper: failures at three stages never look prepared; retry, untouched rerun and teacher-work refusal', { skip: skipGolden, timeout: 900_000 }, async () => {
  const imp = await createImport(db, { testName: 'SI/Constable Test-10 (golden)' })

  // (1) Failure before anything is saved: Detecting figures.
  let err = await prepare(imp, { hooks: { beforeStage: s => { if (s === 'DETECTING_FIGURES') throw new Error('injected figure failure') } } }).catch(e => e)
  assert.equal(err.stage, 'DETECTING_FIGURES'); assert.equal(err.code, 'UNEXPECTED')
  let s = await status(imp.id)
  assert.equal(s.state, 'FAILED'); assert.equal(s.failure_stage, 'DETECTING_FIGURES'); assert.equal(s.draft_paper_id, null)

  // (2) Failure while saving: the 100th source-crop upload fails after the Draft rows are written.
  const api2 = localPreparationApi(db, db.teacher)
  let n = 0
  const up = api2.storage.upload
  api2.storage.upload = async (...a) => (++n === 100 ? { error: new Error('injected upload failure') } : up(...a))
  err = await prepare(imp, { api: api2 }).catch(e => e)
  assert.equal(err.stage, 'SAVING_DRAFT'); assert.equal(err.code, 'SAVE_FAILED')
  s = await status(imp.id)
  assert.equal(s.state, 'FAILED'); assert.equal(s.failure_stage, 'SAVING_DRAFT'); assert.equal(s.teacher_work, false)

  // (3) Failure after the Draft is fully saved: review generation. Still not prepared.
  const api3 = localPreparationApi(db, db.teacher)
  const rpc3 = api3.rpc
  api3.rpc = (name, args) => (name === 'ksc_replace_review_items' ? Promise.resolve({ data: null, error: { message: 'injected review failure' } }) : rpc3(name, args))
  err = await prepare(imp, { api: api3 }).catch(e => e)
  assert.equal(err.stage, 'PREPARING_REVIEW'); assert.equal(err.code, 'REVIEW_FAILED')
  s = await status(imp.id)
  assert.equal(s.state, 'FAILED'); assert.equal(s.failure_stage, 'PREPARING_REVIEW'); assert.ok(s.draft_paper_id, 'the partial Draft exists')
  assert.notEqual(s.state, 'PREPARED')

  // (4) Safe retry over the automatic (untouched) partial Draft -> PREPARED.
  const stages = []
  const first = await prepare(imp, { hooks: { onProgress: p => { if (stages.at(-1) !== p.stage) stages.push(p.stage) } } })
  assert.deepEqual(stages, ['READING_PAPER', 'DETECTING_QUESTIONS', 'DETECTING_FIGURES', 'READING_TELUGU', 'SAVING_DRAFT', 'PREPARING_REVIEW', 'COMPLETE'])
  s = await status(imp.id)
  assert.equal(s.state, 'PREPARED'); assert.equal(s.draft_paper_id, first.draftPaperId); assert.equal(s.teacher_work, false)
  const paper = first.draftPaperId

  // Golden acceptance, from persisted rows.
  const c = s.counts
  assert.equal(c.questions, 200)
  assert.equal(c.ready + c.quick_check + c.manual_review, 200)
  // Node platform = the B4.5R-validated pipeline output (reports/b4-preview/draft-dump.json). The browser
  // platform rasterises slightly differently, so its counts differ a little (see docs/ksc/HANDOFF.md, B4.7).
  assert.deepEqual({ ready: c.ready, quick: c.quick_check, manual: c.manual_review, blocking: c.open_blocking, optional: c.open_optional },
    { ready: 67, quick: 114, manual: 19, blocking: 263, optional: 478 })   // B4.8.4B decoder routing (B4.8.3B: 58/123/19, 334, 407; B4.8.2: 57/124/19, 341, 408; B4.5R: 54/121/25, 358, 397)
  const optDist = await rows(`SELECT n::int, count(*)::int q FROM (SELECT count(o.id) n FROM public.draft_questions q LEFT JOIN public.draft_options o ON o.draft_question_id = q.id
    WHERE q.draft_paper_id = $1 GROUP BY q.id) x GROUP BY n ORDER BY n`, [paper])
  assert.deepEqual(optDist, [{ n: 4, q: 200 }])   // B4.8.2: Q115/Q126/Q135 inline-marker split (was 3 x 3 options)
  assert.equal((await rows(`SELECT count(*)::int n FROM public.draft_materials WHERE draft_paper_id = $1`, [paper]))[0].n, 11)
  assert.deepEqual((await rows(`SELECT count(DISTINCT shared_material_id)::int m, count(*)::int q FROM public.draft_questions WHERE draft_paper_id = $1 AND shared_material_id IS NOT NULL`, [paper]))[0], { m: 11, q: 24 })
  const answers = (await rows(`SELECT count(*) FILTER (WHERE o.is_proposed_correct)::int proposed, count(*) FILTER (WHERE o.is_confirmed_correct)::int confirmed
    FROM public.draft_options o JOIN public.draft_questions q ON q.id = o.draft_question_id WHERE q.draft_paper_id = $1`, [paper]))[0]
  assert.deepEqual(answers, { proposed: 200, confirmed: 0 })
  const q6 = (await rows(`SELECT (SELECT marker FROM public.draft_options o WHERE o.draft_question_id = q.id AND o.is_proposed_correct) key,
    (SELECT count(*)::int FROM public.draft_media m WHERE m.draft_question_id = q.id AND m.media_kind = 'FIGURE') figures
    FROM public.draft_questions q WHERE q.draft_paper_id = $1 AND q.source_question_number = '6'`, [paper]))[0]
  assert.deepEqual(q6, { key: 'D', figures: 1 })
  const q10 = (await rows(`SELECT source_page, analysis_regions FROM public.draft_questions WHERE draft_paper_id = $1 AND source_question_number = '10'`, [paper]))[0]
  assert.equal(q10.source_page, 2); assert.ok(q10.analysis_regions.telugu.some(r => r.page === 3), 'Q10 continues on page 3')
  const versions = await rows(`SELECT DISTINCT t.ocr_version FROM public.draft_question_texts t JOIN public.draft_questions q ON q.id = t.draft_question_id
    WHERE q.draft_paper_id = $1 AND t.language = 'te' AND t.ocr_version IS NOT NULL`, [paper])
  assert.deepEqual(versions.map(v => v.ocr_version), ['7.0.0+tessdata/tel.traineddata (integer)@7d092812889d+ksc-glyph-hybrid@1.0.0'])

  // (5) Rerun an untouched automatic Draft: same Draft, everything re-owned by the new run, same counts.
  const media0 = (await rows(`SELECT count(*)::int n FROM public.draft_media WHERE draft_paper_id = $1`, [paper]))[0].n
  const second = await prepare(imp)
  assert.equal(second.draftPaperId, paper); assert.notEqual(second.runId, first.runId)
  s = await status(imp.id)
  assert.equal(s.state, 'PREPARED'); assert.deepEqual(s.counts, c)
  assert.equal((await rows(`SELECT count(*)::int n FROM public.draft_questions WHERE draft_paper_id = $1 AND analysis_run_id IS DISTINCT FROM $2`, [paper, second.runId]))[0].n, 0)
  assert.equal((await rows(`SELECT count(*)::int n FROM public.draft_review_items WHERE draft_paper_id = $1 AND origin_run_id IS DISTINCT FROM $2`, [paper, second.runId]))[0].n, 0)
  assert.equal((await rows(`SELECT count(*)::int n FROM public.draft_media WHERE draft_paper_id = $1`, [paper]))[0].n, media0)
  assert.equal((await rows(`SELECT count(*)::int n FROM public.draft_analysis_runs WHERE source_import_id = $1 AND preparation_state = 'RUNNING'`, [imp.id]))[0].n, 0)

  // (6) Teacher work: one review decision, then automatic preparation is refused and nothing changes.
  const item = (await rows(`SELECT id FROM public.draft_review_items WHERE draft_paper_id = $1 AND item_type = 'TELUGU_STEM' AND status = 'OPEN' ORDER BY item_key LIMIT 1`, [paper]))[0]
  await rpc(db.teacher, 'ksc_resolve_telugu_review_item', { p_item_id: item.id, p_action: 'ACCEPT', p_text: null, p_note: null })
  s = await status(imp.id)
  assert.equal(s.teacher_work, true); assert.equal(s.state, 'PREPARED')
  const runsBefore = (await rows(`SELECT count(*)::int n FROM public.draft_analysis_runs WHERE source_import_id = $1`, [imp.id]))[0].n
  err = await prepare(imp).catch(e => e)
  assert.equal(err.code, 'TEACHER_WORK')
  assert.match(err.message, /teacher changes/)
  assert.equal((await rows(`SELECT count(*)::int n FROM public.draft_analysis_runs WHERE source_import_id = $1`, [imp.id]))[0].n, runsBefore, 'no run is created')
  assert.equal((await rows(`SELECT status FROM public.draft_review_items WHERE id = $1`, [item.id]))[0].status, 'RESOLVED')
  s = await status(imp.id)
  assert.equal(s.state, 'PREPARED'); assert.equal(s.counts.open_blocking, c.open_blocking - 1)
})
