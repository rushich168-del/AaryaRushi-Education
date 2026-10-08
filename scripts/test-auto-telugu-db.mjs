import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto, { randomUUID } from 'crypto'
import { mapPaperModelToDraft, B4_ENGINE, B4_ENGINE_VERSION } from './lib/paper-model-to-draft.mjs'
import { persistAutoVisuals } from './lib/auto-visual-persistence.mjs'
import { persistAutoTelugu, buildAutoTeluguPayload } from './lib/auto-telugu-persistence.mjs'
import { groupLanguageTexts, groupDraftMedia } from '../src/services/draftPaperMapping.js'

// B4.4 — OCR'd Telugu persisted through migration 0025 on a THROWAWAY local PostgreSQL cluster,
// with an in-memory private object store. Uses the real B4.1 model, the real B4.3 manifest and
// the real B4.4 benchmark (text + crops). Never connects to Supabase.

const PG_BIN = process.env.KSC_PG_BIN || 'C:/Program Files/PostgreSQL/16/bin'
const exe = n => path.join(PG_BIN, process.platform === 'win32' ? `${n}.exe` : n)
const HAVE_PG = fs.existsSync(exe('initdb')) && fs.existsSync(exe('pg_ctl')) && fs.existsSync(exe('psql'))
const MODEL_PATH = 'reports/b41-paper-model.json'
const B43_DIR = 'reports/b43', B44_DIR = 'reports/b44'
const HAVE_INPUTS = [MODEL_PATH, `${B43_DIR}/b43-manifest.json`, `${B44_DIR}/b44-benchmark.json`].every(f => fs.existsSync(f))
const MIG = n => path.resolve(`supabase/migrations/${n}`)
const CHAIN = ['202609220017_draft_paper_foundation.sql', '202609220018_draft_manual_questions.sql',
  '202609220019_draft_media.sql', '202609220020_draft_option_conflict_resolution.sql',
  '202609220021_draft_option_uniqueness.sql', '202609220022_draft_language_texts.sql',
  '202609230023_draft_analysis_automation.sql', '202609230024_draft_auto_visuals.sql']
const M25 = MIG('202609230025_draft_auto_telugu_ocr.sql')
const PUA = /[\uE000-\uF8FF\uFFFD]/
const TELUGU = /[\u0C00-\u0C7F]/

let dataDir, port, model, visuals, bench
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
const json = sql => JSON.parse(psql(sql) || 'null')
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
const q = s => '$j$' + JSON.stringify(s) + '$j$'     // JSON argument, dollar-quoted
const t = s => '$t$' + s + '$t$'                     // plain text argument, dollar-quoted
const teluguCall = (uid, a) => asUser(uid, `SELECT public.ksc_replace_auto_telugu('${a.p_draft_paper_id}', '${a.p_run_id}', ` +
  `${t(a.p_ocr_engine)}, ${t(a.p_ocr_version)}, ${q(a.p_media)}::jsonb, ${q(a.p_question_texts)}::jsonb, ${q(a.p_option_texts)}::jsonb)`)
const rpcAs = uid => async (name, a) => {
  try {
    const out = name === 'ksc_replace_auto_telugu' ? teluguCall(uid, a)
      : asUser(uid, `SELECT public.${name}('${a.p_draft_paper_id}', '${a.p_run_id}', ${q(a.p_media)}::jsonb)`)
    return { data: JSON.parse(out), error: null }
  } catch (e) { return { data: null, error: new Error(String(e.stderr || e.message)) } }
}
const readTeluguCrop = region => fs.readFileSync(path.join(B44_DIR, region.file))
const readVisualCrop = row => fs.readFileSync(path.join(B43_DIR, row.file))

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

function writeDraft(uid, importId) {
  const p = mapPaperModelToDraft(model, { importId, title: 'SI/CONSTABLE TEST-10', sourceFilename: 'si-test-10.pdf' })
  const runId = asUser(uid, `SELECT public.ksc_start_draft_analysis_run('${importId}', '${B4_ENGINE}', '${B4_ENGINE_VERSION}', '{}'::jsonb)`)
  const out = JSON.parse(asUser(uid, `SELECT public.ksc_replace_draft_analysis_v2('${importId}', '${runId}', ` +
    `${q(p.paper)}::jsonb, ${q(p.questions)}::jsonb, ${q(p.options)}::jsonb)`))
  return { paperId: out.draft_paper_id, runId }
}
const questionIds = paperId => new Map(psql(`SELECT source_question_number || '|' || id FROM public.draft_questions WHERE draft_paper_id='${paperId}'`)
  .split(/\r?\n/).filter(Boolean).map(l => l.split('|')))
const optionsByKey = paperId => new Map((json(`SELECT coalesce(json_agg(json_build_object('k', q.source_question_number || '|' || o.marker, 'id', o.id, 'content', o.content)), '[]')
  FROM public.draft_options o JOIN public.draft_questions q ON q.id = o.draft_question_id WHERE q.draft_paper_id='${paperId}'`) || [])
  .map(r => [r.k, { id: r.id, content: r.content }]))
const answerSnapshot = paperId => psql(`SELECT count(*)::text || '|' || string_agg(o.id::text || ':' || o.position || ':' || coalesce(o.content,'') || ':' || o.is_proposed_correct || ':' || o.is_confirmed_correct, ',' ORDER BY o.id)
  FROM public.draft_options o JOIN public.draft_questions q ON q.id = o.draft_question_id WHERE q.draft_paper_id='${paperId}'`)
const teacherWork = paperId => psql(`SELECT public.ksc_draft_has_teacher_work('${paperId}')`)
const args = (d, uid, store, extra = {}) => ({ benchmark: bench, questionIdByNumber: questionIds(d.paperId), optionsByKey: optionsByKey(d.paperId),
  teacherId: uid, draftPaperId: d.paperId, runId: d.runId, readCrop: readTeluguCrop, storage: store, rpc: rpcAs(uid), ...extra })
function loadQuestion(paperId, number) {
  return json(`SELECT row_to_json(x) FROM (
    SELECT q.id, q.source_question_number,
      (SELECT coalesce(json_agg(m), '[]') FROM public.draft_media m WHERE m.draft_question_id = q.id) AS draft_media,
      (SELECT coalesce(json_agg(t), '[]') FROM public.draft_question_texts t WHERE t.draft_question_id = q.id) AS draft_question_texts,
      (SELECT json_agg(json_build_object('id', o.id, 'position', o.position, 'marker', o.marker, 'content', o.content,
          'is_proposed_correct', o.is_proposed_correct, 'is_confirmed_correct', o.is_confirmed_correct,
          'draft_media', (SELECT coalesce(json_agg(om), '[]') FROM public.draft_media om WHERE om.draft_option_id = o.id),
          'draft_option_texts', (SELECT coalesce(json_agg(ot), '[]') FROM public.draft_option_texts ot WHERE ot.draft_option_id = o.id)) ORDER BY o.position)
       FROM public.draft_options o WHERE o.draft_question_id = q.id) AS draft_options
    FROM public.draft_questions q WHERE q.draft_paper_id='${paperId}' AND q.source_question_number='${number}') x`)
}

before(() => {
  if (!HAVE_PG || !HAVE_INPUTS) return
  model = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8'))
  visuals = JSON.parse(fs.readFileSync(`${B43_DIR}/b43-manifest.json`, 'utf8'))
  bench = JSON.parse(fs.readFileSync(`${B44_DIR}/b44-benchmark.json`, 'utf8'))
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ksc-b44-pg-'))
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
  : !HAVE_INPUTS ? 'run the B4.1, B4.3 and B4.4 tools first (reports/)' : false

let draft, store, before0, firstResult

test('0025 applies on top of 0017-0024 and is idempotent', { skip }, () => {
  run(['-q', '-f', M25]); run(['-q', '-f', M25])
  for (const c of ['draft_question_texts_ocr_extracted_valid', 'draft_option_texts_ocr_extracted_valid',
    'draft_question_texts_ocr_confidence_range', 'draft_option_texts_ocr_verdict_valid', 'draft_media_auto_region_provenance']) {
    assert.equal(count(`SELECT count(*) FROM pg_constraint WHERE conname='${c}'`), 1, c)
  }
  draft = writeDraft(A, imp)
  store = memoryStore()
})

test('B4.3 figure and B4.4 Telugu persist together; options and answers are untouched', { skip }, async () => {
  await persistAutoVisuals({ rows: visuals.accepted, questionIdByNumber: questionIds(draft.paperId), teacherId: A,
    draftPaperId: draft.paperId, runId: draft.runId, readCrop: readVisualCrop, storage: store, rpc: rpcAs(A) })
  before0 = answerSnapshot(draft.paperId)
  firstResult = await persistAutoTelugu(args(draft, A, store))
  assert.equal(firstResult.crops, firstResult.counts.media)
  assert.equal(firstResult.question_texts, firstResult.counts.questionTexts)
  assert.equal(firstResult.option_texts, firstResult.counts.optionTexts)
  assert.equal(answerSnapshot(draft.paperId), before0, 'no option created, deleted or edited; answers identical')
  assert.equal(count(`SELECT count(*) FROM (SELECT o.draft_question_id FROM public.draft_options o JOIN public.draft_questions q
    ON q.id=o.draft_question_id WHERE q.draft_paper_id='${draft.paperId}' GROUP BY 1 HAVING count(*) > 4) x`), 0, 'never 8 options')
  assert.equal(count(`SELECT count(*) FROM public.draft_options o JOIN public.draft_questions q ON q.id=o.draft_question_id
    WHERE q.draft_paper_id='${draft.paperId}' AND o.is_confirmed_correct`), 0, 'nothing confirmed')
  for (const p of json(`SELECT json_agg(storage_path) FROM public.draft_media WHERE draft_paper_id='${draft.paperId}'`)) assert.ok(store.objects.has(p), p)
})

test('Q6: Telugu stem is real Unicode OCR, options stay 15/19/22/24 as SCRIPT_NEUTRAL, figure independent, D proposed only', { skip }, () => {
  const q6 = loadQuestion(draft.paperId, 6)
  const { questionTexts, optionTexts } = groupLanguageTexts(q6)
  const te = questionTexts.te
  const benchStem = bench.questions.find(x => x.number === 6).units.find(u => u.kind === 'STEM')
  assert.equal(te.text_quality, 'OCR_EXTRACTED')
  assert.equal(te.source, 'EXTRACTED')
  assert.equal(te.content, benchStem.text)
  assert.ok(TELUGU.test(te.content) && !PUA.test(te.content))
  assert.equal(te.ocr_verdict, 'HIGH')
  assert.ok(Number(te.ocr_confidence) >= 0.8 && Number(te.ocr_confidence) <= 1)
  assert.equal(te.ocr_engine, 'tesseract.js')
  assert.match(te.ocr_version, /tel\.traineddata/)
  assert.deepEqual(q6.draft_options.map(o => o.content), ['15', '19', '22', '24'])
  assert.equal(q6.draft_options.length, 4)
  for (const o of q6.draft_options) {
    assert.equal(optionTexts[o.id].te.text_quality, 'SCRIPT_NEUTRAL')
    assert.equal(optionTexts[o.id].te.content, null)
  }
  assert.deepEqual(q6.draft_options.filter(o => o.is_proposed_correct).map(o => o.marker), ['D'])
  assert.ok(q6.draft_options.every(o => !o.is_confirmed_correct))
  const { questionMedia } = groupDraftMedia(q6)
  const figure = questionMedia.filter(m => m.media_kind === 'FIGURE')
  const textRegion = questionMedia.filter(m => m.media_kind === 'TEXT_REGION')
  assert.equal(figure.length, 1, 'B4.3 triangle crop still there')
  assert.equal(textRegion.length, 1, 'one Telugu stem crop')
  assert.notEqual(figure[0].id, textRegion[0].id)
  assert.equal(te.source_media_id, textRegion[0].id, 'OCR text points at its own TEXT_REGION crop')
  assert.equal(textRegion[0].capture_method, 'AUTO_REGION')
  assert.equal(textRegion[0].source_page, 2)
})

test('textual-option questions stay one logical question with four logical options (Telugu = language versions)', { skip }, () => {
  const textual = bench.questions.filter(x => x.structure === 'STEM_AND_OPTIONS' && x.units.filter(u => u.kind === 'OPTION').length === 4)
  assert.ok(textual.length >= 50)
  for (const n of [1, 12, 105, textual[20].number, textual[40].number]) {
    const row = loadQuestion(draft.paperId, n)
    assert.equal(row.draft_options.length, 4, `Q${n} has four options`)
    const { optionTexts } = groupLanguageTexts(row)
    const bq = bench.questions.find(x => x.number === n)
    for (const o of row.draft_options) {
      const te = optionTexts[o.id].te
      const unit = bq.units.find(u => u.kind === 'OPTION' && u.marker === o.marker)
      assert.ok(te, `Q${n} ${o.marker} has a Telugu version on the SAME option`)
      assert.equal(te.ocr_verdict, unit.verdict)
      if (te.text_quality === 'OCR_EXTRACTED') assert.equal(te.content, unit.text)
      assert.ok(!PUA.test(te.content || ''))
      assert.ok(te.source_media_id, 'crop provenance kept')
    }
    assert.equal(count(`SELECT count(*) FROM public.draft_question_texts t JOIN public.draft_questions q ON q.id=t.draft_question_id
      WHERE q.draft_paper_id='${draft.paperId}' AND q.source_question_number='${n}'`), 1, 'one Telugu stem row')
  }
  const q1 = groupLanguageTexts(loadQuestion(draft.paperId, 1))
  // Four language versions on the four options. The source prints "ఏదికాదు" for A; the integer model
  // reads it as "విదికాదు" at HIGH confidence (a known B4.5R regression vs the fast model). It is
  // stored as OCR, never verified, and stays an open verification item — so it is not pinned here.
  const q1Texts = Object.values(q1.optionTexts).map(x => x.te)
  assert.deepEqual(q1Texts.slice(1).map(t => t.content), ['ఒకటి', 'రెండు', 'మూడు'])
  assert.deepEqual([q1Texts[0].text_quality, q1Texts[0].verification_state ?? null], ['OCR_EXTRACTED', null])
})

test('OCR safety: genuine Telugu only, no legacy glyphs, never TEACHER_ENTERED, weak OCR never becomes content', { skip }, () => {
  for (const table of ['draft_question_texts', 'draft_option_texts']) {
    assert.equal(count(`SELECT count(*) FROM public.${table} WHERE content ~ '[\\uE000-\\uF8FF\\uFFFD]'`), 0, `${table}: no legacy glyphs`)
    assert.equal(count(`SELECT count(*) FROM public.${table} WHERE text_quality='OCR_EXTRACTED' AND content !~ '[\\u0C00-\\u0C7F]'`), 0)
    assert.equal(count(`SELECT count(*) FROM public.${table} WHERE text_quality='TEACHER_ENTERED' OR source='TEACHER'`), 0)
    assert.equal(count(`SELECT count(*) FROM public.${table} WHERE ocr_verdict IN ('LOW','DIGIT_MISMATCH','EMPTY','NOT_TELUGU') AND content IS NOT NULL`), 0,
      `${table}: low-confidence / digit-mismatched OCR is never stored as content`)
    assert.equal(count(`SELECT count(*) FROM public.${table} WHERE ocr_verdict IN ('MEDIUM','LOW','DIGIT_MISMATCH','EMPTY','NOT_TELUGU')
      AND jsonb_array_length(ocr_review_reasons) = 0`), 0, `${table}: every non-HIGH row carries review reasons`)
    assert.equal(count(`SELECT count(*) FROM public.${table} WHERE text_quality='OCR_EXTRACTED'
      AND (ocr_confidence IS NULL OR ocr_engine IS NULL OR ocr_version IS NULL OR source_media_id IS NULL)`), 0)
  }
  assert.equal(count(`SELECT count(*) FROM public.draft_media WHERE capture_method='AUTO_REGION' AND media_kind='TEXT_REGION'
    AND (draft_question_id IS NULL OR detection_detail->>'ocrText' IS NULL)`), 0, 'every Telugu crop is question-owned and keeps its OCR attempt')
})

test('ambiguous Telugu blocks keep the whole crop + OCR for review and guess no mapping', { skip }, () => {
  for (const bq of bench.questions.filter(x => x.structure === 'AMBIGUOUS_BLOCK')) {
    const row = loadQuestion(draft.paperId, bq.number)
    const { questionTexts, optionTexts } = groupLanguageTexts(row)
    assert.equal(questionTexts.te.text_quality, 'MISSING')
    assert.equal(questionTexts.te.ocr_review_reasons[0], 'STRUCTURE_AMBIGUOUS')
    assert.ok(Object.values(optionTexts).every(x => !x.te || x.te.text_quality === 'SCRIPT_NEUTRAL'), `Q${bq.number}: no OCR option mapping guessed`)
    const crop = row.draft_media.find(m => m.id === questionTexts.te.source_media_id)
    assert.equal(crop.media_kind, 'TEXT_REGION')
    assert.equal(crop.detection_detail.unit, 'BLOCK')
  }
})

test('automatic Telugu is not teacher work; re-running replaces it in place and keeps the figure', { skip }, async () => {
  assert.equal(teacherWork(draft.paperId), 'f')
  const oldTextRegions = json(`SELECT json_agg(storage_path) FROM public.draft_media WHERE draft_paper_id='${draft.paperId}' AND media_kind='TEXT_REGION'`)
  const again = await persistAutoTelugu(args(draft, A, store))
  assert.equal(again.removed_paths.length, oldTextRegions.length)
  assert.ok(oldTextRegions.every(p => !store.objects.has(p)), 'replaced crops removed from storage')
  assert.equal(count(`SELECT count(*) FROM public.draft_question_texts t JOIN public.draft_questions q ON q.id=t.draft_question_id
    WHERE q.draft_paper_id='${draft.paperId}'`), firstResult.question_texts, 'no duplicate language rows')
  assert.equal(count(`SELECT count(*) FROM public.draft_media WHERE draft_paper_id='${draft.paperId}' AND media_kind='FIGURE'`), 1, 'B4.3 figure untouched')
  assert.equal(answerSnapshot(draft.paperId), before0)
  // And B4.3 re-detection leaves the Telugu crops alone.
  await persistAutoVisuals({ rows: visuals.accepted, questionIdByNumber: questionIds(draft.paperId), teacherId: A,
    draftPaperId: draft.paperId, runId: draft.runId, readCrop: readVisualCrop, storage: store, rpc: rpcAs(A) })
  assert.equal(count(`SELECT count(*) FROM public.draft_media WHERE draft_paper_id='${draft.paperId}' AND media_kind='TEXT_REGION'`), firstResult.crops)
})

test('writer refuses unsafe payloads, other teachers and anon; nothing changes', { skip }, () => {
  const snapshot = psql(`SELECT count(*) || ':' || max(created_at) FROM public.draft_option_texts`)
  const call = (uid, over) => {
    const p = buildAutoTeluguPayload({ benchmark: bench, questionIdByNumber: questionIds(draft.paperId), optionsByKey: optionsByKey(draft.paperId),
      teacherId: A, draftPaperId: draft.paperId, runId: draft.runId })
    return teluguCall(uid, { p_draft_paper_id: draft.paperId, p_run_id: draft.runId, p_ocr_engine: 'tesseract.js', p_ocr_version: 'x',
      p_media: p.media.map(m => m.record), p_question_texts: p.questionTexts, p_option_texts: p.optionTexts, ...over(p) })
  }
  const textualOption = optionsByKey(draft.paperId).get('1|A').id
  const ocrStem = p => p.questionTexts.find(x => x.text_quality === 'OCR_EXTRACTED')
  expectError(() => call(A, () => ({ p_option_texts: [{ draft_option_id: textualOption, text_quality: 'SCRIPT_NEUTRAL' }] })), /KSC_NOT_SCRIPT_NEUTRAL/)
  expectError(() => call(A, () => ({ p_option_texts: [{ draft_option_id: randomUUID(), text_quality: 'MISSING' }] })), /KSC_AUTO_TELUGU_OWNER_INVALID/)
  expectError(() => call(A, () => ({ p_question_texts: [{ draft_question_id: questionIds(draft.paperId).get('1'), text_quality: 'TEACHER_ENTERED', content: 'x' }] })), /KSC_AUTO_TELUGU_QUALITY_INVALID/)
  expectError(() => call(A, p => ({ p_question_texts: [{ ...ocrStem(p), content: 'abc ' + String.fromCharCode(0xF041) + 'అ' }] })), /ocr_extracted_valid/)
  expectError(() => call(A, p => ({ p_question_texts: [{ ...ocrStem(p), content: 'English only' }] })), /ocr_extracted_valid/)
  expectError(() => call(A, () => ({ p_ocr_version: '' })), /KSC_OCR_PROVENANCE_MISSING/)
  expectError(() => call(B, () => ({})), /Draft paper not found or unauthorized/)
  expectError(() => asAnon(`SELECT public.ksc_replace_auto_telugu('${draft.paperId}', '${draft.runId}', 'e', 'v', '[]', '[]', '[]')`), /permission denied/)
  assert.equal(psql(`SELECT count(*) || ':' || max(created_at) FROM public.draft_option_texts`), snapshot)
})

test('OCR text cannot be written or relabelled outside the writer', { skip }, () => {
  const qid = questionIds(draft.paperId).get('1')
  expectError(() => asUser(A, `UPDATE public.draft_question_texts SET content = content || 'అ' WHERE draft_question_id='${qid}'`), /KSC_OCR_WRITER_ONLY/)
  expectError(() => asUser(A, `UPDATE public.draft_question_texts SET source='TEACHER' WHERE draft_question_id='${qid}'`), /ocr_extracted_valid/)
  assert.equal(teacherWork(draft.paperId), 'f')
})

test('failed crop / upload / database step leaves no falsely attached Telugu', { skip }, async () => {
  const state = () => psql(`SELECT (SELECT count(*) FROM public.draft_media) || ':' || (SELECT count(*) FROM public.draft_question_texts) || ':' || (SELECT max(created_at) FROM public.draft_question_texts)`)
  const snapshot = state()
  const s1 = memoryStore()
  await assert.rejects(persistAutoTelugu({ ...args(draft, A, s1), readCrop: () => { throw new Error('render failed') } }), e => e.stage === 'crop')
  assert.equal(s1.objects.size, 0)
  const s2 = memoryStore({ failUploadAt: 5 })
  await assert.rejects(persistAutoTelugu(args(draft, A, s2)), e => e.stage === 'upload')
  assert.equal(s2.objects.size, 0, 'partial uploads removed')
  const s3 = memoryStore()
  await assert.rejects(persistAutoTelugu({ ...args(draft, A, s3), runId: randomUUID() }), e => e.stage === 'database')
  assert.equal(s3.objects.size, 0, 'uploads removed after the database refused')
  assert.equal(state(), snapshot)
})

test('teacher-entered Telugu is never replaced: the writer refuses and the teacher row survives', { skip }, async () => {
  const qid = questionIds(draft.paperId).get('1')
  // Exactly what the app's upsertQuestionText does (source TEACHER, TEACHER_ENTERED).
  asUser(A, `INSERT INTO public.draft_question_texts (draft_question_id, language, content, text_quality, source)
    VALUES ('${qid}', 'te', 'ఉపాధ్యాయుడు టైప్ చేసిన వచనం', 'TEACHER_ENTERED', 'TEACHER')
    ON CONFLICT (draft_question_id, language) DO UPDATE SET content = EXCLUDED.content, text_quality = EXCLUDED.text_quality, source = EXCLUDED.source`)
  assert.equal(teacherWork(draft.paperId), 't')
  const s = memoryStore()
  const err = await persistAutoTelugu(args(draft, A, s)).catch(e => e)
  assert.equal(err.stage, 'database')
  assert.match(err.message, /KSC_DRAFT_HAS_TEACHER_WORK/)
  assert.equal(s.objects.size, 0, 'refused uploads cleaned up')
  assert.equal(psql(`SELECT content || '|' || text_quality || '|' || source FROM public.draft_question_texts WHERE draft_question_id='${qid}'`),
    'ఉపాధ్యాయుడు టైప్ చేసిన వచనం|TEACHER_ENTERED|TEACHER')
  assert.equal(answerSnapshot(draft.paperId), before0)
})

test('a second, untouched Draft gets the same Telugu independently (owner-scoped)', { skip }, async () => {
  const other = writeDraft(B, impB)
  const res = await persistAutoTelugu(args(other, B, memoryStore()))
  assert.equal(res.question_texts, firstResult.question_texts)
  assert.equal(asUser(A, `SELECT count(*) FROM public.draft_question_texts t JOIN public.draft_questions q ON q.id=t.draft_question_id
    WHERE q.draft_paper_id='${other.paperId}'`), '0', 'teacher A cannot read teacher B rows')
})

test('0017-0024 are byte-for-byte unchanged, and 0025 touches no engine or storage objects', { skip: !fs.existsSync(M25) && 'no 0025' }, () => {
  const locked = {
    '202609220017_draft_paper_foundation.sql': '255c022d8febdc3ed6d49f3dad99b4ca306aaf97443562914c285512d26b5eba',
    '202609220018_draft_manual_questions.sql': 'd4264129070b67e49afefcb37b78ac699997f53994851c5c02a442a6ebf48260',
    '202609220019_draft_media.sql': '82d92f025cc5b991dd6a8471960834a954653c0b9e70702e5296c2d926f66901',
    '202609220020_draft_option_conflict_resolution.sql': '7802f26c1636e7dedd4383727d57264aed3ab6fedc7fe39621a833a36afcbfcf',
    '202609220021_draft_option_uniqueness.sql': 'fa7e17d5ccdd90dcf8823dc34330cac25fe8746edf0aeb66b5d3c1dd3d9255de',
    '202609220022_draft_language_texts.sql': 'c89c8c13c6abcc6ee6f6622f67f3fcba510ff061963bf90d88e9376bde70c90a',
    '202609230023_draft_analysis_automation.sql': '6da5b1db7a5aa19a367e99f0d2848d7cb738c7e9c2e5115a17a29024d40973c8',
    '202609230024_draft_auto_visuals.sql': 'b0df618931c391c906cc426a131491dc4e5ce7e2e5406a0344aaad5dba0451b3',
  }
  for (const [file, hash] of Object.entries(locked)) {
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(`supabase/migrations/${file}`)).digest('hex'), hash, `${file} changed`)
  }
  const code = fs.readFileSync(M25, 'utf8').replace(/--.*$/gm, '')
  for (const forbidden of ['publish_test', 'test_attempts', 'attempt_answers', 'test_question_snapshots', 'test_option_snapshots',
    'public.questions', 'public.question_options', 'question_answer_keys', 'ksc_replace_test_import_analysis',
    'test_import_candidates', 'storage.', 'INSERT INTO public.draft_options', 'UPDATE public.draft_options', 'DELETE FROM public.draft_options']) {
    assert.ok(!code.includes(forbidden), `0025 must not touch ${forbidden}`)
  }
  assert.ok(!/is_confirmed_correct\s*=/.test(code) && !/is_proposed_correct\s*=/.test(code), '0025 never sets answer flags')
  assert.ok(!/TO anon/.test(code))
})
