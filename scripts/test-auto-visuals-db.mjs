import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto, { randomUUID } from 'crypto'
import { mapPaperModelToDraft, B4_ENGINE, B4_ENGINE_VERSION } from './lib/paper-model-to-draft.mjs'
import { persistAutoVisuals, buildAutoVisualRecords } from './lib/auto-visual-persistence.mjs'
import { B43_DETECTOR, B43_DETECTOR_VERSION } from './lib/visual-detection.mjs'
import { groupDraftMedia } from '../src/services/draftPaperMapping.js'

// B4.3 — automatic visuals persisted through migration 0024 on a THROWAWAY local PostgreSQL
// cluster, with an in-memory private object store standing in for Supabase Storage.
// Uses the real B4.1 model and the real B4.3 manifest + crop files. Never connects to Supabase.

const PG_BIN = process.env.KSC_PG_BIN || 'C:/Program Files/PostgreSQL/16/bin'
const exe = n => path.join(PG_BIN, process.platform === 'win32' ? `${n}.exe` : n)
const HAVE_PG = fs.existsSync(exe('initdb')) && fs.existsSync(exe('pg_ctl')) && fs.existsSync(exe('psql'))
const MODEL_PATH = 'reports/b41-paper-model.json'
const MANIFEST_DIR = 'reports/b43'
const MANIFEST_PATH = path.join(MANIFEST_DIR, 'b43-manifest.json')
const HAVE_INPUTS = fs.existsSync(MODEL_PATH) && fs.existsSync(MANIFEST_PATH)
const MIG = n => path.resolve(`supabase/migrations/${n}`)
const CHAIN = ['202609220017_draft_paper_foundation.sql', '202609220018_draft_manual_questions.sql',
  '202609220019_draft_media.sql', '202609220020_draft_option_conflict_resolution.sql',
  '202609220021_draft_option_uniqueness.sql', '202609220022_draft_language_texts.sql',
  '202609230023_draft_analysis_automation.sql']
const M24 = MIG('202609230024_draft_auto_visuals.sql')
const PATH_SHAPE = /^imports\/[0-9a-fA-F-]{36}\/draft-media\/[0-9a-fA-F-]{36}\/[0-9a-fA-F-]{36}\.png$/   // 0019 contract

let dataDir, port, model, manifest, payload
const A = randomUUID(), B = randomUUID()
const imp = randomUUID(), impB = randomUUID()

const run = args => execFileSync(exe('psql'), ['-h', 'localhost', '-p', String(port), '-U', 'postgres', '-d', 'postgres',
  '-v', 'ON_ERROR_STOP=1', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PGCLIENTENCODING: 'UTF8' } })
const psql = sql => {
  const tmp = path.join(dataDir, `q_${randomUUID()}.sql`)
  fs.writeFileSync(tmp, sql, 'utf8')
  try { return run(['-At', '-f', tmp]).trim() } finally { fs.rmSync(tmp, { force: true }) }
}
const lastLine = out => out.split(/\r?\n/).filter(Boolean).pop() ?? ''
const asUser = (uid, sql) => lastLine(psql(`SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', '${uid}', false); ${sql}`))
const asAnon = sql => lastLine(psql(`SET ROLE anon; ${sql}`))
const count = sql => Number(psql(sql))
function expectError(fn, pattern) {
  try { fn() } catch (e) { assert.match(String(e.stderr || e.message), pattern); return }
  assert.fail(`expected an error matching ${pattern}`)
}

// Supabase-shaped adapters.
function memoryStore({ failUploadAt = null, failRemove = false } = {}) {
  const objects = new Map()
  let uploads = 0
  return {
    objects,
    async upload(p, bytes, opts) {
      uploads++
      if (failUploadAt !== null && uploads === failUploadAt) return { error: new Error('simulated upload failure') }
      if (opts?.upsert === false && objects.has(p)) return { error: new Error('object exists') }
      objects.set(p, Buffer.from(bytes)); return { error: null }
    },
    async remove(paths) {
      if (failRemove) return { error: new Error('simulated remove failure') }
      for (const p of paths) objects.delete(p); return { error: null }
    },
  }
}
const rpcAs = uid => async (name, args) => {
  try {
    const out = asUser(uid, `SELECT public.${name}('${args.p_draft_paper_id}', '${args.p_run_id}', $mm$${JSON.stringify(args.p_media)}$mm$::jsonb)`)
    return { data: JSON.parse(out), error: null }
  } catch (e) { return { data: null, error: new Error(String(e.stderr || e.message)) } }
}
const readCrop = row => fs.readFileSync(path.join(MANIFEST_DIR, row.file))

const STUBS = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $$;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated;
CREATE SCHEMA ksc_private;
REVOKE ALL ON SCHEMA ksc_private FROM PUBLIC;
CREATE FUNCTION ksc_private.provision_student() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
CREATE TABLE public.teacher_profiles (id uuid PRIMARY KEY);
CREATE FUNCTION public.is_teacher() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
  $$ SELECT EXISTS (SELECT 1 FROM public.teacher_profiles WHERE id = auth.uid()) $$;
CREATE TABLE public.exams (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
CREATE TABLE public.exam_levels (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
CREATE TABLE public.exam_subjects (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
CREATE TABLE public.test_imports (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_by uuid REFERENCES auth.users(id));
CREATE FUNCTION public.ksc_touch_test_import_updated_at() RETURNS trigger LANGUAGE plpgsql AS
  $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END $$;
GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT SELECT ON public.test_imports TO authenticated;
`

const startRun = (uid, importId) => asUser(uid,
  `SELECT public.ksc_start_draft_analysis_run('${importId}', '${B4_ENGINE}', '${B4_ENGINE_VERSION}', '{}'::jsonb)`)
function writeDraft(uid, importId) {
  const p = mapPaperModelToDraft(model, { importId, title: 'SI/CONSTABLE TEST-10', sourceFilename: 'si-test-10.pdf' })
  const runId = startRun(uid, importId)
  const out = JSON.parse(asUser(uid, `SELECT public.ksc_replace_draft_analysis_v2('${importId}', '${runId}', ` +
    `$pp$${JSON.stringify(p.paper)}$pp$::jsonb, $qq$${JSON.stringify(p.questions)}$qq$::jsonb, $oo$${JSON.stringify(p.options)}$oo$::jsonb)`))
  return { paperId: out.draft_paper_id, runId, payload: p }
}
const questionIds = paperId => new Map(psql(`SELECT source_question_number || '|' || id FROM public.draft_questions WHERE draft_paper_id='${paperId}'`)
  .split(/\r?\n/).filter(Boolean).map(l => l.split('|')))
const autoRows = paperId => count(`SELECT count(*) FROM public.draft_media WHERE draft_paper_id='${paperId}' AND capture_method='AUTO_REGION'`)
const teacherWork = paperId => psql(`SELECT public.ksc_draft_has_teacher_work('${paperId}')`)

before(() => {
  if (!HAVE_PG || !HAVE_INPUTS) return
  model = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8'))
  manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'))
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ksc-b43-pg-'))
  port = 55000 + Math.floor(Math.random() * 900)
  execFileSync(exe('initdb'), ['-D', dataDir, '-U', 'postgres', '-A', 'trust', '-E', 'UTF8', '--no-locale'], { stdio: 'ignore' })
  execFileSync(exe('pg_ctl'), ['-D', dataDir, '-l', path.join(dataDir, 'server.log'),
    '-o', `-p ${port} -c listen_addresses=localhost`, '-w', 'start'], { stdio: 'ignore' })
  psql(STUBS)
  psql(`INSERT INTO auth.users VALUES ('${A}'), ('${B}');
        INSERT INTO public.teacher_profiles VALUES ('${A}'), ('${B}');
        INSERT INTO public.test_imports (id, created_by) VALUES ('${imp}', '${A}'), ('${impB}', '${B}');`)
  for (const f of CHAIN) run(['-q', '-f', MIG(f)])
})

after(() => {
  if (!HAVE_PG || !dataDir) return
  try { execFileSync(exe('pg_ctl'), ['-D', dataDir, '-m', 'immediate', '-w', 'stop'], { stdio: 'ignore' }) } catch {}
  try { fs.rmSync(dataDir, { recursive: true, force: true }) } catch {}
})

const skip = !HAVE_PG ? 'PostgreSQL binaries not found (set KSC_PG_BIN)'
  : !HAVE_INPUTS ? 'run scripts/b41-analyze-paper.mjs and scripts/b43-detect-visuals.mjs first' : false

let draft, store, q6Path

test('0024 applies on top of 0017-0023 and is idempotent', { skip }, () => {
  run(['-q', '-f', M24]); run(['-q', '-f', M24])
  for (const c of ['draft_media_auto_region_provenance', 'draft_media_detection_confidence_range', 'draft_media_capture_method_v2', 'draft_options_one_row_per_position']) {
    assert.equal(count(`SELECT count(*) FROM pg_constraint WHERE conname='${c}'`), 1, c)
  }
  draft = writeDraft(A, imp)
  assert.equal(count(`SELECT count(*) FROM public.draft_questions WHERE draft_paper_id='${draft.paperId}'`), 200)
})

test('the manifest carries exactly one accepted QUESTION crop: Q6, never an option', { skip }, () => {
  const questionOwned = manifest.accepted.filter(r => r.owner?.kind === 'QUESTION')
  assert.equal(questionOwned.length, 1)
  assert.ok(manifest.accepted.every(r => ['QUESTION', 'MATERIAL'].includes(r.owner?.kind)), 'owners are questions or shared materials only')
  const q6 = questionOwned[0]
  assert.deepEqual(q6.owner, { kind: 'QUESTION', questionNumber: 6 })
  assert.equal(q6.page, 2)
  assert.ok(fs.existsSync(path.join(MANIFEST_DIR, q6.file)))
  assert.equal(crypto.createHash('sha256').update(readCrop(q6)).digest('hex'), q6.sha256, 'crop file is the one the detector wrote')
})

test('Q6 crop persists as AUTO_REGION with full provenance, private path and stored object', { skip }, async () => {
  store = memoryStore()
  const res = await persistAutoVisuals({ rows: manifest.accepted, questionIdByNumber: questionIds(draft.paperId), teacherId: A,
    draftPaperId: draft.paperId, runId: draft.runId, readCrop, storage: store, rpc: rpcAs(A) })
  assert.equal(res.inserted, 1)
  assert.deepEqual(res.replacedPaths, [])
  assert.equal(res.skipped.filter(s => s.reason === 'OWNER_NOT_QUESTION').length, manifest.accepted.length - 1, 'material-owned crops are never written by the question writer')
  const q6 = manifest.accepted.find(r => r.owner?.kind === 'QUESTION')
  const row = JSON.parse(psql(`SELECT row_to_json(m) FROM public.draft_media m WHERE draft_paper_id='${draft.paperId}'`))
  const q6Id = questionIds(draft.paperId).get('6')
  assert.equal(row.draft_question_id, q6Id)
  assert.equal(row.draft_option_id, null)
  assert.equal(row.draft_material_id, null)
  assert.equal(row.capture_method, 'AUTO_REGION')
  assert.equal(row.media_kind, 'FIGURE')
  assert.equal(row.source_page, 2)
  assert.equal(row.source_import_id, imp)
  assert.deepEqual([row.region_x, row.region_y, row.region_w, row.region_h].map(Number), [q6.region.x, q6.region.y, q6.region.w, q6.region.h])
  assert.equal(Number(row.render_scale), 2)
  assert.deepEqual([row.width_px, row.height_px], [q6.pixel.sw, q6.pixel.sh])
  assert.equal(Number(row.detection_confidence), q6.confidence)
  assert.equal(row.detection_detail.detector, B43_DETECTOR)
  assert.equal(row.detection_detail.version, B43_DETECTOR_VERSION)
  assert.equal(row.detection_detail.runId, draft.runId)
  assert.equal(row.detection_detail.tier, 'LAYOUT_GAP')
  assert.equal(row.storage_bucket, 'ksc-source-documents')
  assert.match(row.storage_path, PATH_SHAPE)
  assert.ok(row.storage_path.startsWith(`imports/${A}/draft-media/${draft.paperId}/`))
  assert.ok(!/https?:|token=|sign/i.test(row.storage_path), 'a path, never a URL')
  assert.deepEqual(store.objects.get(row.storage_path), readCrop(q6), 'stored object is the crop')
  q6Path = row.storage_path
  assert.equal(psql(`SELECT metrics->>'autoVisuals' FROM public.draft_analysis_runs WHERE id='${draft.runId}'`), '1')
})

test('reload: Q6 has its visual, exactly four options, proposed D, nothing confirmed', { skip }, () => {
  const q = JSON.parse(psql(`SELECT row_to_json(x) FROM (
    SELECT q.id, (SELECT coalesce(json_agg(m), '[]') FROM public.draft_media m WHERE m.draft_question_id = q.id) AS draft_media,
      (SELECT json_agg(json_build_object('id', o.id, 'position', o.position, 'content', o.content, 'marker', o.marker,
          'is_proposed_correct', o.is_proposed_correct, 'is_confirmed_correct', o.is_confirmed_correct,
          'draft_media', (SELECT coalesce(json_agg(om), '[]') FROM public.draft_media om WHERE om.draft_option_id = o.id)) ORDER BY o.position)
       FROM public.draft_options o WHERE o.draft_question_id = q.id) AS draft_options
    FROM public.draft_questions q WHERE q.draft_paper_id='${draft.paperId}' AND q.source_question_number='6') x`))
  const { questionMedia, optionMedia } = groupDraftMedia(q)
  assert.equal(questionMedia.length, 1)
  assert.equal(questionMedia[0].storage_path, q6Path)
  assert.ok(Object.values(optionMedia).every(list => list.length === 0), 'no crop became an option visual')
  assert.equal(q.draft_options.length, 4)
  assert.deepEqual(q.draft_options.map(o => o.content), ['15', '19', '22', '24'])
  assert.deepEqual(q.draft_options.filter(o => o.is_proposed_correct).map(o => o.marker), ['D'])
  assert.equal(count(`SELECT count(*) FROM public.draft_options o JOIN public.draft_questions q ON q.id=o.draft_question_id
    WHERE q.draft_paper_id='${draft.paperId}' AND o.is_confirmed_correct`), 0, 'never confirmed')
  assert.equal(count(`SELECT count(*) FROM public.draft_questions WHERE draft_paper_id='${draft.paperId}' AND teacher_review_status <> 'UNREVIEWED'`), 0)
})

test('no option/material-owned or TEXT_REGION automatic rows; decoration never attached', { skip }, () => {
  assert.equal(count(`SELECT count(*) FROM public.draft_media WHERE capture_method='AUTO_REGION' AND (draft_option_id IS NOT NULL OR draft_material_id IS NOT NULL)`), 0)
  assert.equal(count(`SELECT count(*) FROM public.draft_media WHERE capture_method='AUTO_REGION' AND media_kind='TEXT_REGION'`), 0)
  const attachedNumbers = psql(`SELECT string_agg(q.source_question_number, ',') FROM public.draft_media m
    JOIN public.draft_questions q ON q.id = m.draft_question_id WHERE m.capture_method='AUTO_REGION'`)
  assert.equal(attachedNumbers, '6', 'only detector-accepted questions carry automatic visuals')
  assert.equal(manifest.summary.decorationAttached, 0)
  assert.ok(manifest.decorationRejected.length > 0)
  // Records built from rejected rows never reach the database.
  const { records, skipped } = buildAutoVisualRecords({ rows: [...manifest.rejected, ...manifest.accepted], questionIdByNumber: questionIds(draft.paperId),
    teacherId: A, draftPaperId: draft.paperId, runId: draft.runId })
  assert.equal(records.length, 1)
  assert.equal(skipped.length, manifest.rejected.length + manifest.accepted.filter(r => r.owner?.kind !== 'QUESTION').length)
})

test('untouched automatic crops are not teacher work', { skip }, () => {
  assert.equal(teacherWork(draft.paperId), 'f')
})

test('re-detection replaces the previous automatic crop and removes its object', { skip }, async () => {
  const res = await persistAutoVisuals({ rows: manifest.accepted, questionIdByNumber: questionIds(draft.paperId), teacherId: A,
    draftPaperId: draft.paperId, runId: draft.runId, readCrop, storage: store, rpc: rpcAs(A) })
  assert.equal(res.inserted, 1)
  assert.deepEqual(res.replacedPaths, [q6Path])
  assert.equal(store.objects.has(q6Path), false, 'old private object removed')
  assert.equal(autoRows(draft.paperId), 1)
  q6Path = psql(`SELECT storage_path FROM public.draft_media WHERE draft_paper_id='${draft.paperId}'`)
  assert.ok(store.objects.has(q6Path))
})

test('writer RPC refuses unsafe payloads and other callers; nothing changes', { skip }, async () => {
  const [q6] = manifest.accepted
  const ids = questionIds(draft.paperId)
  const base = buildAutoVisualRecords({ rows: [q6], questionIdByNumber: ids, teacherId: A, draftPaperId: draft.paperId, runId: draft.runId }).records[0].record
  const call = (uid, media) => asUser(uid, `SELECT public.ksc_replace_auto_visuals('${draft.paperId}', '${draft.runId}', $mm$${JSON.stringify(media)}$mm$::jsonb)`)
  const optionId = psql(`SELECT o.id FROM public.draft_options o WHERE o.draft_question_id='${ids.get('6')}' AND o.position=0`)
  expectError(() => call(A, [{ ...base, draft_question_id: null, draft_option_id: optionId }]), /KSC_AUTO_VISUAL_OWNER_UNSUPPORTED/)
  expectError(() => call(A, [{ ...base, media_kind: 'TEXT_REGION' }]), /KSC_AUTO_VISUAL_KIND_INVALID/)
  expectError(() => call(A, [{ ...base, storage_path: `imports/${B}/draft-media/${draft.paperId}/${base.id}.png` }]), /KSC_AUTO_VISUAL_PATH_INVALID/)
  expectError(() => call(A, [{ ...base, draft_question_id: randomUUID() }]), /KSC_AUTO_VISUAL_OWNER_INVALID/)
  expectError(() => call(A, [{ ...base, detection_confidence: 1.5 }]), /draft_media_detection_confidence_range/)
  expectError(() => call(A, [{ ...base, detection_detail: null }]), /KSC_AUTO_VISUAL_PROVENANCE_MISSING/)
  expectError(() => call(A, [{ ...base, detection_confidence: null }]), /KSC_AUTO_VISUAL_PROVENANCE_MISSING/)
  // The table constraint holds independently of the RPC (superuser bypasses RLS, not CHECKs).
  expectError(() => psql(`SELECT set_config('ksc.auto_visual_writer', 'on', false);
    UPDATE public.draft_media SET detection_detail = 'null'::jsonb WHERE draft_paper_id='${draft.paperId}'`), /draft_media_auto_region_provenance/)
  expectError(() => call(B, [base]), /Draft paper not found or unauthorized/)
  expectError(() => asAnon(`SELECT public.ksc_replace_auto_visuals('${draft.paperId}', '${draft.runId}', '[]'::jsonb)`), /permission denied/)
  assert.equal(psql(`SELECT storage_path FROM public.draft_media WHERE draft_paper_id='${draft.paperId}'`), q6Path, 'existing crop untouched')
})

test('AUTO_REGION cannot be written directly, so manual work cannot masquerade as automatic', { skip }, () => {
  const id = randomUUID()
  expectError(() => asUser(A, `INSERT INTO public.draft_media (id, draft_paper_id, draft_question_id, media_kind, capture_method, storage_path,
      source_page, region_x, region_y, region_w, region_h, page_width_pt, page_height_pt, render_scale, width_px, height_px,
      detection_confidence, detection_detail)
    VALUES ('${id}', '${draft.paperId}', '${questionIds(draft.paperId).get('7')}', 'FIGURE', 'AUTO_REGION',
      'imports/${A}/draft-media/${draft.paperId}/${id}.png', 2, 0.1, 0.1, 0.2, 0.1, 595.32, 841.92, 2, 10, 10, 0.9, '{}')`), /KSC_AUTO_REGION_WRITER_ONLY/)
  assert.equal(autoRows(draft.paperId), 1)
})

test('failed crop / upload / database step leaves no falsely attached record', { skip }, async () => {
  const ids = questionIds(draft.paperId)
  const args = s => ({ rows: manifest.accepted, questionIdByNumber: ids, teacherId: A, draftPaperId: draft.paperId, runId: draft.runId,
    readCrop, storage: s, rpc: rpcAs(A) })
  const before = psql(`SELECT id FROM public.draft_media WHERE draft_paper_id='${draft.paperId}'`)

  const s1 = memoryStore()
  await assert.rejects(persistAutoVisuals({ ...args(s1), readCrop: () => { throw new Error('render failed') } }), e => e.stage === 'crop')
  assert.equal(s1.objects.size, 0)

  const s2 = memoryStore({ failUploadAt: 1 })
  await assert.rejects(persistAutoVisuals(args(s2)), e => e.stage === 'upload')
  assert.equal(s2.objects.size, 0)

  const s3 = memoryStore()
  await assert.rejects(persistAutoVisuals({ ...args(s3), runId: randomUUID() }), e => e.stage === 'database' && /KSC_ANALYSIS_RUN_INVALID/.test(e.message))
  assert.equal(s3.objects.size, 0, 'uploaded crop removed after the database refused it')

  const s4 = memoryStore({ failRemove: true })
  const err = await persistAutoVisuals({ ...args(s4), runId: randomUUID() }).catch(e => e)
  assert.equal(err.stage, 'database')
  assert.equal(err.orphaned.length, 1, 'an unremovable upload is reported as a private orphan, not attached')

  assert.equal(psql(`SELECT id FROM public.draft_media WHERE draft_paper_id='${draft.paperId}'`), before, 'the database never changed')
})

test('manual and automatic visuals coexist; teacher media blocks automatic replacement', { skip }, async () => {
  const manualId = randomUUID()
  const manualPath = `imports/${A}/draft-media/${draft.paperId}/${manualId}.png`
  asUser(A, `INSERT INTO public.draft_media (id, draft_paper_id, draft_question_id, position, media_kind, capture_method, storage_path,
      source_page, region_x, region_y, region_w, region_h, page_width_pt, page_height_pt, render_scale)
    VALUES ('${manualId}', '${draft.paperId}', '${questionIds(draft.paperId).get('6')}', 1, 'DIAGRAM', 'SOURCE_REGION', '${manualPath}',
      2, 0.6, 0.3, 0.2, 0.05, 595.32, 841.92, 2)`)
  store.objects.set(manualPath, Buffer.from('manual'))
  assert.equal(teacherWork(draft.paperId), 't')
  expectError(() => asUser(A, `UPDATE public.draft_media SET capture_method='AUTO_REGION' WHERE id='${manualId}'`), /KSC_AUTO_REGION_WRITER_ONLY/)

  const err = await persistAutoVisuals({ rows: manifest.accepted, questionIdByNumber: questionIds(draft.paperId), teacherId: A,
    draftPaperId: draft.paperId, runId: draft.runId, readCrop, storage: store, rpc: rpcAs(A) }).catch(e => e)
  assert.equal(err.stage, 'database')
  assert.match(err.message, /KSC_DRAFT_HAS_TEACHER_WORK/)
  assert.equal(count(`SELECT count(*) FROM public.draft_media WHERE draft_paper_id='${draft.paperId}'`), 2, 'both visuals intact')
  assert.equal(psql(`SELECT capture_method FROM public.draft_media WHERE id='${manualId}'`), 'SOURCE_REGION')
  assert.ok(store.objects.has(manualPath) && store.objects.has(q6Path), 'neither object overwritten or removed')
  assert.equal(store.objects.size, 2, 'the refused upload was cleaned up')

  // B4.2 writer v2 is refused too (teacher work), so the manual visual cannot be cascaded away.
  const runId = startRun(A, imp)
  expectError(() => asUser(A, `SELECT public.ksc_replace_draft_analysis_v2('${imp}', '${runId}', '{}'::jsonb, '[]'::jsonb, '[]'::jsonb)`), /KSC_DRAFT_HAS_TEACHER_WORK/)
  asUser(A, `SELECT public.ksc_fail_draft_analysis_run('${runId}', 'refused', NULL)`)
  psql(`DELETE FROM public.draft_media WHERE id='${manualId}'`)   // test cleanup
})

test('a teacher edit of an automatic crop makes it teacher work', { skip }, () => {
  assert.equal(teacherWork(draft.paperId), 'f')
  asUser(A, `UPDATE public.draft_media SET caption='Triangle figure' WHERE draft_paper_id='${draft.paperId}' AND capture_method='AUTO_REGION'`)
  assert.equal(teacherWork(draft.paperId), 't')
})

test('stale detections cannot attach to a re-analysed Draft (owner must be from the given run)', { skip }, async () => {
  const fresh = writeDraft(B, impB)                       // a separate untouched Draft
  const s = memoryStore()
  await persistAutoVisuals({ rows: manifest.accepted, questionIdByNumber: questionIds(fresh.paperId), teacherId: B,
    draftPaperId: fresh.paperId, runId: fresh.runId, readCrop, storage: s, rpc: rpcAs(B) })
  assert.equal(autoRows(fresh.paperId), 1)
  // Re-analysis with writer v2 is allowed (auto crops are not teacher work) and cascades them away.
  const again = writeDraft(B, impB)
  assert.equal(again.paperId, fresh.paperId)
  assert.equal(autoRows(fresh.paperId), 0, 'no record survives pointing at an old question')
  const err = await persistAutoVisuals({ rows: manifest.accepted, questionIdByNumber: questionIds(fresh.paperId), teacherId: B,
    draftPaperId: fresh.paperId, runId: fresh.runId, readCrop, storage: memoryStore(), rpc: rpcAs(B) }).catch(e => e)
  assert.equal(err.stage, 'database')
  assert.match(err.message, /KSC_AUTO_VISUAL_OWNER_INVALID/)
})

test('0017-0023 are byte-for-byte unchanged, and 0024 touches no engine or storage objects', { skip: !fs.existsSync(M24) && 'no 0024' }, () => {
  const locked = {
    '202609220017_draft_paper_foundation.sql': '255c022d8febdc3ed6d49f3dad99b4ca306aaf97443562914c285512d26b5eba',
    '202609220018_draft_manual_questions.sql': 'd4264129070b67e49afefcb37b78ac699997f53994851c5c02a442a6ebf48260',
    '202609220019_draft_media.sql': '82d92f025cc5b991dd6a8471960834a954653c0b9e70702e5296c2d926f66901',
    '202609220020_draft_option_conflict_resolution.sql': '7802f26c1636e7dedd4383727d57264aed3ab6fedc7fe39621a833a36afcbfcf',
    '202609220021_draft_option_uniqueness.sql': 'fa7e17d5ccdd90dcf8823dc34330cac25fe8746edf0aeb66b5d3c1dd3d9255de',
    '202609220022_draft_language_texts.sql': 'c89c8c13c6abcc6ee6f6622f67f3fcba510ff061963bf90d88e9376bde70c90a',
    '202609230023_draft_analysis_automation.sql': '6da5b1db7a5aa19a367e99f0d2848d7cb738c7e9c2e5115a17a29024d40973c8',
  }
  for (const [file, hash] of Object.entries(locked)) {
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(`supabase/migrations/${file}`)).digest('hex'), hash, `${file} changed`)
  }
  const code = fs.readFileSync(M24, 'utf8').replace(/--.*$/gm, '')
  for (const forbidden of ['publish_test', 'test_attempts', 'attempt_answers', 'test_question_snapshots', 'test_option_snapshots',
    'public.questions', 'public.question_options', 'question_answer_keys', 'ksc_replace_test_import_analysis',
    'test_import_candidates', 'storage.', 'public = true', 'public=true']) {
    assert.ok(!code.includes(forbidden), `0024 must not touch ${forbidden}`)
  }
  assert.ok(!/is_confirmed_correct\s*=/.test(code), '0024 reads confirmation, never sets it')
  assert.ok(!/TO anon/.test(code))
})
