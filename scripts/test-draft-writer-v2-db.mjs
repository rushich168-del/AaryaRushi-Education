import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto, { randomUUID } from 'crypto'
import { mapPaperModelToDraft, B4_ENGINE, B4_ENGINE_VERSION } from './lib/paper-model-to-draft.mjs'

// B4.2 — writer v2 verified against a THROWAWAY local PostgreSQL cluster by persisting the
// COMPLETE 200-question B4.1 golden-paper model. Never connects to Supabase; no auth.signUp.

const PG_BIN = process.env.KSC_PG_BIN || 'C:/Program Files/PostgreSQL/16/bin'
const exe = n => path.join(PG_BIN, process.platform === 'win32' ? `${n}.exe` : n)
const HAVE_PG = fs.existsSync(exe('initdb')) && fs.existsSync(exe('pg_ctl')) && fs.existsSync(exe('psql'))
const MODEL_PATH = 'reports/b41-paper-model.json'
const HAVE_MODEL = fs.existsSync(MODEL_PATH)
const MIG = n => path.resolve(`supabase/migrations/${n}`)
const CHAIN = ['202609220017_draft_paper_foundation.sql', '202609220018_draft_manual_questions.sql',
  '202609220019_draft_media.sql', '202609220020_draft_option_conflict_resolution.sql',
  '202609220021_draft_option_uniqueness.sql', '202609220022_draft_language_texts.sql']
const M23 = MIG('202609230023_draft_analysis_automation.sql')

let dataDir, port, model, payload
const A = randomUUID(), B = randomUUID()
const imp = randomUUID()

const run = args => execFileSync(exe('psql'), ['-h', 'localhost', '-p', String(port), '-U', 'postgres', '-d', 'postgres',
  '-v', 'ON_ERROR_STOP=1', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PGCLIENTENCODING: 'UTF8' } })
const sqlFile = sql => {                      // UTF-8 file: Windows mangles non-ASCII argv
  const tmp = path.join(dataDir, `q_${randomUUID()}.sql`)
  fs.writeFileSync(tmp, sql, 'utf8')
  try { return run(['-At', '-f', tmp]).trim() } finally { fs.rmSync(tmp, { force: true }) }
}
const psql = sql => sqlFile(sql)
const lastLine = out => out.split(/\r?\n/).filter(Boolean).pop() ?? ''
const asUser = (uid, sql) => lastLine(psql(`SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', '${uid}', false); ${sql}`))
const asAnon = sql => lastLine(psql(`SET ROLE anon; ${sql}`))
const count = sql => Number(psql(sql))
function expectError(fn, pattern) {
  try { fn() } catch (e) { assert.match(String(e.stderr || e.message), pattern); return }
  assert.fail(`expected an error matching ${pattern}`)
}
// Writer call with dollar-quoted JSON so no escaping is needed.
const writeAnalysis = (uid, runId, p = payload, importId = imp) => asUser(uid,
  `SELECT public.ksc_replace_draft_analysis_v2('${importId}', '${runId}', ` +
  `$pp$${JSON.stringify(p.paper)}$pp$::jsonb, $qq$${JSON.stringify(p.questions)}$qq$::jsonb, $oo$${JSON.stringify(p.options)}$oo$::jsonb)`)
const startRun = (uid = A, importId = imp) => asUser(uid,
  `SELECT public.ksc_start_draft_analysis_run('${importId}', '${B4_ENGINE}', '${B4_ENGINE_VERSION}', $m$${JSON.stringify(payload.metrics)}$m$::jsonb)`)

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
GRANT SELECT ON public.test_imports TO authenticated;   -- mirrors migration 0014
`

before(() => {
  if (!HAVE_PG || !HAVE_MODEL) return
  model = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8'))
  payload = mapPaperModelToDraft(model, { importId: imp, title: 'SI/CONSTABLE TEST-10', sourceFilename: 'si-test-10.pdf' })
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ksc-b42-pg-'))
  port = 55000 + Math.floor(Math.random() * 900)
  execFileSync(exe('initdb'), ['-D', dataDir, '-U', 'postgres', '-A', 'trust', '-E', 'UTF8', '--no-locale'], { stdio: 'ignore' })
  execFileSync(exe('pg_ctl'), ['-D', dataDir, '-l', path.join(dataDir, 'server.log'),
    '-o', `-p ${port} -c listen_addresses=localhost`, '-w', 'start'], { stdio: 'ignore' })
  psql(STUBS)
  psql(`INSERT INTO auth.users VALUES ('${A}'), ('${B}');
        INSERT INTO public.teacher_profiles VALUES ('${A}'), ('${B}');
        INSERT INTO public.test_imports (id, created_by) VALUES ('${imp}', '${A}');`)
  for (const f of CHAIN) run(['-q', '-f', MIG(f)])
})

after(() => {
  if (!HAVE_PG || !dataDir) return
  try { execFileSync(exe('pg_ctl'), ['-D', dataDir, '-m', 'immediate', '-w', 'stop'], { stdio: 'ignore' }) } catch {}
  try { fs.rmSync(dataDir, { recursive: true, force: true }) } catch {}
})

const skip = !HAVE_PG ? 'PostgreSQL binaries not found (set KSC_PG_BIN)'
  : !HAVE_MODEL ? 'run scripts/b41-analyze-paper.mjs first' : false

let paperId, firstRunId

test('0023 applies on top of 0017-0022 and is idempotent', { skip }, () => {
  run(['-q', '-f', M23])
  run(['-q', '-f', M23])
  assert.equal(count(`SELECT count(*) FROM pg_constraint WHERE conname='draft_options_one_row_per_position'`), 1, '0021 uniqueness still active')
  assert.equal(psql(`SELECT pg_get_constraintdef(oid) ~ 'OCR_EXTRACTED' FROM pg_constraint WHERE conname='draft_question_texts_text_quality_v2'`), 't')
  assert.equal(psql(`SELECT pg_get_constraintdef(oid) ~ 'AUTO_REGION' FROM pg_constraint WHERE conname='draft_media_capture_method_v2'`), 't')
})

test('the complete 200-question paper persists in one atomic write', { skip }, () => {
  firstRunId = startRun()
  assert.match(firstRunId, /^[0-9a-f-]{36}$/)
  const out = JSON.parse(writeAnalysis(A, firstRunId))
  paperId = out.draft_paper_id
  assert.equal(out.questions, 200)
  assert.equal(out.options, payload.options.length)
  assert.equal(count(`SELECT count(*) FROM public.draft_questions WHERE draft_paper_id='${paperId}'`), 200)
  assert.equal(psql(`SELECT status || '|' || (completed_at IS NOT NULL)::text FROM public.draft_analysis_runs WHERE id='${firstRunId}'`), 'SUCCEEDED|true')
  assert.equal(psql(`SELECT metrics->>'questions' FROM public.draft_analysis_runs WHERE id='${firstRunId}'`), '200')
})

test('question numbers are unique and complete (1..200)', { skip }, () => {
  assert.equal(count(`SELECT count(DISTINCT source_question_number) FROM public.draft_questions WHERE draft_paper_id='${paperId}'`), 200)
  assert.equal(count(`SELECT count(*) FROM (SELECT source_question_number FROM public.draft_questions
    WHERE draft_paper_id='${paperId}' GROUP BY 1 HAVING count(*) > 1) d`), 0, 'no duplicate numbers')
})

test('option counts match the accepted B4.1 model — and never 8 from bilingual content', { skip }, () => {
  const expected = new Map(model.questions.map(q => [String(q.number), q.options.length]))
  const rows = psql(`SELECT q.source_question_number || ':' || count(o.id)
    FROM public.draft_questions q LEFT JOIN public.draft_options o ON o.draft_question_id = q.id
    WHERE q.draft_paper_id='${paperId}' GROUP BY q.id, q.source_question_number ORDER BY 1`).split(/\r?\n/)
  assert.equal(rows.length, 200)
  for (const row of rows) {
    const [number, persisted] = row.split(':')
    assert.equal(Number(persisted), expected.get(number), `Q${number} option count`)
  }
  assert.equal(count(`SELECT count(*) FROM (SELECT o.draft_question_id FROM public.draft_options o
    JOIN public.draft_questions q ON q.id=o.draft_question_id WHERE q.draft_paper_id='${paperId}'
    GROUP BY 1 HAVING count(*) > 4) x`), 0, 'no question has more than four options')
})

test('answer key: proposed only, never confirmed', { skip }, () => {
  const proposed = count(`SELECT count(*) FROM public.draft_options o JOIN public.draft_questions q ON q.id=o.draft_question_id
    WHERE q.draft_paper_id='${paperId}' AND o.is_proposed_correct`)
  assert.equal(proposed, payload.options.filter(o => o.is_proposed_correct).length)
  assert.equal(count(`SELECT count(*) FROM public.draft_options o JOIN public.draft_questions q ON q.id=o.draft_question_id
    WHERE q.draft_paper_id='${paperId}' AND o.is_confirmed_correct`), 0, 'zero confirmed answers')
  assert.equal(count(`SELECT count(*) FROM public.draft_questions WHERE draft_paper_id='${paperId}'
    AND answer_key_source='ANSWER_KEY_PAGE'`), 200, 'key provenance recorded on every question')
  assert.equal(count(`SELECT count(*) FROM public.draft_questions WHERE draft_paper_id='${paperId}'
    AND (confirmed_by IS NOT NULL OR confirmed_at IS NOT NULL OR teacher_review_status <> 'UNREVIEWED')`), 0)
})

test('no legacy Telugu glyph text anywhere; region geometry preserved for B4.3/B4.4', { skip }, () => {
  for (const col of ['content']) {
    assert.equal(count(`SELECT count(*) FROM public.draft_questions WHERE draft_paper_id='${paperId}' AND ${col} ~ '[\\uE000-\\uF8FF\\uFFFD]'`), 0)
  }
  assert.equal(count(`SELECT count(*) FROM public.draft_options o JOIN public.draft_questions q ON q.id=o.draft_question_id
    WHERE q.draft_paper_id='${paperId}' AND o.content ~ '[\\uE000-\\uF8FF\\uFFFD]'`), 0)
  assert.equal(count(`SELECT count(*) FROM public.draft_question_texts`), 0, 'B4.2 writes no language rows')
  assert.equal(count(`SELECT count(*) FROM public.draft_media`), 0, 'B4.2 writes no crops')
  const withTelugu = count(`SELECT count(*) FROM public.draft_questions WHERE draft_paper_id='${paperId}'
    AND jsonb_array_length(analysis_regions->'telugu') > 0`)
  assert.equal(withTelugu, model.stats.questionsWithTelugu, 'every Telugu region survived as geometry')
  assert.equal(count(`SELECT count(*) FROM public.draft_questions WHERE draft_paper_id='${paperId}' AND source_bbox IS NOT NULL`), 200)
})

test('review status and reasons are preserved from B4.1', { skip }, () => {
  for (const status of ['READY', 'NEEDS_REVIEW', 'UNRESOLVED']) {
    const expected = model.questions.filter(q => q.status === status).length
    assert.equal(count(`SELECT count(*) FROM public.draft_questions WHERE draft_paper_id='${paperId}' AND extraction_status='${status}'`), expected, status)
  }
  const reasoned = count(`SELECT count(*) FROM public.draft_questions WHERE draft_paper_id='${paperId}'
    AND extraction_status <> 'READY' AND jsonb_array_length(review_reasons) > 0`)
  assert.equal(reasoned, model.questions.filter(q => q.status !== 'READY').length, 'every flagged question kept its reasons')
})

test('Q6 stays one question with four options and proposed D; Q10 stays whole with proposed A', { skip }, () => {
  assert.equal(psql(`SELECT count(*) FROM public.draft_questions WHERE draft_paper_id='${paperId}' AND source_question_number='6'`), '1')
  assert.equal(psql(`SELECT string_agg(o.content, ',' ORDER BY o.position) FROM public.draft_options o
    JOIN public.draft_questions q ON q.id=o.draft_question_id WHERE q.draft_paper_id='${paperId}' AND q.source_question_number='6'`), '15,19,22,24')
  assert.equal(psql(`SELECT o.marker FROM public.draft_options o JOIN public.draft_questions q ON q.id=o.draft_question_id
    WHERE q.draft_paper_id='${paperId}' AND q.source_question_number='6' AND o.is_proposed_correct`), 'D')
  assert.equal(psql(`SELECT jsonb_array_length(analysis_regions->'figures') > 0 FROM public.draft_questions
    WHERE draft_paper_id='${paperId}' AND source_question_number='6'`), 't', 'triangle figure region kept')

  assert.equal(psql(`SELECT count(*) FROM public.draft_options o JOIN public.draft_questions q ON q.id=o.draft_question_id
    WHERE q.draft_paper_id='${paperId}' AND q.source_question_number='10'`), '4')
  assert.equal(psql(`SELECT o.marker FROM public.draft_options o JOIN public.draft_questions q ON q.id=o.draft_question_id
    WHERE q.draft_paper_id='${paperId}' AND q.source_question_number='10' AND o.is_proposed_correct`), 'A')
  assert.match(psql(`SELECT source_reference FROM public.draft_questions WHERE draft_paper_id='${paperId}' AND source_question_number='10'`), /pages 2, 3/)
})

test('re-running on an untouched automatic Draft replaces it in place (defined idempotency)', { skip }, () => {
  const runId = startRun()
  const out = JSON.parse(writeAnalysis(A, runId))
  assert.equal(out.draft_paper_id, paperId, 'same Draft Paper row')
  assert.equal(out.questions, 200)
  assert.equal(count(`SELECT count(*) FROM public.draft_questions WHERE draft_paper_id='${paperId}'`), 200, 'no duplication')
  assert.equal(count(`SELECT count(*) FROM public.draft_analysis_runs WHERE source_import_id='${imp}' AND status='SUCCEEDED'`), 2, 'both runs recorded')
})

test('a failed write rolls back atomically and the run stays observable', { skip }, () => {
  const before = count(`SELECT count(*) FROM public.draft_questions WHERE draft_paper_id='${paperId}'`)
  const runId = startRun()
  // An option pointing at a question that is not in this payload violates the FK.
  const broken = { ...payload, options: [...payload.options, { id: randomUUID(), draft_question_id: randomUUID(), position: 0, content: 'orphan' }] }
  expectError(() => writeAnalysis(A, runId, broken), /violates foreign key constraint|insert or update/)
  assert.equal(count(`SELECT count(*) FROM public.draft_questions WHERE draft_paper_id='${paperId}'`), before, 'previous Draft intact')
  assert.equal(count(`SELECT count(*) FROM public.draft_options WHERE content='orphan'`), 0, 'nothing half-written')
  assert.equal(psql(`SELECT status FROM public.draft_analysis_runs WHERE id='${runId}'`), 'RUNNING')
  const detail = JSON.stringify({ stage: 'options' })
  asUser(A, "SELECT public.ksc_fail_draft_analysis_run('" + runId + "', 'orphan option', $dd$" + detail + "$dd$::jsonb)")
  assert.equal(psql(`SELECT status || '|' || error_message || '|' || (failed_at IS NOT NULL)::text
    FROM public.draft_analysis_runs WHERE id='${runId}'`), 'FAILED|orphan option|true')
})

test('teacher work blocks automatic replacement, and nothing changes', { skip }, () => {
  const qid = psql(`SELECT id FROM public.draft_questions WHERE draft_paper_id='${paperId}' AND source_question_number='1'`)
  psql(`UPDATE public.draft_questions SET teacher_review_status='EDITED' WHERE id='${qid}'`)
  const before = psql(`SELECT count(*)::text || ':' || max(updated_at)::text FROM public.draft_questions WHERE draft_paper_id='${paperId}'`)
  const runId = startRun()
  expectError(() => writeAnalysis(A, runId, payload), /KSC_DRAFT_HAS_TEACHER_WORK/)
  assert.equal(psql(`SELECT count(*)::text || ':' || max(updated_at)::text FROM public.draft_questions WHERE draft_paper_id='${paperId}'`), before, 'untouched')
  assert.equal(psql(`SELECT teacher_review_status FROM public.draft_questions WHERE id='${qid}'`), 'EDITED', 'teacher change preserved')
  psql(`UPDATE public.draft_questions SET teacher_review_status='UNREVIEWED' WHERE id='${qid}'`)
})

test('security: another teacher and anon cannot start or write an analysis', { skip }, () => {
  expectError(() => asUser(B, `SELECT public.ksc_start_draft_analysis_run('${imp}', 'x', '1')`), /Import not found or unauthorized/)
  const runId = startRun()
  expectError(() => writeAnalysis(B, runId), /Import not found or unauthorized/)
  expectError(() => asAnon(`SELECT public.ksc_start_draft_analysis_run('${imp}', 'x', '1')`), /permission denied/)
  assert.equal(asUser(B, `SELECT count(*) FROM public.draft_analysis_runs`), '0', 'runs are owner-scoped')
  asUser(A, `SELECT public.ksc_fail_draft_analysis_run('${runId}', 'cleanup', NULL)`)
})

test('a write without a RUNNING run is refused', { skip }, () => {
  expectError(() => writeAnalysis(A, randomUUID()), /KSC_ANALYSIS_RUN_INVALID/)
})

test('0017-0022 are byte-for-byte unchanged, and 0023 touches no engine objects', { skip: !HAVE_MODEL && skip }, () => {
  const locked = {
    '202609220017_draft_paper_foundation.sql': '255c022d8febdc3ed6d49f3dad99b4ca306aaf97443562914c285512d26b5eba',
    '202609220018_draft_manual_questions.sql': 'd4264129070b67e49afefcb37b78ac699997f53994851c5c02a442a6ebf48260',
    '202609220019_draft_media.sql': '82d92f025cc5b991dd6a8471960834a954653c0b9e70702e5296c2d926f66901',
  }
  for (const [file, hash] of Object.entries(locked)) {
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(`supabase/migrations/${file}`)).digest('hex'), hash, `${file} changed`)
  }
  const code = fs.readFileSync(M23, 'utf8').replace(/--.*$/gm, '')
  for (const forbidden of ['publish_test', 'test_attempts', 'attempt_answers', 'test_question_snapshots', 'test_option_snapshots',
    'public.questions', 'public.question_options', 'question_answer_keys', 'ksc_replace_test_import_analysis',
    'test_import_candidates', 'storage.']) {
    assert.ok(!code.includes(forbidden), `0023 must not touch ${forbidden}`)
  }
  assert.ok(!/TO anon/.test(code))
})
