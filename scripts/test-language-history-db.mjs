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

// B4.5R — language-row history protection + the supported revise operation (migration 0028), on a
// THROWAWAY local PostgreSQL cluster with the real golden-paper pipeline outputs (production B4.4 =
// integer model + glyph hybrid). Never connects to Supabase; storage is an in-memory double.

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
  '202609230026_draft_shared_materials.sql', '202609230027_draft_review_items.sql']
const M28 = MIG('202609230028_draft_language_history_protection.sql')

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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ksc-b45r-pg-'))
  port = 57000 + Math.floor(Math.random() * 900)
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


let generated, answersBefore
const byType = (type, pred = () => true) => items().filter(i => i.item_type === type && i.status === 'OPEN' && pred(i))
const revise = (uid, id, owner, action, text = null, note = null) =>
  JSON.parse(asUser(uid, `SELECT public.ksc_revise_language_text('${id}', '${owner}', '${action}', ${text === null ? 'NULL' : T(text)}, ${note === null ? 'NULL' : T(note)})`))
const PROVENANCE = ['ocr_engine', 'ocr_version', 'ocr_confidence', 'ocr_verdict', 'ocr_review_reasons', 'source_media_id', 'language']
const prov = t => PROVENANCE.map(k => JSON.stringify(t[k]))
const HYBRID_VERSION = /tessdata\/tel\.traineddata \(integer\)@7d092812889d\+ksc-glyph-hybrid@1\.0\.0$/

test('0028 applies on top of 0017-0027, is idempotent, and exposes only the revise RPC', { skip }, () => {
  run(['-q', '-f', M28]); run(['-q', '-f', M28])
  assert.equal(count(`SELECT count(*) FROM pg_trigger WHERE tgname IN ('guard_language_history_question','guard_language_history_option')`), 2)
  assert.equal(psql(`SELECT has_function_privilege('authenticated', 'public.ksc_revise_language_text(uuid,text,text,text,text)', 'EXECUTE')`), 't')
  assert.equal(psql(`SELECT has_function_privilege('anon', 'public.ksc_revise_language_text(uuid,text,text,text,text)', 'EXECUTE')`), 'f')
  assert.equal(psql(`SELECT has_function_privilege('authenticated', 'public.ksc_guard_language_history()', 'EXECUTE')`), 'f')
  generated = buildReviewItems(snapshot(), { visualCandidates: b43 })
  asUser(A, `SELECT public.ksc_replace_review_items('${paperId}', '${runId}', ${T(REVIEW_GENERATOR + '@' + REVIEW_GENERATOR_VERSION)}, ${J(generated)}::jsonb)`)
  answersBefore = answers()
  assert.equal(confirmed(), 0)
})

test('the production hybrid provenance is stored on every OCR row and crop', { skip }, () => {
  const rows = JSON.parse(psql(`SELECT json_agg(t) FROM (SELECT ocr_version, text_quality FROM public.draft_question_texts
    UNION ALL SELECT ocr_version, text_quality FROM public.draft_option_texts) t WHERE text_quality <> 'SCRIPT_NEUTRAL'`))
  assert.ok(rows.length > 0 && rows.every(r => HYBRID_VERSION.test(r.ocr_version)), 'engine + model(sha) + hybrid version')
  const crops = JSON.parse(psql(`SELECT json_agg(detection_detail) FROM public.draft_media WHERE draft_paper_id='${paperId}' AND media_kind='TEXT_REGION' AND draft_question_id IS NOT NULL`))
  assert.ok(crops.every(d => d.hybrid?.version === '1.0.0' && typeof d.ocrRawText === 'string' && HYBRID_VERSION.test(d.ocrVersion)))
  assert.ok(crops.every(d => !/[-]/.test(JSON.stringify(d))), 'the legacy glyph stream is never stored')
  const tel = generated.filter(i => i.item_type.startsWith('TELUGU_'))
  assert.ok(tel.every(i => HYBRID_VERSION.test(i.detail.ocr.version)), 'review items show which engine/model/hybrid produced the text')
})

test('the automatic writer still replaces its own EXTRACTED rows on an untouched Draft (0028 does not block it)', { skip }, async () => {
  const before = count(`SELECT count(*) FROM public.draft_question_texts t JOIN public.draft_questions q ON q.id=t.draft_question_id WHERE q.draft_paper_id='${paperId}'`)
  const qIds = new Map(psql(`SELECT source_question_number || '|' || id FROM public.draft_questions WHERE draft_paper_id='${paperId}'`).split(/\r?\n/).filter(Boolean).map(l => l.split('|')))
  const optionsByKey = new Map(JSON.parse(psql(`SELECT coalesce(json_agg(json_build_object('k', q.source_question_number || '|' || o.marker, 'id', o.id, 'content', o.content)), '[]')
    FROM public.draft_options o JOIN public.draft_questions q ON q.id = o.draft_question_id WHERE q.draft_paper_id='${paperId}'`)).map(r => [r.k, { id: r.id, content: r.content }]))
  const res = await persistAutoTelugu({ benchmark: b44, questionIdByNumber: qIds, optionsByKey, teacherId: A, draftPaperId: paperId, runId,
    readCrop: r => fs.readFileSync(path.join('reports/b44', r.file)), storage: store, rpc: rpcAs(A) })
  assert.ok(res.removed_paths.length > 0)
  assert.equal(count(`SELECT count(*) FROM public.draft_question_texts t JOIN public.draft_questions q ON q.id=t.draft_question_id WHERE q.draft_paper_id='${paperId}'`), before)
  // Items point at the new rows again.
  generated = buildReviewItems(snapshot(), { visualCandidates: b43 })
  asUser(A, `SELECT public.ksc_replace_review_items('${paperId}', '${runId}', ${T(REVIEW_GENERATOR + '@' + REVIEW_GENERATOR_VERSION)}, ${J(generated)}::jsonb)`)
  assert.equal(teacherWork(), 'f')
})

test('direct DELETE of a language row with OCR / extraction history is refused; the row and its history stay', { skip }, () => {
  const stored = byType('TELUGU_OPTION', i => i.detail.stored === true)[0]
  const missing = byType('TELUGU_OPTION', i => i.detail.stored === false && i.source_media_id)[0]
  const neutral = psql(`SELECT t.id FROM public.draft_option_texts t JOIN public.draft_options o ON o.id=t.draft_option_id JOIN public.draft_questions q ON q.id=o.draft_question_id
    WHERE q.draft_paper_id='${paperId}' AND t.text_quality='SCRIPT_NEUTRAL' LIMIT 1`)
  const stem = byType('TELUGU_VERIFY', i => i.target_question_text_id)[0]
  for (const [tbl, id] of [['draft_option_texts', stored.target_option_text_id], ['draft_option_texts', missing.target_option_text_id],
    ['draft_option_texts', neutral], ['draft_question_texts', stem.target_question_text_id]]) {
    const before = textRow(tbl, id)
    expectError(() => asUser(A, `DELETE FROM public.${tbl} WHERE id='${id}'`), /KSC_LANGUAGE_HISTORY_PROTECTED/)
    assert.deepEqual(textRow(tbl, id), before, `${tbl} ${id} untouched`)
  }
  assert.equal(itemRow(stored.id).target_option_text_id, stored.target_option_text_id, 'the review item keeps its target')
  assert.equal(teacherWork(), 'f', 'refused deletes leave no trace')
})

test('OCR provenance columns, owner, language and source crop cannot be rewritten directly', { skip }, () => {
  const it = byType('TELUGU_OPTION', i => i.detail.stored === true)[0]
  const id = it.target_option_text_id
  const other = byType('TELUGU_OPTION', i => i.draft_option_id !== it.draft_option_id)[0].draft_option_id
  for (const set of [`ocr_engine='x'`, `ocr_version='forged'`, `ocr_confidence=1`, `ocr_verdict='HIGH'`, `ocr_review_reasons='[]'::jsonb`,
    `source_media_id=NULL`, `language='en'`, `draft_option_id='${other}'`]) {
    expectError(() => asUser(A, `UPDATE public.draft_option_texts SET ${set} WHERE id='${id}'`), /KSC_LANGUAGE_HISTORY_PROTECTED/)
  }
  // Deleting the crop behind an unstored OCR attempt (the attempt's only copy) is refused too.
  const missing = byType('TELUGU_OPTION', i => i.detail.stored === false && i.source_media_id)[0]
  expectError(() => asUser(A, `DELETE FROM public.draft_media WHERE id='${missing.source_media_id}'`), /KSC_LANGUAGE_HISTORY_PROTECTED/)
  assert.equal(count(`SELECT count(*) FROM public.draft_media WHERE id='${missing.source_media_id}'`), 1)
  assert.equal(teacherWork(), 'f')
})

test('a teacher\'s own row with no extraction history keeps 0022 behaviour, including DELETE', { skip }, () => {
  const q = psql(`SELECT id FROM public.draft_questions WHERE draft_paper_id='${paperId}' ORDER BY position LIMIT 1`)
  const id = asUser(A, `INSERT INTO public.draft_question_texts (draft_question_id, language, content, text_quality, source) VALUES ('${q}', 'hi', 'शिक्षक पाठ', 'TEACHER_ENTERED', 'TEACHER'); SELECT id FROM public.draft_question_texts WHERE draft_question_id='${q}' AND language='hi'`)
  asUser(A, `UPDATE public.draft_question_texts SET content='बदला' WHERE id='${id}'`)
  asUser(A, `DELETE FROM public.draft_question_texts WHERE id='${id}'`)
  assert.equal(count(`SELECT count(*) FROM public.draft_question_texts WHERE id='${id}'`), 0)
})

test('revise with an open item IS the review resolution: REPLACE -> EDIT, CLEAR -> MARK_MISSING; history kept', { skip }, () => {
  const it = byType('TELUGU_OPTION', i => i.detail.stored === true)[0]
  const before = textRow('draft_option_texts', it.target_option_text_id)
  const out = revise(A, it.target_option_text_id, 'OPTION', 'REPLACE', 'సరిచేసిన ఎంపిక', 'letter fix')
  assert.deepEqual([out.status, out.resolution, out.review_item_id], ['RESOLVED', 'EDITED_OCR', it.id])
  const t = textRow('draft_option_texts', it.target_option_text_id)
  assert.deepEqual([t.content, t.text_quality, t.source, t.ocr_original_content, t.verification_state, t.verified_by],
    ['సరిచేసిన ఎంపిక', 'TEACHER_ENTERED', 'TEACHER', before.content, 'EDITED_FROM_OCR', A])
  assert.deepEqual(prov(t), prov(before), 'engine/model/hybrid version, confidence, verdict, reasons, crop unchanged')
  assert.deepEqual([itemRow(it.id).status, itemRow(it.id).resolution_value], ['RESOLVED', 'సరిచేసిన ఎంపిక'])

  const stem = byType('TELUGU_STEM', i => i.detail.stored === true)[0]
  const sb = textRow('draft_question_texts', stem.target_question_text_id)
  assert.equal(revise(A, stem.target_question_text_id, 'QUESTION', 'CLEAR').resolution, 'MARKED_MISSING')
  const s = textRow('draft_question_texts', stem.target_question_text_id)
  assert.deepEqual([s.content, s.text_quality, s.ocr_original_content, s.verification_state], [null, 'MISSING', sb.content, 'MARKED_MISSING'])
  assert.deepEqual(prov(s), prov(sb))
  assert.equal(count(`SELECT count(*) FROM public.draft_media WHERE id='${sb.source_media_id}'`), 1, 'source crop kept')
})

test('revise after resolution: replace, clear, replace again — the OCR original is never overwritten by teacher text', { skip }, () => {
  const it = byType('TELUGU_VERIFY', i => i.target_option_text_id)[0]
  const id = it.target_option_text_id
  const ocr = textRow('draft_option_texts', id).content
  assert.equal(teluguRes(A, it.id, 'ACCEPT').resolution, 'ACCEPTED_OCR')
  assert.equal(textRow('draft_option_texts', id).verification_state, 'VERIFIED_OCR')
  assert.deepEqual(revise(A, id, 'OPTION', 'REPLACE', 'మొదటి సవరణ'), { status: 'REVISED', action: 'REPLACE', verification_state: 'EDITED_FROM_OCR' })
  assert.deepEqual(revise(A, id, 'OPTION', 'CLEAR', null, 'not printed'), { status: 'REVISED', action: 'CLEAR', verification_state: 'MARKED_MISSING' })
  assert.equal(revise(A, id, 'OPTION', 'REPLACE', 'రెండవ సవరణ').verification_state, 'EDITED_FROM_OCR')
  const t = textRow('draft_option_texts', id)
  assert.deepEqual([t.content, t.text_quality, t.ocr_original_content, t.verified_by], ['రెండవ సవరణ', 'TEACHER_ENTERED', ocr, A])
  const row = itemRow(it.id)
  assert.deepEqual([row.status, row.resolution], ['RESOLVED', 'ACCEPTED_OCR'], 'the original decision is kept')
  assert.deepEqual(row.detail.revisions.map(r => [r.action, r.value, r.note]), [['REPLACE', 'మొదటి సవరణ', null], ['CLEAR', null, 'not printed'], ['REPLACE', 'రెండవ సవరణ', null]])
  expectError(() => asUser(A, `DELETE FROM public.draft_option_texts WHERE id='${id}'`), /KSC_LANGUAGE_HISTORY_PROTECTED/)
})

test('revise on an unstored attempt keeps the attempt as original OCR; with nothing to start from it is TEACHER_TRANSCRIBED', { skip }, () => {
  const att = byType('TELUGU_OPTION', i => i.detail.stored === false && /[ఀ-౿]/.test(i.extracted_value || ''))[0]
  const crop = JSON.parse(psql(`SELECT detection_detail FROM public.draft_media WHERE id='${att.source_media_id}'`)).ocrText
  assert.equal(teluguRes(A, att.id, 'DEFER').status, 'DEFERRED')
  assert.equal(revise(A, att.target_option_text_id, 'OPTION', 'REPLACE', 'టైప్ చేసిన ఎంపిక').resolution, 'EDITED_OCR', 'a deferred item is still open: resolved by the revision')
  assert.equal(textRow('draft_option_texts', att.target_option_text_id).ocr_original_content, crop)
})

test('revise refuses bad input, script-neutral rows, other teachers and anonymous users', { skip }, () => {
  const it = byType('TELUGU_OPTION')[0]
  const before = textRow('draft_option_texts', it.target_option_text_id)
  expectError(() => revise(A, it.target_option_text_id, 'OPTION', 'REPLACE', '  '), /KSC_TELUGU_TEXT_INVALID/)
  expectError(() => revise(A, it.target_option_text_id, 'OPTION', 'REPLACE', 'అ' + String.fromCharCode(0xF041)), /KSC_TELUGU_TEXT_INVALID/)
  expectError(() => revise(A, it.target_option_text_id, 'OPTION', 'DELETE'), /KSC_LANGUAGE_ACTION_INVALID/)
  expectError(() => revise(A, it.target_option_text_id, 'MATERIAL', 'CLEAR'), /KSC_LANGUAGE_OWNER_INVALID/)
  expectError(() => revise(A, it.target_option_text_id, 'QUESTION', 'CLEAR'), /not found or unauthorized/)
  expectError(() => revise(B, it.target_option_text_id, 'OPTION', 'CLEAR'), /not found or unauthorized/)
  expectError(() => asAnon(`SELECT public.ksc_revise_language_text('${it.target_option_text_id}', 'OPTION', 'CLEAR', NULL, NULL)`), /permission denied/)
  const neutral = psql(`SELECT t.id FROM public.draft_option_texts t JOIN public.draft_options o ON o.id=t.draft_option_id JOIN public.draft_questions q ON q.id=o.draft_question_id
    WHERE q.draft_paper_id='${paperId}' AND t.text_quality='SCRIPT_NEUTRAL' LIMIT 1`)
  expectError(() => revise(A, neutral, 'OPTION', 'REPLACE', 'పదిహేను'), /KSC_SCRIPT_NEUTRAL_NOT_REVISABLE/)
  assert.deepEqual(textRow('draft_option_texts', it.target_option_text_id), before)
  assert.equal(itemRow(it.id).status, 'OPEN')
})

test('accepting or revising Telugu never confirms, proposes or edits an answer or option', { skip }, () => {
  const v = byType('TELUGU_VERIFY', i => i.target_question_text_id)[0]
  teluguRes(A, v.id, 'ACCEPT')
  assert.equal(answers(), answersBefore, 'option content and both answer flags identical after every Telugu action in this suite')
  assert.equal(confirmed(), 0)
  assert.equal(count(`SELECT count(*) FROM public.draft_questions WHERE draft_paper_id='${paperId}' AND (confirmed_by IS NOT NULL OR confirmed_at IS NOT NULL)`), 0)
})

test('cascades still work: deleting the owning question removes its rows (the question itself is gone)', { skip }, () => {
  const q = psql(`SELECT q.id FROM public.draft_questions q JOIN public.draft_question_texts t ON t.draft_question_id=q.id
    WHERE q.draft_paper_id='${paperId}' AND t.text_quality='OCR_EXTRACTED' AND t.verification_state IS NULL ORDER BY q.position DESC LIMIT 1`)
  asUser(A, `DELETE FROM public.draft_questions WHERE id='${q}'`)
  assert.equal(count(`SELECT count(*) FROM public.draft_question_texts WHERE draft_question_id='${q}'`), 0)
  assert.equal(count(`SELECT count(*) FROM public.draft_option_texts t JOIN public.draft_options o ON o.id=t.draft_option_id WHERE o.draft_question_id='${q}'`), 0)
})

test('0017-0027 are byte-for-byte unchanged, and 0028 touches no engine, storage or answer objects', () => {
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
    '202609230027_draft_review_items.sql': 'd26d5457463fbbdceb8fd8b5d1212627db95064c946cc759ff83491d76673a17',
  }
  for (const [file, hash] of Object.entries(locked)) {
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(`supabase/migrations/${file}`)).digest('hex'), hash, `${file} changed`)
  }
  const code = fs.readFileSync(M28, 'utf8').replace(/--.*$/gm, '')
  for (const forbidden of ['publish_test', 'test_attempts', 'attempt_answers', 'test_question_snapshots', 'test_option_snapshots',
    'public.questions', 'public.question_options', 'question_answer_keys', 'test_import_candidates', 'storage.', 'draft_options SET', 'DROP POLICY', 'CREATE POLICY']) {
    assert.ok(!code.includes(forbidden), `0028 must not touch ${forbidden}`)
  }
  assert.ok(!/is_(confirmed|proposed)_correct/i.test(code), '0028 never reads or sets answer flags')
  assert.ok(!/TO anon/.test(code))
})
