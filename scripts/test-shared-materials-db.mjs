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

// B4.2R — writer v3 + shared materials (migration 0026) on a THROWAWAY local PostgreSQL cluster,
// with the real B4.1 model, B4.3 manifest and B4.4 benchmark. Never connects to Supabase.

const PG_BIN = process.env.KSC_PG_BIN || 'C:/Program Files/PostgreSQL/16/bin'
const exe = n => path.join(PG_BIN, process.platform === 'win32' ? `${n}.exe` : n)
const HAVE_PG = fs.existsSync(exe('initdb')) && fs.existsSync(exe('pg_ctl')) && fs.existsSync(exe('psql'))
const INPUTS = ['reports/b41-paper-model.json', 'reports/b43/b43-manifest.json', 'reports/b44/b44-benchmark.json']
const HAVE_INPUTS = INPUTS.every(f => fs.existsSync(f))
const MIG = n => path.resolve(`supabase/migrations/${n}`)
const CHAIN = ['202609220017_draft_paper_foundation.sql', '202609220018_draft_manual_questions.sql',
  '202609220019_draft_media.sql', '202609220020_draft_option_conflict_resolution.sql',
  '202609220021_draft_option_uniqueness.sql', '202609220022_draft_language_texts.sql',
  '202609230023_draft_analysis_automation.sql', '202609230024_draft_auto_visuals.sql', '202609230025_draft_auto_telugu_ocr.sql']
const M26 = MIG('202609230026_draft_shared_materials.sql')

let dataDir, port, model, b43, b44
const A = randomUUID(), B = randomUUID()
const imp = randomUUID(), impB = randomUUID()
const run = args => execFileSync(exe('psql'), ['-h', 'localhost', '-p', String(port), '-U', 'postgres', '-d', 'postgres',
  '-v', 'ON_ERROR_STOP=1', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PGCLIENTENCODING: 'UTF8' }, maxBuffer: 64 * 1024 * 1024 })
const psql = sql => {
  const tmp = path.join(dataDir, `q_${randomUUID()}.sql`)
  fs.writeFileSync(tmp, sql, 'utf8')
  try { return run(['-At', '-f', tmp]).trim() } finally { fs.rmSync(tmp, { force: true }) }
}
const lastLine = out => out.split(/\r?\n/).filter(Boolean).pop() ?? ''
const asUser = (uid, sql) => lastLine(psql(`SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', '${uid}', false); ${sql}`))
const count = sql => Number(psql(sql))
const J = v => '$j$' + JSON.stringify(v) + '$j$'
const T = v => '$t$' + v + '$t$'
function expectError(fn, pattern) {
  try { fn() } catch (e) { assert.match(String(e.stderr || e.message), pattern); return }
  assert.fail(`expected an error matching ${pattern}`)
}
function memoryStore({ failUploadAt = null } = {}) {
  const objects = new Map(); let uploads = 0
  return {
    objects,
    async upload(p, bytes, opts) {
      uploads++
      if (failUploadAt !== null && uploads === failUploadAt) return { error: new Error('simulated upload failure') }
      if (opts?.upsert === false && objects.has(p)) return { error: new Error('object exists') }
      objects.set(p, Buffer.from(bytes)); return { error: null }
    },
    async remove(paths) { for (const p of paths) objects.delete(p); return { error: null } },
  }
}
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

function writeV3(uid, importId, mutate = p => p) {
  const payload = mutate(mapPaperModelToDraft(model, { importId, title: 'SI/CONSTABLE TEST-10', sourceFilename: 'si.pdf', visuals: b43 }))
  const runId = asUser(uid, `SELECT public.ksc_start_draft_analysis_run('${importId}', '${B4_ENGINE}', '${B4_ENGINE_VERSION}', '{}'::jsonb)`)
  const out = JSON.parse(asUser(uid, `SELECT public.ksc_replace_draft_analysis_v3('${importId}', '${runId}', ${J(payload.paper)}::jsonb, ` +
    `${J(payload.materials)}::jsonb, ${J(payload.questions)}::jsonb, ${J(payload.options)}::jsonb)`))
  return { paperId: out.draft_paper_id, runId, payload, out }
}
const qIds = paperId => new Map(psql(`SELECT source_question_number || '|' || id FROM public.draft_questions WHERE draft_paper_id='${paperId}'`)
  .split(/\r?\n/).filter(Boolean).map(l => l.split('|')))
const optionsByKey = paperId => new Map(JSON.parse(psql(`SELECT coalesce(json_agg(json_build_object('k', q.source_question_number || '|' || o.marker, 'id', o.id, 'content', o.content)), '[]')
  FROM public.draft_options o JOIN public.draft_questions q ON q.id = o.draft_question_id WHERE q.draft_paper_id='${paperId}'`)).map(r => [r.k, { id: r.id, content: r.content }]))
const materialIds = d => new Map(d.payload.materials.map(m => [m.position, m.id]))
const mediaCount = (paperId, where) => count(`SELECT count(*) FROM public.draft_media WHERE draft_paper_id='${paperId}' AND ${where}`)
const teacherWork = paperId => psql(`SELECT public.ksc_draft_has_teacher_work('${paperId}')`)

before(() => {
  if (!HAVE_PG || !HAVE_INPUTS) return
  model = JSON.parse(fs.readFileSync(INPUTS[0], 'utf8'))
  b43 = JSON.parse(fs.readFileSync(INPUTS[1], 'utf8'))
  b44 = JSON.parse(fs.readFileSync(INPUTS[2], 'utf8'))
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ksc-b42r-pg-'))
  port = 55000 + Math.floor(Math.random() * 900)
  execFileSync(exe('initdb'), ['-D', dataDir, '-U', 'postgres', '-A', 'trust', '-E', 'UTF8', '--no-locale'], { stdio: 'ignore' })
  execFileSync(exe('pg_ctl'), ['-D', dataDir, '-l', path.join(dataDir, 'server.log'), '-o', `-p ${port} -c listen_addresses=localhost`, '-w', 'start'], { stdio: 'ignore' })
  psql(STUBS)
  psql(`INSERT INTO auth.users VALUES ('${A}'), ('${B}'); INSERT INTO public.teacher_profiles VALUES ('${A}'), ('${B}');
        INSERT INTO public.test_imports (id, created_by) VALUES ('${imp}', '${A}'), ('${impB}', '${B}');`)
  for (const f of CHAIN) run(['-q', '-f', MIG(f)])
})
after(() => {
  if (!HAVE_PG || !dataDir) return
  try { execFileSync(exe('pg_ctl'), ['-D', dataDir, '-m', 'immediate', '-w', 'stop'], { stdio: 'ignore' }) } catch {}
  try { fs.rmSync(dataDir, { recursive: true, force: true }) } catch {}
})
const skip = !HAVE_PG ? 'PostgreSQL binaries not found (set KSC_PG_BIN)' : !HAVE_INPUTS ? 'run the B4.1/B4.3/B4.4 tools first' : false

let draft, store

test('0026 applies on top of 0017-0025 and is idempotent', { skip }, () => {
  run(['-q', '-f', M26]); run(['-q', '-f', M26])
  for (const c of ['draft_materials_range_source_valid', 'draft_materials_origin_valid', 'draft_materials_no_legacy_glyphs']) {
    assert.equal(count(`SELECT count(*) FROM pg_constraint WHERE conname='${c}'`), 1, c)
  }
  assert.equal(count(`SELECT count(*) FROM pg_trigger WHERE tgname='guard_question_shared_material'`), 1)
})

test('writer v3 persists 200 stem-only questions, 797 options, 11 materials and 24 links atomically', { skip }, () => {
  draft = writeV3(A, imp)
  assert.deepEqual([draft.out.questions, draft.out.options, draft.out.materials, draft.out.linkedQuestions, draft.out.proposedAnswers], [200, 800, 11, 24, 200])   // B4.8.2: +3 options (Q115/Q126/Q135 split), Q126's key now proposed
  assert.equal(count(`SELECT count(*) FROM public.draft_questions WHERE draft_paper_id='${draft.paperId}' AND content ~ '(^|\\s)[A-D]\\)'`), 0, 'no option markers in any stored stem')
  const counts = new Map(psql(`SELECT q.source_question_number || ':' || count(o.id) FROM public.draft_questions q LEFT JOIN public.draft_options o ON o.draft_question_id=q.id
    WHERE q.draft_paper_id='${draft.paperId}' GROUP BY q.id, q.source_question_number`).split(/\r?\n/).map(r => r.split(':')))
  for (const q of model.questions) assert.equal(Number(counts.get(String(q.number))), q.options.length, `Q${q.number} option count`)
  assert.equal(count(`SELECT count(*) FROM public.draft_options o JOIN public.draft_questions q ON q.id=o.draft_question_id
    WHERE q.draft_paper_id='${draft.paperId}' AND o.is_confirmed_correct`), 0, 'nothing confirmed')
  assert.equal(psql(`SELECT string_agg(o.content, ',' ORDER BY o.position) || '|' || max(CASE WHEN o.is_proposed_correct THEN o.marker END)
    FROM public.draft_options o JOIN public.draft_questions q ON q.id=o.draft_question_id WHERE q.draft_paper_id='${draft.paperId}' AND q.source_question_number='6'`), '15,19,22,24|D')
  assert.match(psql(`SELECT source_reference FROM public.draft_questions WHERE draft_paper_id='${draft.paperId}' AND source_question_number='10'`), /pages 2, 3/)
  assert.equal(psql(`SELECT metrics->>'sharedMaterials' || ':' || (metrics->>'questionsWithSharedMaterial') FROM public.draft_analysis_runs WHERE id='${draft.runId}'`), '11:24')
})

test('materials carry provenance and questions reference them (no duplication into questions)', { skip }, () => {
  const rows = JSON.parse(psql(`SELECT json_agg(json_build_object('pos', position, 'type', material_type, 'applies', applies_to_questions, 'src', range_source,
    'regions', jsonb_array_length(source_regions), 'te', jsonb_array_length(telugu_regions), 'conf', extraction_confidence, 'origin', origin,
    'run', analysis_run_id, 'reasons', review_reasons, 'text', left(content_text, 60),
    'linked', (SELECT json_agg(q.source_question_number::int ORDER BY q.position) FROM public.draft_questions q WHERE q.shared_material_id = m.id)) ORDER BY position)
    FROM public.draft_materials m WHERE draft_paper_id='${draft.paperId}'`))
  assert.equal(rows.length, 11)
  for (const r of rows) {
    assert.deepEqual(r.linked, r.applies, `M${r.pos}: questions reference exactly the stated range`)
    assert.ok(r.regions >= 1 && r.origin === 'EXTRACTED' && r.run === draft.runId && r.conf > 0)
    assert.ok(['HEADING_RANGE', 'SINGULAR_NEXT_QUESTION'].includes(r.src))
  }
  assert.deepEqual(rows.map(r => r.linked), [[5], [11, 12], [13, 14], [15], [22], [25], [30], [31, 32, 33], [36, 37, 38, 39], [71, 72, 73, 74], [81, 82, 83, 84]])
  assert.equal(rows[10].type, 'PASSAGE'); assert.equal(rows[10].te, 0); assert.deepEqual(rows[10].reasons, [])
  assert.ok(rows.slice(0, 10).every(r => r.te >= 1 && r.reasons.includes('TELUGU_MATERIAL_TEXT_NOT_EXTRACTED')), 'Telugu material text is kept for review, never guessed')
  const passage = psql(`SELECT content_text FROM public.draft_materials WHERE draft_paper_id='${draft.paperId}' AND position=10`)
  assert.ok(passage.length > 2000)
  assert.equal(count(`SELECT count(*) FROM public.draft_questions WHERE draft_paper_id='${draft.paperId}' AND content LIKE '%Nearly a century ago%'`), 0, 'the passage is not duplicated into questions')
})

test('material media: figures + Telugu source crops owned by materials; the three writers never delete each other\'s media', { skip }, async () => {
  store = memoryStore()
  const readB43 = e => fs.readFileSync(path.join('reports/b43', e.file))
  const mat = await persistAutoMaterialMedia({ manifest: b43, materialIdByIndex: materialIds(draft), teacherId: A, draftPaperId: draft.paperId,
    runId: draft.runId, readCrop: readB43, storage: store, rpc: rpcAs(A) })
  const figures = b43.accepted.filter(r => r.owner?.kind === 'MATERIAL').length
  assert.equal(mat.inserted, figures + b43.materialSources.length)
  const vis = await persistAutoVisuals({ rows: b43.accepted, questionIdByNumber: qIds(draft.paperId), teacherId: A, draftPaperId: draft.paperId,
    runId: draft.runId, readCrop: readB43, storage: store, rpc: rpcAs(A) })
  assert.equal(vis.inserted, 1, 'Q6 only; material rows are skipped by the question writer')
  const tel = await persistAutoTelugu({ benchmark: b44, questionIdByNumber: qIds(draft.paperId), optionsByKey: optionsByKey(draft.paperId), teacherId: A,
    draftPaperId: draft.paperId, runId: draft.runId, readCrop: r => fs.readFileSync(path.join('reports/b44', r.file)), storage: store, rpc: rpcAs(A) })
  assert.ok(tel.crops > 600)
  assert.equal(mediaCount(draft.paperId, 'draft_material_id IS NOT NULL'), mat.inserted, 'Telugu writer left material crops alone')
  // Re-run each writer: each replaces only its own scope.
  await persistAutoVisuals({ rows: b43.accepted, questionIdByNumber: qIds(draft.paperId), teacherId: A, draftPaperId: draft.paperId, runId: draft.runId, readCrop: readB43, storage: store, rpc: rpcAs(A) })
  assert.equal(mediaCount(draft.paperId, 'draft_material_id IS NOT NULL'), mat.inserted, 'visual writer left material figures alone')
  await persistAutoMaterialMedia({ manifest: b43, materialIdByIndex: materialIds(draft), teacherId: A, draftPaperId: draft.paperId, runId: draft.runId, readCrop: readB43, storage: store, rpc: rpcAs(A) })
  assert.equal(mediaCount(draft.paperId, "draft_question_id IS NOT NULL AND media_kind='TEXT_REGION'"), tel.crops, 'material writer left question Telugu crops alone')
  assert.equal(mediaCount(draft.paperId, "draft_question_id IS NOT NULL AND media_kind='FIGURE'"), 1, 'material writer left the Q6 figure alone')
  for (const p of JSON.parse(psql(`SELECT json_agg(storage_path) FROM public.draft_media WHERE draft_paper_id='${draft.paperId}'`))) assert.ok(store.objects.has(p))
  assert.equal(teacherWork(draft.paperId), 'f')
})

test('material media writer refuses non-material owners, bad kinds and foreign paths', { skip }, () => {
  const mid = materialIds(draft).get(1)
  const base = id => ({ id, draft_material_id: mid, media_kind: 'FIGURE', storage_path: `imports/${A}/draft-media/${draft.paperId}/${id}.png`, source_page: 3,
    region_x: 0.1, region_y: 0.1, region_w: 0.2, region_h: 0.1, page_width_pt: 595.32, page_height_pt: 841.92, render_scale: 2, width_px: 10, height_px: 10,
    detection_confidence: 0.9, detection_detail: { detector: 'x' } })
  const call = media => asUser(A, `SELECT public.ksc_replace_auto_material_media('${draft.paperId}', '${draft.runId}', ${J(media)}::jsonb)`)
  const id = randomUUID()
  expectError(() => call([{ ...base(id), draft_material_id: null, draft_question_id: qIds(draft.paperId).get('11') }]), /KSC_AUTO_MATERIAL_OWNER_UNSUPPORTED|KSC_AUTO_MATERIAL_OWNER_INVALID/)
  expectError(() => call([{ ...base(id), draft_material_id: randomUUID() }]), /KSC_AUTO_MATERIAL_OWNER_INVALID/)
  expectError(() => call([{ ...base(id), media_kind: 'VIDEO' }]), /KSC_AUTO_MATERIAL_KIND_INVALID/)
  expectError(() => call([{ ...base(id), storage_path: `imports/${B}/draft-media/${draft.paperId}/${id}.png` }]), /KSC_AUTO_MATERIAL_PATH_INVALID/)
  expectError(() => call([{ ...base(id), detection_detail: null }]), /KSC_AUTO_MATERIAL_PROVENANCE_MISSING/)
  expectError(() => asUser(B, `SELECT public.ksc_replace_auto_material_media('${draft.paperId}', '${draft.runId}', '[]'::jsonb)`), /Draft paper not found or unauthorized/)
})

test('a question can only reference a material of its own paper; v3 refuses unknown materials', { skip }, () => {
  const other = writeV3(B, impB)
  const foreign = psql(`SELECT id FROM public.draft_materials WHERE draft_paper_id='${other.paperId}' AND position=10`)
  expectError(() => psql(`UPDATE public.draft_questions SET shared_material_id='${foreign}' WHERE draft_paper_id='${draft.paperId}' AND source_question_number='1'`), /KSC_SHARED_MATERIAL_WRONG_PAPER/)
  const runId = asUser(A, `SELECT public.ksc_start_draft_analysis_run('${imp}', 'x', '1', '{}'::jsonb)`)
  const p = mapPaperModelToDraft(model, { importId: imp })
  p.questions[0].shared_material_id = randomUUID()
  expectError(() => asUser(A, `SELECT public.ksc_replace_draft_analysis_v3('${imp}', '${runId}', ${J(p.paper)}::jsonb, ${J(p.materials)}::jsonb, ${J(p.questions)}::jsonb, ${J(p.options)}::jsonb)`), /KSC_SHARED_MATERIAL_NOT_IN_PAYLOAD/)
  asUser(A, `SELECT public.ksc_fail_draft_analysis_run('${runId}', 'test', NULL)`)
  assert.equal(count(`SELECT count(*) FROM public.draft_materials WHERE draft_paper_id='${draft.paperId}'`), 11, 'refused write changed nothing')
})

test('a failed material crop or upload leaves no material media record', { skip }, async () => {
  const beforeCount = mediaCount(draft.paperId, 'draft_material_id IS NOT NULL')
  const s = memoryStore({ failUploadAt: 3 })
  const err = await persistAutoMaterialMedia({ manifest: b43, materialIdByIndex: materialIds(draft), teacherId: A, draftPaperId: draft.paperId,
    runId: draft.runId, readCrop: e => fs.readFileSync(path.join('reports/b43', e.file)), storage: s, rpc: rpcAs(A) }).catch(e => e)
  assert.equal(err.stage, 'upload')
  assert.equal(s.objects.size, 0)
  assert.equal(mediaCount(draft.paperId, 'draft_material_id IS NOT NULL'), beforeCount)
})

test('re-running v3 on an untouched automatic Draft is allowed; a teacher-edited material blocks it', { skip }, () => {
  const again = writeV3(A, imp)
  assert.equal(again.paperId, draft.paperId)
  assert.equal(again.out.materials, 11)
  assert.equal(teacherWork(draft.paperId), 'f')
  asUser(A, `UPDATE public.draft_materials SET content_text = content_text || ' (checked)' WHERE draft_paper_id='${draft.paperId}' AND position=10`)
  assert.equal(teacherWork(draft.paperId), 't')
  const runId = asUser(A, `SELECT public.ksc_start_draft_analysis_run('${imp}', 'x', '1', '{}'::jsonb)`)
  const p = mapPaperModelToDraft(model, { importId: imp })
  expectError(() => asUser(A, `SELECT public.ksc_replace_draft_analysis_v3('${imp}', '${runId}', ${J(p.paper)}::jsonb, ${J(p.materials)}::jsonb, ${J(p.questions)}::jsonb, ${J(p.options)}::jsonb)`), /KSC_DRAFT_HAS_TEACHER_WORK/)
  assert.match(psql(`SELECT content_text FROM public.draft_materials WHERE draft_paper_id='${draft.paperId}' AND position=10`), /\(checked\)$/, 'teacher edit preserved')
})

test('0017-0025 are byte-for-byte unchanged, and 0026 touches no engine or storage objects', { skip: !fs.existsSync(M26) && 'no 0026' }, () => {
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
  }
  for (const [file, hash] of Object.entries(locked)) {
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(`supabase/migrations/${file}`)).digest('hex'), hash, `${file} changed`)
  }
  const code = fs.readFileSync(M26, 'utf8').replace(/--.*$/gm, '')
  for (const forbidden of ['publish_test', 'test_attempts', 'attempt_answers', 'test_question_snapshots', 'test_option_snapshots',
    'public.questions', 'public.question_options', 'question_answer_keys', 'ksc_replace_test_import_analysis', 'test_import_candidates', 'storage.']) {
    assert.ok(!code.includes(forbidden), `0026 must not touch ${forbidden}`)
  }
  assert.ok(!/is_confirmed_correct\s*=/.test(code), '0026 never sets confirmed answers')
  assert.ok(!/TO anon/.test(code))
})
