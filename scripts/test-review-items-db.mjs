import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto, { randomUUID } from 'crypto'
import { mapPaperModelToDraft, B4_ENGINE, B4_ENGINE_VERSION } from './lib/paper-model-to-draft.mjs'
import { persistAutoVisuals } from './lib/auto-visual-persistence.mjs'
import { persistAutoMaterialMedia } from './lib/auto-material-persistence.mjs'
import { persistAutoTelugu } from './lib/auto-telugu-persistence.mjs'
import { buildReviewItems, deriveReadiness, REVIEW_GENERATOR, REVIEW_GENERATOR_VERSION } from './lib/review-items.mjs'

// B4.5 — review items, verification provenance and derived readiness (migration 0027) on a
// THROWAWAY local PostgreSQL cluster, with the real golden-paper pipeline outputs. Never connects
// to Supabase; storage is an in-memory double.

const PG_BIN = process.env.KSC_PG_BIN || 'C:/Program Files/PostgreSQL/16/bin'
const exe = n => path.join(PG_BIN, process.platform === 'win32' ? `${n}.exe` : n)
const HAVE_PG = fs.existsSync(exe('initdb')) && fs.existsSync(exe('pg_ctl')) && fs.existsSync(exe('psql'))
const INPUTS = ['reports/b41-paper-model.json', 'reports/b43/b43-manifest.json', 'reports/b44/b44-benchmark.json']
const HAVE_INPUTS = INPUTS.every(f => fs.existsSync(f))
const MIG = n => path.resolve(`supabase/migrations/${n}`)
const CHAIN = ['202609220017_draft_paper_foundation.sql', '202609220018_draft_manual_questions.sql',
  '202609220019_draft_media.sql', '202609220020_draft_option_conflict_resolution.sql',
  '202609220021_draft_option_uniqueness.sql', '202609220022_draft_language_texts.sql',
  '202609230023_draft_analysis_automation.sql', '202609230024_draft_auto_visuals.sql', '202609230025_draft_auto_telugu_ocr.sql',
  '202609230026_draft_shared_materials.sql']
const M27 = MIG('202609230027_draft_review_items.sql')

let dataDir, port, model, b43, b44
const A = randomUUID(), B = randomUUID()
const imp = randomUUID()
const run = args => execFileSync(exe('psql'), ['-h', 'localhost', '-p', String(port), '-U', 'postgres', '-d', 'postgres',
  '-v', 'ON_ERROR_STOP=1', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PGCLIENTENCODING: 'UTF8' }, maxBuffer: 256 * 1024 * 1024 })
const psql = sql => {
  const tmp = path.join(dataDir, `q_${randomUUID()}.sql`)
  fs.writeFileSync(tmp, sql, 'utf8')
  try { return run(['-At', '-f', tmp]).trim() } finally { fs.rmSync(tmp, { force: true }) }
}
const lastLine = out => out.split(/\r?\n/).filter(Boolean).pop() ?? ''
const asUser = (uid, sql) => lastLine(psql(`SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', '${uid}', false); ${sql}`))
const asAnon = sql => lastLine(psql(`SET ROLE anon; ${sql}`))
const count = sql => Number(psql(sql))
const J = v => '$j$' + JSON.stringify(v) + '$j$'
const T = v => '$t$' + v + '$t$'
function expectError(fn, pattern) {
  try { fn() } catch (e) { assert.match(String(e.stderr || e.message), pattern); return }
  assert.fail(`expected an error matching ${pattern}`)
}
const store = { objects: new Map(), async upload(p, b) { this.objects.set(p, b); return { error: null } }, async remove(ps) { for (const p of ps) this.objects.delete(p); return { error: null } } }
const rpcAs = uid => async (name, a) => {
  try {
    const sql = name === 'ksc_replace_auto_telugu'
      ? `SELECT public.${name}('${a.p_draft_paper_id}', '${a.p_run_id}', ${T(a.p_ocr_engine)}, ${T(a.p_ocr_version)}, ${J(a.p_media)}::jsonb, ${J(a.p_question_texts)}::jsonb, ${J(a.p_option_texts)}::jsonb)`
      : `SELECT public.${name}('${a.p_draft_paper_id}', '${a.p_run_id}', ${J(a.p_media)}::jsonb)`
    return { data: JSON.parse(asUser(uid, sql)), error: null }
  } catch (e) { return { data: null, error: new Error(String(e.stderr || e.message)) } }
}

const STUBS = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $$;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated;
CREATE SCHEMA ksc_private;
REVOKE ALL ON SCHEMA ksc_private FROM PUBLIC;
CREATE FUNCTION ksc_private.provision_student() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
CREATE TABLE public.teacher_profiles (id uuid PRIMARY KEY);
CREATE FUNCTION public.is_teacher() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$ SELECT EXISTS (SELECT 1 FROM public.teacher_profiles WHERE id = auth.uid()) $$;
CREATE TABLE public.exams (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
CREATE TABLE public.exam_levels (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
CREATE TABLE public.exam_subjects (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
CREATE TABLE public.test_imports (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_by uuid REFERENCES auth.users(id));
CREATE FUNCTION public.ksc_touch_test_import_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END $$;
GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT SELECT ON public.test_imports TO authenticated;
`

let paperId, runId, payload
const snapshot = () => JSON.parse(psql(`SELECT json_build_object(
  'materials', (SELECT coalesce(json_agg(json_build_object('row', m, 'media',
      (SELECT coalesce(json_agg(dm ORDER BY dm.media_kind, dm.position), '[]') FROM public.draft_media dm WHERE dm.draft_material_id = m.id)) ORDER BY m.position), '[]')
    FROM public.draft_materials m WHERE m.draft_paper_id = '${paperId}'),
  'questions', (SELECT json_agg(json_build_object('row', q,
      'media', (SELECT coalesce(json_agg(dm ORDER BY dm.media_kind, dm.position), '[]') FROM public.draft_media dm WHERE dm.draft_question_id = q.id),
      'texts', (SELECT coalesce(json_agg(t), '[]') FROM public.draft_question_texts t WHERE t.draft_question_id = q.id),
      'options', (SELECT json_agg(json_build_object('row', o,
          'texts', (SELECT coalesce(json_agg(ot), '[]') FROM public.draft_option_texts ot WHERE ot.draft_option_id = o.id)) ORDER BY o.position)
        FROM public.draft_options o WHERE o.draft_question_id = q.id)) ORDER BY q.position)
    FROM public.draft_questions q WHERE q.draft_paper_id = '${paperId}'))`))
const items = () => JSON.parse(psql(`SELECT coalesce(json_agg(i ORDER BY i.item_key), '[]') FROM public.draft_review_items i WHERE draft_paper_id='${paperId}'`))
const readiness = () => JSON.parse(psql(`SELECT json_agg(json_build_object('id', draft_question_id, 'n', source_question_number::int, 'r', readiness, 'b', open_blocking) ORDER BY position)
  FROM public.draft_question_readiness WHERE draft_paper_id='${paperId}'`))
const tally = rows => rows.reduce((o, r) => (o[r.r] = (o[r.r] || 0) + 1, o), {})
const answers = () => psql(`SELECT md5(string_agg(o.id || ':' || coalesce(o.content, '∅') || ':' || o.is_proposed_correct || ':' || o.is_confirmed_correct, ',' ORDER BY o.id))
  FROM public.draft_options o JOIN public.draft_questions q ON q.id = o.draft_question_id WHERE q.draft_paper_id='${paperId}'`)
const confirmed = () => count(`SELECT count(*) FROM public.draft_options o JOIN public.draft_questions q ON q.id=o.draft_question_id WHERE q.draft_paper_id='${paperId}' AND o.is_confirmed_correct`)
const teluguRes = (uid, itemId, action, text = null, note = null) =>
  JSON.parse(asUser(uid, `SELECT public.ksc_resolve_telugu_review_item('${itemId}', '${action}', ${text === null ? 'NULL' : T(text)}, ${note === null ? 'NULL' : T(note)})`))
const otherRes = (uid, itemId, resolution, note = null) =>
  JSON.parse(asUser(uid, `SELECT public.ksc_resolve_review_item('${itemId}', '${resolution}', ${note === null ? 'NULL' : T(note)})`))
const textRow = (tbl, id) => JSON.parse(psql(`SELECT row_to_json(t) FROM public.${tbl} t WHERE id='${id}'`))
const itemRow = id => JSON.parse(psql(`SELECT row_to_json(i) FROM public.draft_review_items i WHERE id='${id}'`))
const teacherWork = () => psql(`SELECT public.ksc_draft_has_teacher_work('${paperId}')`)

before(async () => {
  if (!HAVE_PG || !HAVE_INPUTS) return
  model = JSON.parse(fs.readFileSync(INPUTS[0], 'utf8'))
  b43 = JSON.parse(fs.readFileSync(INPUTS[1], 'utf8'))
  b44 = JSON.parse(fs.readFileSync(INPUTS[2], 'utf8'))
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ksc-b45-pg-'))
  port = 55000 + Math.floor(Math.random() * 900)
  execFileSync(exe('initdb'), ['-D', dataDir, '-U', 'postgres', '-A', 'trust', '-E', 'UTF8', '--no-locale'], { stdio: 'ignore' })
  execFileSync(exe('pg_ctl'), ['-D', dataDir, '-l', path.join(dataDir, 'server.log'), '-o', `-p ${port} -c listen_addresses=localhost`, '-w', 'start'], { stdio: 'ignore' })
  psql(STUBS)
  psql(`INSERT INTO auth.users VALUES ('${A}'), ('${B}'); INSERT INTO public.teacher_profiles VALUES ('${A}'), ('${B}');
        INSERT INTO public.test_imports (id, created_by) VALUES ('${imp}', '${A}');`)
  for (const f of CHAIN) run(['-q', '-f', MIG(f)])
  // The automatic Draft, exactly as the pipeline writes it (writer v3 -> visuals -> material media -> Telugu).
  payload = mapPaperModelToDraft(model, { importId: imp, title: 'SI/CONSTABLE TEST-10', sourceFilename: 'si.pdf', visuals: b43 })
  runId = asUser(A, `SELECT public.ksc_start_draft_analysis_run('${imp}', '${B4_ENGINE}', '${B4_ENGINE_VERSION}', '{}'::jsonb)`)
  paperId = JSON.parse(asUser(A, `SELECT public.ksc_replace_draft_analysis_v3('${imp}', '${runId}', ${J(payload.paper)}::jsonb, ` +
    `${J(payload.materials)}::jsonb, ${J(payload.questions)}::jsonb, ${J(payload.options)}::jsonb)`)).draft_paper_id
  const qIds = new Map(psql(`SELECT source_question_number || '|' || id FROM public.draft_questions WHERE draft_paper_id='${paperId}'`).split(/\r?\n/).filter(Boolean).map(l => l.split('|')))
  const optionsByKey = new Map(JSON.parse(psql(`SELECT coalesce(json_agg(json_build_object('k', q.source_question_number || '|' || o.marker, 'id', o.id, 'content', o.content)), '[]')
    FROM public.draft_options o JOIN public.draft_questions q ON q.id = o.draft_question_id WHERE q.draft_paper_id='${paperId}'`)).map(r => [r.k, { id: r.id, content: r.content }]))
  const readB43 = e => fs.readFileSync(path.join('reports/b43', e.file))
  await persistAutoVisuals({ rows: b43.accepted, questionIdByNumber: qIds, teacherId: A, draftPaperId: paperId, runId, readCrop: readB43, storage: store, rpc: rpcAs(A) })
  await persistAutoMaterialMedia({ manifest: b43, materialIdByIndex: new Map(payload.materials.map(m => [m.position, m.id])), teacherId: A, draftPaperId: paperId,
    runId, readCrop: readB43, storage: store, rpc: rpcAs(A) })
  await persistAutoTelugu({ benchmark: b44, questionIdByNumber: qIds, optionsByKey, teacherId: A, draftPaperId: paperId, runId,
    readCrop: r => fs.readFileSync(path.join('reports/b44', r.file)), storage: store, rpc: rpcAs(A) })
})
after(() => {
  if (!HAVE_PG || !dataDir) return
  try { execFileSync(exe('pg_ctl'), ['-D', dataDir, '-m', 'immediate', '-w', 'stop'], { stdio: 'ignore' }) } catch {}
  try { fs.rmSync(dataDir, { recursive: true, force: true }) } catch {}
})
const skip = !HAVE_PG ? 'PostgreSQL binaries not found (set KSC_PG_BIN)' : !HAVE_INPUTS ? 'run the B4.1/B4.3/B4.4 tools first' : false

let answersBefore, generated
const byType = (type, pred = () => true) => items().filter(i => i.item_type === type && i.status === 'OPEN' && pred(i))
const n = number => i => i.detail?.number === number
const TE = /[ఀ-౿]/
const teluguAttempt = i => i.detail.stored === false && TE.test(i.extracted_value || '')

test('0027 applies on top of 0017-0026 and is idempotent; tables are read-only to clients', { skip }, () => {
  run(['-q', '-f', M27]); run(['-q', '-f', M27])
  for (const c of ['draft_review_items_exactly_one_owner', 'draft_review_items_route_blocking', 'draft_review_items_resolution_consistent',
    'draft_question_texts_verification_provenance', 'draft_option_texts_verification_state_valid', 'draft_material_texts_no_legacy_glyphs']) {
    assert.equal(count(`SELECT count(*) FROM pg_constraint WHERE conname='${c}'`), 1, c)
  }
  for (const tbl of ['draft_review_items', 'draft_material_texts']) {
    for (const priv of ['INSERT', 'UPDATE', 'DELETE']) assert.equal(psql(`SELECT has_table_privilege('authenticated', 'public.${tbl}', '${priv}')`), 'f', `${tbl} ${priv}`)
    assert.equal(psql(`SELECT has_table_privilege('anon', 'public.${tbl}', 'SELECT')`), 'f')
  }
  assert.equal(psql(`SELECT has_function_privilege('anon', 'public.ksc_resolve_telugu_review_item(uuid,text,text,text)', 'EXECUTE')`), 'f')
  assert.equal(psql(`SELECT has_function_privilege('authenticated', 'public.ksc_review_item_for_update(uuid)', 'EXECUTE')`), 'f', 'internal helper not callable')
})

test('writer: 741 items from the persisted golden Draft; view readiness = pure derivation = 58/123/19 (B4.8.3B)', { skip }, () => {
  generated = buildReviewItems(snapshot(), { visualCandidates: b43 })
  const out = JSON.parse(asUser(A, `SELECT public.ksc_replace_review_items('${paperId}', '${runId}', ${T(REVIEW_GENERATOR + '@' + REVIEW_GENERATOR_VERSION)}, ${J(generated)}::jsonb)`))
  assert.equal(out.items, 741)   // B4.8.3B: 749 -> 741 (reports/b483b/before-after.json); B4.8.2: 755 -> 749
  assert.equal(psql(`SELECT metrics->>'reviewItems' FROM public.draft_analysis_runs WHERE id='${runId}'`), '741')
  const view = readiness()
  assert.deepEqual(tally(view), { READY: 58, QUICK_CHECK: 123, MANUAL_REVIEW: 19 })   // B4.8.2 57/124/19; B4.5R 54/121/25
  const pure = new Map(deriveReadiness(snapshot(), items()).map(r => [r.draft_question_id, r.readiness]))
  assert.ok(view.every(r => pure.get(r.id) === r.r))
  assert.equal(teacherWork(), 'f', 'generating items is not teacher work')
  // Re-generation on an untouched Draft is allowed and idempotent.
  asUser(A, `SELECT public.ksc_replace_review_items('${paperId}', '${runId}', 'g', ${J(generated)}::jsonb)`)
  assert.equal(count(`SELECT count(*) FROM public.draft_review_items WHERE draft_paper_id='${paperId}'`), 741)
  answersBefore = answers()
  assert.equal(confirmed(), 0)
})

test('writer refuses bad owners, cross-paper targets and foreign papers', { skip }, () => {
  const good = byType('TELUGU_STEM')[0]
  const base = { item_key: 'X:1', item_type: 'STRUCTURE', route: 'MANUAL_REVIEW', blocking: true, effort: 'MANUAL_INVESTIGATION', machine_reasons: [] }
  const call = (uid, it) => asUser(uid, `SELECT public.ksc_replace_review_items('${paperId}', '${runId}', 'g', ${J(it)}::jsonb)`)
  expectError(() => call(A, [{ ...base, draft_question_id: good.draft_question_id, draft_option_id: byType('TELUGU_OPTION')[0].draft_option_id }]), /exactly_one_owner/)
  expectError(() => call(A, [{ ...base, route: 'ADVISORY' }].map(x => ({ ...x, draft_question_id: good.draft_question_id }))), /route_blocking/)
  expectError(() => call(A, [{ ...base, draft_question_id: good.draft_question_id, target_question_text_id: byType('TELUGU_STEM')[1].target_question_text_id }]), /KSC_REVIEW_ITEM_TARGET_MISMATCH/)
  expectError(() => call(B, []), /Draft paper not found or unauthorized/)
  assert.equal(count(`SELECT count(*) FROM public.draft_review_items WHERE draft_paper_id='${paperId}'`), 741, 'refused writes changed nothing')
})

test('ACCEPT ignores a forged item value: the OCR attempt is read from the writer\'s crop, not the item', { skip }, () => {
  // Item values are client-supplied; a forged "OCR" value must never become OCR_EXTRACTED text.
  const forgedKey = generated.find(i => i.item_type === 'TELUGU_OPTION' && i.detail.stored === false && !i.extracted_value).item_key
  const forged = generated.map(i => i.item_key === forgedKey ? { ...i, extracted_value: 'నకిలీ పాఠం' } : i)
  asUser(A, `SELECT public.ksc_replace_review_items('${paperId}', '${runId}', 'g', ${J(forged)}::jsonb)`)
  const it = items().find(i => i.item_key === forgedKey)
  expectError(() => teluguRes(A, it.id, 'ACCEPT'), /KSC_NOTHING_TO_ACCEPT/)
  assert.equal(textRow('draft_option_texts', it.target_option_text_id).text_quality, 'MISSING')
  assert.equal(teacherWork(), 'f', 'the refused call left no trace')
  asUser(A, `SELECT public.ksc_replace_review_items('${paperId}', '${runId}', ${T(REVIEW_GENERATOR + '@' + REVIEW_GENERATOR_VERSION)}, ${J(generated)}::jsonb)`)
})

test('ACCEPT stored OCR: stays OCR_EXTRACTED with teacher verification; content and origin untouched', { skip }, () => {
  const it = byType('TELUGU_VERIFY', i => i.target_question_text_id)[0]
  const before = textRow('draft_question_texts', it.target_question_text_id)
  assert.deepEqual(teluguRes(A, it.id, 'ACCEPT'), { status: 'RESOLVED', resolution: 'ACCEPTED_OCR' })
  const after = textRow('draft_question_texts', it.target_question_text_id)
  assert.deepEqual([after.content, after.text_quality, after.source, after.ocr_confidence, after.ocr_engine], [before.content, 'OCR_EXTRACTED', 'EXTRACTED', before.ocr_confidence, before.ocr_engine])
  assert.deepEqual([after.verification_state, after.verified_by, after.ocr_original_content], ['VERIFIED_OCR', A, null])
  const row = itemRow(it.id)
  assert.deepEqual([row.status, row.resolution, row.resolved_by], ['RESOLVED', 'ACCEPTED_OCR', A])
  expectError(() => teluguRes(A, it.id, 'ACCEPT'), /KSC_REVIEW_ITEM_ALREADY_RESOLVED/)
})

test('ACCEPT an unstored OCR attempt: text comes from the writer\'s crop, labelled OCR + verified — never teacher-entered', { skip }, () => {
  const it = byType('TELUGU_OPTION', teluguAttempt)[0]
  const crop = JSON.parse(psql(`SELECT detection_detail FROM public.draft_media WHERE id='${it.source_media_id}'`)).ocrText
  teluguRes(A, it.id, 'ACCEPT')
  const t = textRow('draft_option_texts', it.target_option_text_id)
  assert.deepEqual([t.content, t.text_quality, t.source, t.ocr_original_content, t.verification_state], [crop, 'OCR_EXTRACTED', 'EXTRACTED', crop, 'VERIFIED_OCR'])
})

test('EDIT stored OCR: TEACHER_ENTERED with both provenances (original OCR kept, EDITED_FROM_OCR)', { skip }, () => {
  const it = byType('TELUGU_OPTION', i => i.detail.stored === true)[0]
  const before = textRow('draft_option_texts', it.target_option_text_id)
  assert.deepEqual(teluguRes(A, it.id, 'EDIT', 'సరిచేసిన పాఠం', 'fixed a digit'), { status: 'RESOLVED', resolution: 'EDITED_OCR' })
  const t = textRow('draft_option_texts', it.target_option_text_id)
  assert.deepEqual([t.content, t.text_quality, t.source, t.ocr_original_content, t.verification_state, t.verified_by],
    ['సరిచేసిన పాఠం', 'TEACHER_ENTERED', 'TEACHER', before.content, 'EDITED_FROM_OCR', A])
  assert.equal(t.ocr_engine, before.ocr_engine, 'OCR provenance kept beside the teacher text')
  assert.deepEqual([itemRow(it.id).resolution_value, itemRow(it.id).resolution_note], ['సరిచేసిన పాఠం', 'fixed a digit'])
})

test('EDIT an unstored attempt keeps the attempt as original OCR; EDIT with nothing is TRANSCRIBED', { skip }, () => {
  const att = byType('TELUGU_OPTION', teluguAttempt)[0]
  const crop = JSON.parse(psql(`SELECT detection_detail FROM public.draft_media WHERE id='${att.source_media_id}'`)).ocrText
  assert.equal(teluguRes(A, att.id, 'EDIT', 'ఎ-2, బి-4').resolution, 'EDITED_OCR')
  assert.deepEqual([textRow('draft_option_texts', att.target_option_text_id).ocr_original_content, textRow('draft_option_texts', att.target_option_text_id).verification_state], [crop, 'EDITED_FROM_OCR'])
  const none = byType('TELUGU_OPTION', i => i.detail.stored === false && !i.extracted_value)[0]
  assert.equal(teluguRes(A, none.id, 'EDIT', 'టైప్ చేసిన పాఠం').resolution, 'TRANSCRIBED')
  const t = textRow('draft_option_texts', none.target_option_text_id)
  assert.deepEqual([t.verification_state, t.ocr_original_content, t.text_quality], ['TEACHER_TRANSCRIBED', null, 'TEACHER_ENTERED'])
})

test('EDIT refuses empty text and legacy PDF glyphs; MARK_MISSING keeps the original OCR', { skip }, () => {
  const it = byType('TELUGU_STEM', i => i.detail.stored === true)[0]
  expectError(() => teluguRes(A, it.id, 'EDIT', '  '), /KSC_TELUGU_TEXT_INVALID/)
  expectError(() => teluguRes(A, it.id, 'EDIT', 'abc' + String.fromCharCode(0xE001)), /KSC_TELUGU_TEXT_INVALID/)
  expectError(() => teluguRes(A, it.id, 'SHRUG'), /KSC_TELUGU_ACTION_INVALID/)
  const before = textRow('draft_question_texts', it.target_question_text_id)
  assert.equal(teluguRes(A, it.id, 'MARK_MISSING').resolution, 'MARKED_MISSING')
  const t = textRow('draft_question_texts', it.target_question_text_id)
  assert.deepEqual([t.content, t.text_quality, t.ocr_original_content, t.verification_state], [null, 'MISSING', before.content, 'MARKED_MISSING'])
})

test('shared material Telugu: resolved once in draft_material_texts, cleared for every linked question', { skip }, () => {
  const it = byType('MATERIAL_TELUGU', i => (i.detail.appliesTo || []).length === 4)[0]
  const linked = it.detail.appliesTo
  const before = new Map(readiness().map(r => [r.n, r.b]))
  expectError(() => teluguRes(A, it.id, 'ACCEPT'), /KSC_NOTHING_TO_ACCEPT/)
  assert.equal(teluguRes(A, it.id, 'EDIT', 'సూచనలు: క్రింది సమాచారాన్ని చదవండి').resolution, 'TRANSCRIBED')
  const rows = JSON.parse(psql(`SELECT json_agg(x) FROM public.draft_material_texts x WHERE draft_material_id='${it.draft_material_id}'`))
  assert.equal(rows.length, 1)
  assert.deepEqual([rows[0].language, rows[0].text_quality, rows[0].source, rows[0].verification_state, rows[0].verified_by], ['te', 'TEACHER_ENTERED', 'TEACHER', 'TEACHER_TRANSCRIBED', A])
  const after = new Map(readiness().map(r => [r.n, r.b]))
  for (const q of linked) assert.equal(after.get(q), before.get(q) - 1, `Q${q} lost exactly the material item`)
  assert.equal([...after].filter(([q, b]) => b !== before.get(q)).length, linked.length, 'no other question changed')
  assert.equal(asUser(A, `SELECT count(*) FROM public.draft_material_texts WHERE draft_material_id='${it.draft_material_id}'`), '1', 'owner reads it')
  assert.equal(asUser(B, `SELECT count(*) FROM public.draft_material_texts`), '0', 'another teacher cannot')
})

test('answer-key and empty-option items: never accepted as is, never closed while the defect remains', { skip }, () => {
  const key = byType('ANSWER_KEY', n(41))[0]
  assert.deepEqual([key.machine_reasons, key.detail.proposedMarker], [['KEY_POINTS_AT_EMPTY_OPTION'], 'C'])
  const empties = byType('OPTION_EMPTY', n(41))
  assert.equal(empties.length, 4, 'Q41 prints its four options as stacked fractions; none was extracted')
  const empty = empties.find(i => i.detail.marker === 'C')
  expectError(() => otherRes(A, key.id, 'ACCEPTED_AS_IS', 'looks fine'), /KSC_ANSWER_ISSUE_MUST_BE_FIXED/)
  expectError(() => otherRes(A, key.id, 'RESOLVED'), /KSC_ANSWER_ISSUE_STILL_PRESENT/)
  expectError(() => otherRes(A, empty.id, 'ACCEPTED_AS_IS', 'n/a'), /KSC_EMPTY_OPTION_MUST_BE_FIXED/)
  expectError(() => otherRes(A, empty.id, 'RESOLVED'), /KSC_EMPTY_OPTION_STILL_PRESENT/)
  expectError(() => teluguRes(A, key.id, 'ACCEPT'), /KSC_NOT_A_TELUGU_ITEM/)
  assert.equal(answers(), answersBefore, 'refusals changed no option or answer flag')
  // The teacher types option C from the source crop (3/7 is printed on page 8) in the Draft
  // workspace; only then can both items close — and the answer stays proposed.
  asUser(A, `UPDATE public.draft_options SET content = '3/7' WHERE id = '${empty.draft_option_id}'`)
  assert.equal(otherRes(A, empty.id, 'RESOLVED').resolution, 'RESOLVED')
  assert.equal(otherRes(A, key.id, 'RESOLVED').resolution, 'RESOLVED')
  assert.equal(psql(`SELECT is_proposed_correct || ':' || is_confirmed_correct FROM public.draft_options WHERE id='${empty.draft_option_id}'`), 'true:false', 'still only proposed')
  assert.equal(confirmed(), 0)
})

test('other items: note required to accept as is; Telugu items must use the Telugu RPC; DEFER stays blocking', { skip }, () => {
  const un = byType('UNASSIGNED_TEXT')[0]
  expectError(() => otherRes(A, un.id, 'ACCEPTED_AS_IS'), /KSC_NOTE_REQUIRED/)
  expectError(() => otherRes(A, un.id, 'CONFIRM'), /KSC_RESOLUTION_INVALID/)
  const q = readiness().find(r => r.id === un.draft_question_id)
  assert.equal(otherRes(A, un.id, 'DEFER').status, 'DEFERRED')
  assert.equal(readiness().find(r => r.id === un.draft_question_id).b, q.b, 'a deferred item still blocks readiness')
  assert.equal(otherRes(A, un.id, 'ACCEPTED_AS_IS', 'the line belongs to the next question').resolution, 'ACCEPTED_AS_IS')
  assert.equal(readiness().find(r => r.id === un.draft_question_id).b, q.b - 1)
  expectError(() => otherRes(A, byType('TELUGU_STEM')[0].id, 'RESOLVED'), /KSC_USE_TELUGU_RESOLUTION/)
})

test('direct writes cannot forge or erase verification provenance', { skip }, () => {
  const it = byType('TELUGU_VERIFY', i => i.target_question_text_id)[0]
  const id = it.target_question_text_id
  expectError(() => asUser(A, `UPDATE public.draft_question_texts SET verification_state='VERIFIED_OCR', verified_by='${A}', verified_at=now() WHERE id='${id}'`), /KSC_VERIFICATION_RPC_ONLY/)
  expectError(() => asUser(A, `UPDATE public.draft_review_items SET status='RESOLVED' WHERE id='${it.id}'`), /permission denied/)
  expectError(() => asUser(A, `INSERT INTO public.draft_material_texts (draft_material_id, language, text_quality) SELECT id, 'en', 'MISSING' FROM public.draft_materials LIMIT 1`), /permission denied/)
  // A direct edit of an OCR row (e.g. the Draft workspace) keeps the original OCR and says so.
  const before = textRow('draft_question_texts', id)
  asUser(A, `UPDATE public.draft_question_texts SET content='నేరుగా మార్చిన పాఠం', text_quality='TEACHER_ENTERED', source='TEACHER' WHERE id='${id}'`)
  let t = textRow('draft_question_texts', id)
  assert.deepEqual([t.ocr_original_content, t.verification_state, t.verified_by], [before.content, 'EDITED_FROM_OCR', A])
  // ...and the original is write-once.
  asUser(A, `UPDATE public.draft_question_texts SET content='మళ్ళీ' WHERE id='${id}'`)
  asUser(A, `UPDATE public.draft_question_texts SET ocr_original_content=NULL WHERE id='${id}'`)   // silently restored
  t = textRow('draft_question_texts', id)
  assert.equal(t.ocr_original_content, before.content, 'OCR history is never rewritten')
  // The (still open) item can now only be edited or marked missing — the OCR is no longer the text.
  expectError(() => teluguRes(A, it.id, 'ACCEPT'), /KSC_NOTHING_TO_ACCEPT/)
})

test('other teachers and anonymous users cannot read or resolve items', { skip }, () => {
  const it = byType('TELUGU_STEM')[0]
  assert.equal(asUser(B, `SELECT count(*) FROM public.draft_review_items`), '0')
  assert.equal(asUser(B, `SELECT count(*) FROM public.draft_question_readiness`), '0')
  expectError(() => teluguRes(B, it.id, 'ACCEPT'), /Review item not found or unauthorized/)
  expectError(() => otherRes(B, byType('STRUCTURE')[0]?.id || byType('OPTION_SET_ABNORMAL')[0].id, 'DEFER'), /Review item not found or unauthorized/)
  expectError(() => asAnon(`SELECT public.ksc_resolve_telugu_review_item('${it.id}', 'ACCEPT', NULL, NULL)`), /permission denied/)
  expectError(() => asAnon(`SELECT count(*) FROM public.draft_review_items`), /permission denied/)
  assert.equal(itemRow(it.id).status, 'OPEN')
})

test('resolutions are teacher work: item regeneration and writer v3 are refused, nothing is lost', { skip }, () => {
  assert.equal(teacherWork(), 't')
  expectError(() => asUser(A, `SELECT public.ksc_replace_review_items('${paperId}', '${runId}', 'g', '[]'::jsonb)`), /KSC_DRAFT_HAS_TEACHER_WORK/)
  const run2 = asUser(A, `SELECT public.ksc_start_draft_analysis_run('${imp}', 'x', '1', '{}'::jsonb)`)
  expectError(() => asUser(A, `SELECT public.ksc_replace_draft_analysis_v3('${imp}', '${run2}', ${J(payload.paper)}::jsonb, ${J(payload.materials)}::jsonb, ${J(payload.questions)}::jsonb, ${J(payload.options)}::jsonb)`), /KSC_DRAFT_HAS_TEACHER_WORK/)
  assert.equal(count(`SELECT count(*) FROM public.draft_review_items WHERE draft_paper_id='${paperId}'`), 741)
  assert.ok(count(`SELECT count(*) FROM public.draft_review_items WHERE draft_paper_id='${paperId}' AND status <> 'OPEN'`) >= 10)
  assert.equal(confirmed(), 0, 'no resolution ever confirmed an answer')
})

test('0017-0026 are byte-for-byte unchanged, and 0027 touches no engine or storage objects', { skip: !fs.existsSync(M27) && 'no 0027' }, () => {
  const locked = {
    '202609220017_draft_paper_foundation.sql': '255c022d8febdc3ed6d49f3dad99b4ca306aaf97443562914c285512d26b5eba',
    '202609220018_draft_manual_questions.sql': 'd4264129070b67e49afefcb37b78ac699997f53994851c5c02a442a6ebf48260',
    '202609220019_draft_media.sql': '82d92f025cc5b991dd6a8471960834a954653c0b9e70702e5296c2d926f66901',
    '202609220020_draft_option_conflict_resolution.sql': '7802f26c1636e7dedd4383727d57264aed3ab6fedc7fe39621a833a36afcbfcf',
    '202609220021_draft_option_uniqueness.sql': 'fa7e17d5ccdd90dcf8823dc34330cac25fe8746edf0aeb66b5d3c1dd3d9255de',
    '202609220022_draft_language_texts.sql': 'c89c8c13c6abcc6ee6f6622f67f3fcba510ff061963bf90d88e9376bde70c90a',
    '202609230023_draft_analysis_automation.sql': '6da5b1db7a5aa19a367e99f0d2848d7cb738c7e9c2e5115a17a29024d40973c8',
    '202609230024_draft_auto_visuals.sql': 'b0df618931c391c906cc426a131491dc4e5ce7e2e5406a0344aaad5dba0451b3',
    '202609230025_draft_auto_telugu_ocr.sql': 'c60fab17bf7e2f3d7f505783565819db4a9505a02258057375177ee2254780c9',
    '202609230026_draft_shared_materials.sql': '57e5774e840f7c1dfa1d3cdfedfe3593085cfa13f4b8399ceb2a3d4b1f7d8f36',
  }
  for (const [file, hash] of Object.entries(locked)) {
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(`supabase/migrations/${file}`)).digest('hex'), hash, `${file} changed`)
  }
  const code = fs.readFileSync(M27, 'utf8').replace(/--.*$/gm, '')
  for (const forbidden of ['publish_test', 'test_attempts', 'attempt_answers', 'test_question_snapshots', 'test_option_snapshots',
    'public.questions', 'public.question_options', 'question_answer_keys', 'ksc_replace_test_import_analysis', 'test_import_candidates', 'storage.']) {
    assert.ok(!code.includes(forbidden), `0027 must not touch ${forbidden}`)
  }
  assert.ok(!/is_(confirmed|proposed)_correct\s*=\s*(true|false|not|\$)/i.test(code), '0027 never sets answer flags')
  assert.ok(!/UPDATE public\.draft_options/.test(code), '0027 never edits options')
  assert.ok(!/TO anon/.test(code))
})
