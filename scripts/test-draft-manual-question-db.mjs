import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'

// P0-B1 behavioral checks of migrations 0017 + 0018 against a THROWAWAY local
// PostgreSQL cluster created in the OS temp dir and deleted afterwards.
// Never connects to Supabase. No auth.signUp. Minimal stubs stand in for the
// KSC baseline objects that 0017/0018 depend on (auth.uid, is_teacher, ...).
// Skips if PostgreSQL binaries are not available (set KSC_PG_BIN to override).

const PG_BIN = process.env.KSC_PG_BIN || 'C:/Program Files/PostgreSQL/16/bin'
const exe = name => path.join(PG_BIN, process.platform === 'win32' ? `${name}.exe` : name)
const HAVE_PG = fs.existsSync(exe('initdb')) && fs.existsSync(exe('pg_ctl')) && fs.existsSync(exe('psql'))

const M17 = path.resolve('supabase/migrations/202609220017_draft_paper_foundation.sql')
const M18 = path.resolve('supabase/migrations/202609220018_draft_manual_questions.sql')

let dataDir, port

function psql(sql) {
  return execFileSync(exe('psql'), ['-h', 'localhost', '-p', String(port), '-U', 'postgres', '-d', 'postgres',
    '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}
function psqlFile(file) {
  return execFileSync(exe('psql'), ['-h', 'localhost', '-p', String(port), '-U', 'postgres', '-d', 'postgres',
    '-v', 'ON_ERROR_STOP=1', '-q', '-f', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}
// psql echoes each statement's result; the caller wants only the final statement's.
const lastLine = out => out.split(/\r?\n/).filter(Boolean).pop() ?? ''
// Run SQL as an authenticated user (role + JWT subject), in one transaction.
const asUser = (uid, sql) =>
  lastLine(psql(`SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', '${uid}', true); ${sql}`))
const asAnon = sql => lastLine(psql(`SET ROLE anon; ${sql}`))
function expectError(fn, pattern) {
  try { fn() } catch (e) { assert.match(String(e.stderr || e.message), pattern); return }
  assert.fail(`expected an error matching ${pattern}`)
}

const A = randomUUID(), B = randomUUID(), S = randomUUID()
const impA = randomUUID(), impA2 = randomUUID(), impA3 = randomUUID(), impA4 = randomUUID(), impB = randomUUID()

function analysisFor() {
  const q9 = randomUUID(), q11 = randomUUID()
  const questions = [
    { id: q9, position: 0, source_question_number: '9', content: 'Q9 text', extraction_status: 'NEEDS_REVIEW', warnings: [] },
    { id: q11, position: 1, source_question_number: '11', content: 'Q11 text', extraction_status: 'NEEDS_REVIEW',
      warnings: ['QUESTION_ORDER_SUSPICIOUS: Follows Q9, jumping to Q11.'] },
  ]
  const options = []
  for (const [qid, prefix] of [[q9, 'a'], [q11, 'b']]) {
    for (let i = 0; i < 4; i++) {
      options.push({ id: randomUUID(), draft_question_id: qid, position: i, content: `${prefix}${i}`, is_proposed_correct: i === 0 })
    }
  }
  return { q9, q11, questions, options }
}
const replaceSql = (imp, a) =>
  `SELECT public.ksc_replace_draft_analysis('${imp}'::uuid, '{"title":"SI Model"}'::jsonb, '[]'::jsonb, ` +
  `'${JSON.stringify(a.questions)}'::jsonb, '${JSON.stringify(a.options)}'::jsonb)`
const paperOf = imp => psql(`SELECT id FROM public.draft_papers WHERE source_import_id = '${imp}'`)
const countQ = paper => Number(psql(`SELECT count(*) FROM public.draft_questions WHERE draft_paper_id = '${paper}'`))
const countO = paper => Number(psql(`SELECT count(*) FROM public.draft_options o JOIN public.draft_questions q ON q.id = o.draft_question_id WHERE q.draft_paper_id = '${paper}'`))

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
`

before(() => {
  if (!HAVE_PG) return
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ksc-b1-pg-'))
  port = 55000 + Math.floor(Math.random() * 900)
  execFileSync(exe('initdb'), ['-D', dataDir, '-U', 'postgres', '-A', 'trust', '-E', 'UTF8', '--no-locale'], { stdio: 'ignore' })
  execFileSync(exe('pg_ctl'), ['-D', dataDir, '-l', path.join(dataDir, 'server.log'),
    '-o', `-p ${port} -c listen_addresses=localhost`, '-w', 'start'], { stdio: 'ignore' })
  psql(STUBS)
  psql(`INSERT INTO auth.users VALUES ('${A}'), ('${B}'), ('${S}');
        INSERT INTO public.teacher_profiles VALUES ('${A}'), ('${B}');
        INSERT INTO public.test_imports (id, created_by) VALUES
          ('${impA}','${A}'), ('${impA2}','${A}'), ('${impA3}','${A}'), ('${impA4}','${A}'), ('${impB}','${B}');`)
})

after(() => {
  if (!HAVE_PG || !dataDir) return
  try { execFileSync(exe('pg_ctl'), ['-D', dataDir, '-m', 'immediate', '-w', 'stop'], { stdio: 'ignore' }) } catch {}
  try { fs.rmSync(dataDir, { recursive: true, force: true }) } catch {}
})

const skip = HAVE_PG ? false : 'PostgreSQL binaries not found (set KSC_PG_BIN)'

test('0017 then 0018 apply cleanly, and 0018 is idempotent', { skip }, () => {
  psqlFile(M17)
  psqlFile(M18)
  psqlFile(M18) // re-run must not fail
  assert.equal(psql(`SELECT column_default FROM information_schema.columns WHERE table_name='draft_questions' AND column_name='origin'`), `'EXTRACTED'::text`)
})

let paperA, a
test('13. untouched extraction-only Draft remains eligible for Retry', { skip }, () => {
  a = analysisFor()
  asUser(A, replaceSql(impA, a))
  paperA = paperOf(impA)
  assert.equal(asUser(A, `SELECT public.ksc_draft_has_teacher_work('${paperA}')`), 'f')
  a = analysisFor() // Retry with fresh analysis succeeds on an untouched paper
  asUser(A, replaceSql(impA, a))
  assert.equal(paperOf(impA), paperA, 'same paper upserted')
  assert.equal(countQ(paperA), 2)
})

let q10
test('3-6. manual insert: TEACHER origin, between Q9 and Q11, ordering kept, no answer', { skip }, () => {
  const out = JSON.parse(asUser(A, `SELECT public.ksc_insert_draft_question('${paperA}', 1, '10', 'Assertion (A): ...', 'Teacher added during preparation between Q9 and Q11')`))
  q10 = out.id
  assert.equal(out.position, 1)
  assert.equal(asUser(A, `SELECT string_agg(source_question_number, ',' ORDER BY position) FROM public.draft_questions WHERE draft_paper_id='${paperA}'`), '9,10,11')
  const row = asUser(A, `SELECT origin||'|'||coalesce(source_page::text,'NULL')||'|'||teacher_review_status||'|'||coalesce(confirmed_by::text,'NULL')||'|'||source_reference FROM public.draft_questions WHERE id='${q10}'`)
  assert.equal(row, 'TEACHER|NULL|EDITED|NULL|Teacher added during preparation between Q9 and Q11')
  assert.equal(asUser(A, `SELECT count(*) FROM public.draft_options WHERE draft_question_id='${q10}'`), '0')
  assert.equal(asUser(A, `SELECT string_agg(origin||':'||source_question_number, ',' ORDER BY position) FROM public.draft_questions WHERE draft_paper_id='${paperA}' AND id <> '${q10}'`),
    'EXTRACTED:9,EXTRACTED:11', 'extracted provenance untouched')
})

test('7-9. options populate the new question; explicit confirm works; proposed never auto-confirmed', { skip }, () => {
  const opt = asUser(A, `WITH ins AS (INSERT INTO public.draft_options (draft_question_id, position, content, origin) VALUES ('${q10}', 0, 'Both A and R are true', 'TEACHER') RETURNING id) SELECT id FROM ins`)
  asUser(A, `SELECT public.ksc_confirm_draft_single_choice('${q10}', '${opt}')`)
  assert.equal(asUser(A, `SELECT teacher_review_status||'|'||(confirmed_by='${A}')::text FROM public.draft_questions WHERE id='${q10}'`), 'CONFIRMED|true')
  assert.equal(asUser(A, `SELECT is_confirmed_correct FROM public.draft_options WHERE id='${opt}'`), 't')
  assert.equal(asUser(A, `SELECT count(*) FROM public.draft_options WHERE draft_question_id='${a.q9}' AND is_confirmed_correct`), '0')
  assert.equal(asUser(A, `SELECT count(*) FROM public.draft_options WHERE draft_question_id='${a.q9}' AND is_proposed_correct`), '1')
})

test('10 + 12. Retry is rejected with a controlled token when a TEACHER question exists; data untouched', { skip }, () => {
  const beforeQ = countQ(paperA), beforeO = countO(paperA)
  expectError(() => asUser(A, replaceSql(impA, analysisFor())), /KSC_DRAFT_HAS_TEACHER_WORK/)
  assert.equal(countQ(paperA), beforeQ)
  assert.equal(countO(paperA), beforeO)
  assert.equal(psql(`SELECT count(*) FROM public.draft_questions WHERE id='${q10}'`), '1')
})

test('11. Retry is rejected when an extracted question was edited, option-edited, or confirmed', { skip }, () => {
  // (a) question edited
  const a2 = analysisFor(); asUser(A, replaceSql(impA2, a2))
  asUser(A, `UPDATE public.draft_questions SET content='fixed', teacher_review_status='EDITED' WHERE id='${a2.q9}'`)
  expectError(() => asUser(A, replaceSql(impA2, analysisFor())), /KSC_DRAFT_HAS_TEACHER_WORK/)
  assert.equal(psql(`SELECT content FROM public.draft_questions WHERE id='${a2.q9}'`), 'fixed')
  // (b) only an option text edited (no question status change)
  const a3 = analysisFor(); asUser(A, replaceSql(impA3, a3))
  asUser(A, `UPDATE public.draft_options SET content='corrected' WHERE draft_question_id='${a3.q11}' AND position=2`)
  expectError(() => asUser(A, replaceSql(impA3, analysisFor())), /KSC_DRAFT_HAS_TEACHER_WORK/)
  // (c) extracted question confirmed by teacher
  const a4 = analysisFor(); asUser(A, replaceSql(impA4, a4))
  const o = asUser(A, `SELECT id FROM public.draft_options WHERE draft_question_id='${a4.q9}' AND position=1`)
  asUser(A, `SELECT public.ksc_confirm_draft_single_choice('${a4.q9}', '${o}')`)
  expectError(() => asUser(A, replaceSql(impA4, analysisFor())), /KSC_DRAFT_HAS_TEACHER_WORK/)
})

test('14. security stays teacher-owner scoped', { skip }, () => {
  expectError(() => asUser(B, `SELECT public.ksc_insert_draft_question('${paperA}', 0, '1', 'x', 'y')`), /not found or unauthorized/)
  assert.equal(asUser(B, `SELECT count(*) FROM public.draft_questions WHERE draft_paper_id='${paperA}'`), '0', 'other teacher sees nothing')
  assert.equal(asUser(B, `SELECT public.ksc_draft_has_teacher_work('${paperA}')`), 'f', 'no information leak')
  expectError(() => asUser(B, replaceSql(impA, analysisFor())), /Import not found or unauthorized/)
  expectError(() => asUser(S, `SELECT public.ksc_insert_draft_question('${paperA}', 0, '1', 'x', 'y')`), /Teacher access required/)
  expectError(() => asAnon(`SELECT public.ksc_insert_draft_question('${paperA}', 0, '1', 'x', 'y')`), /permission denied/)
  expectError(() => asAnon(`SELECT count(*) FROM public.draft_questions`), /permission denied/)
})
