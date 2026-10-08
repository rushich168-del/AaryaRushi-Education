import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'

// Migration 0020 behavior against a THROWAWAY local PostgreSQL cluster (OS temp dir,
// deleted afterwards). Reproduces the Q6 duplicate-option state and every unsafe case.
// Never connects to Supabase; no auth.signUp. Skips without local PG (KSC_PG_BIN).

const PG_BIN = process.env.KSC_PG_BIN || 'C:/Program Files/PostgreSQL/16/bin'
const exe = name => path.join(PG_BIN, process.platform === 'win32' ? `${name}.exe` : name)
const HAVE_PG = fs.existsSync(exe('initdb')) && fs.existsSync(exe('pg_ctl')) && fs.existsSync(exe('psql'))
const MIG = n => path.resolve(`supabase/migrations/${n}`)
const M20 = MIG('202609220020_draft_option_conflict_resolution.sql')
const M21 = MIG('202609220021_draft_option_uniqueness.sql')

let dataDir, port
const run = (args) => execFileSync(exe('psql'), ['-h', 'localhost', '-p', String(port), '-U', 'postgres', '-d', 'postgres',
  '-v', 'ON_ERROR_STOP=1', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const psql = sql => run(['-At', '-c', sql]).trim()
const psqlFile = f => run(['-q', '-f', f])
const lastLine = out => out.split(/\r?\n/).filter(Boolean).pop() ?? ''
const asUser = (uid, sql) =>
  lastLine(psql(`SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', '${uid}', true); ${sql}`))
const asAnon = sql => lastLine(psql(`SET ROLE anon; ${sql}`))
function expectError(fn, pattern) {
  try { fn() } catch (e) { assert.match(String(e.stderr || e.message), pattern); return }
  assert.fail(`expected an error matching ${pattern}`)
}

const A = randomUUID(), B = randomUUID()
const imp = randomUUID()
const q = { q6: randomUUID(), qD: randomUUID(), qC: randomUUID(), qM: randomUUID(), qX: randomUUID() }
const mediaPath = (paper, id) => `imports/${A}/draft-media/${paper}/${id}.png`

// Insert an option directly as teacher A (possible before 0020). Returns its id.
const addOption = (qid, position, content, origin = 'TEACHER') =>
  asUser(A, `WITH ins AS (INSERT INTO public.draft_options (draft_question_id, position, content, origin)
    VALUES ('${qid}', ${position}, '${content}', '${origin}') RETURNING id) SELECT id FROM ins`)
const addMedia = (paper, { question = null, option = null }) => {
  const id = randomUUID()
  const qv = v => (v ? `'${v}'` : 'NULL')
  return asUser(A, `WITH ins AS (INSERT INTO public.draft_media (id, draft_paper_id, draft_question_id, draft_option_id,
      media_kind, storage_path, source_page, region_x, region_y, region_w, region_h, page_width_pt, page_height_pt, render_scale)
    VALUES ('${id}', '${paper}', ${qv(question)}, ${qv(option)}, 'DIAGRAM', '${mediaPath(paper, id)}', 1, 0.1, 0.1, 0.3, 0.2, 595, 842, 2)
    RETURNING id) SELECT id FROM ins`)
}
const rowsOf = qid => psql(`SELECT string_agg(position || '=' || content, ',' ORDER BY position, created_at) FROM public.draft_options WHERE draft_question_id='${qid}'`)
const count = sql => Number(psql(sql))
const hasConstraint = () => psql(`SELECT count(*) FROM pg_constraint WHERE conname='draft_options_one_row_per_position'`) === '1'

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
`

let paper, q6Confirmed, q6MediaId
before(() => {
  if (!HAVE_PG) return
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ksc-0020-pg-'))
  port = 55000 + Math.floor(Math.random() * 900)
  execFileSync(exe('initdb'), ['-D', dataDir, '-U', 'postgres', '-A', 'trust', '-E', 'UTF8', '--no-locale'], { stdio: 'ignore' })
  execFileSync(exe('pg_ctl'), ['-D', dataDir, '-l', path.join(dataDir, 'server.log'),
    '-o', `-p ${port} -c listen_addresses=localhost`, '-w', 'start'], { stdio: 'ignore' })
  psql(STUBS)
  psql(`INSERT INTO auth.users VALUES ('${A}'), ('${B}'); INSERT INTO public.teacher_profiles VALUES ('${A}'), ('${B}');
        INSERT INTO public.test_imports (id, created_by) VALUES ('${imp}', '${A}');`)
  for (const f of ['202609220017_draft_paper_foundation.sql', '202609220018_draft_manual_questions.sql', '202609220019_draft_media.sql']) psqlFile(MIG(f))
  psqlFile(M20) // conflict-resolution foundation applies cleanly even while duplicates exist

  // Paper with questions that have NO extracted options (like Q6 after bilingual rejection).
  const questions = Object.entries(q).map(([num, id], i) => ({ id, position: i, source_question_number: num, content: `Question ${num}`, source_page: 1 }))
  asUser(A, `SELECT public.ksc_replace_draft_analysis('${imp}', '{}'::jsonb, '[]'::jsonb, '${JSON.stringify(questions)}'::jsonb, '[]'::jsonb)`)
  paper = psql(`SELECT id FROM public.draft_papers WHERE source_import_id='${imp}'`)

  // Q6: teacher repair saved twice -> two identical batches at positions 0..3.
  const values = ['15', '19', '22', '24']
  values.forEach((v, i) => addOption(q.q6, i, v))
  const second = values.map((v, i) => addOption(q.q6, i, v))
  // The confirmed answer happens to be on a LATER twin (position 2) — must be kept.
  asUser(A, `SELECT public.ksc_confirm_draft_single_choice('${q.q6}', '${second[2]}')`)
  q6Confirmed = second[2]
  // Q6's triangle diagram is question-owned.
  q6MediaId = addMedia(paper, { question: q.q6 })
})

after(() => {
  if (!HAVE_PG || !dataDir) return
  try { execFileSync(exe('pg_ctl'), ['-D', dataDir, '-m', 'immediate', '-w', 'stop'], { stdio: 'ignore' }) } catch {}
  try { fs.rmSync(dataDir, { recursive: true, force: true }) } catch {}
})

const skip = HAVE_PG ? false : 'PostgreSQL binaries not found (set KSC_PG_BIN)'

function expectUnsafe(reason) {
  expectError(() => psqlFile(M21), new RegExp(`KSC_UNSAFE_DUPLICATE_OPTIONS[\\s\\S]*${reason}`))
  assert.equal(hasConstraint(), false, 'no constraint after a failed migration')
  assert.equal(count(`SELECT count(*) FROM public.draft_options WHERE draft_question_id='${q.q6}'`), 8, 'nothing changed (rolled back)')
}

test('reproduced Q6 state: 8 rows = two identical teacher batches at positions 0..3', { skip }, () => {
  assert.equal(rowsOf(q.q6), '0=15,0=15,1=19,1=19,2=22,2=22,3=24,3=24')
})

test('4. different content at the same position -> repair refused, nothing changed', { skip }, () => {
  addOption(q.qD, 0, 'A'); const b = addOption(q.qD, 0, 'B')
  expectUnsafe('content differs')
  psql(`DELETE FROM public.draft_options WHERE id='${b}'`) // resolve manually
})

test('2. a repair that would remove a confirmed row -> refused', { skip }, () => {
  const c1 = addOption(q.qC, 0, 'X'); const c2 = addOption(q.qC, 0, 'X')
  psql(`UPDATE public.draft_options SET is_confirmed_correct = true WHERE id IN ('${c1}', '${c2}')`) // corrupt: two confirmed
  expectUnsafe('is confirmed correct')
  psql(`UPDATE public.draft_options SET is_confirmed_correct = false WHERE id = '${c2}'`)
})

test('3. duplicate carrying a visual -> refused', { skip }, () => {
  const m1 = addOption(q.qM, 0, 'Y'); const m2 = addOption(q.qM, 0, 'Y')
  addMedia(paper, { option: m1 }); const media2 = addMedia(paper, { option: m2 })
  expectUnsafe('has an attached visual')
  psql(`DELETE FROM public.draft_media WHERE id='${media2}'`)
})

test('extracted (non-teacher) duplicate -> refused', { skip }, () => {
  addOption(q.qX, 0, 'Z', 'TEACHER'); const x = addOption(q.qX, 0, 'Z', 'EXTRACTED')
  expectUnsafe('not teacher-origin')
  psql(`DELETE FROM public.draft_options WHERE id='${x}'`)
})

test('1 + 11. identical safe duplicates are removed; Q6 ends with 4 rows, answer + diagram kept', { skip }, () => {
  psqlFile(M21)
  assert.equal(hasConstraint(), true)
  assert.equal(rowsOf(q.q6), '0=15,1=19,2=22,3=24')
  assert.equal(psql(`SELECT is_confirmed_correct FROM public.draft_options WHERE id='${q6Confirmed}'`), 't', 'confirmed twin was the keeper')
  assert.equal(count(`SELECT count(*) FROM public.draft_options WHERE draft_question_id='${q.q6}' AND is_confirmed_correct`), 1)
  assert.equal(count(`SELECT count(*) FROM public.draft_media WHERE id='${q6MediaId}'`), 1, 'question diagram untouched')
  assert.equal(psql(`SELECT content FROM public.draft_questions WHERE id='${q.q6}'`), 'Question q6', 'question text untouched')
  assert.equal(count(`SELECT count(*) FROM ksc_private.draft_option_repair_log WHERE draft_question_id='${q.q6}'`), 4, 'each removed row fully logged')
  assert.equal(count(`SELECT count(*) FROM public.draft_options WHERE draft_question_id='${q.qM}'`), 1, 'the row with the visual was kept')
})

test('0020 and 0021 are idempotent', { skip }, () => {
  psqlFile(M20)
  psqlFile(M21)
  assert.equal(rowsOf(q.q6), '0=15,1=19,2=22,3=24')
})

test('5. the unique constraint rejects a concurrent duplicate insertion', { skip }, () => {
  expectError(() => addOption(q.q6, 0, '15'), /draft_options_one_row_per_position/)
})

test('8. explicit Remove option deletes the row (and it stays gone)', { skip }, () => {
  const id = psql(`SELECT id FROM public.draft_options WHERE draft_question_id='${q.q6}' AND position=3`)
  asUser(A, `SELECT public.ksc_remove_draft_option('${id}')`)
  assert.equal(count(`SELECT count(*) FROM public.draft_options WHERE id='${id}'`), 0)
  assert.equal(rowsOf(q.q6), '0=15,1=19,2=22')
})

test('9. the confirmed option cannot be removed without unconfirming', { skip }, () => {
  expectError(() => asUser(A, `SELECT public.ksc_remove_draft_option('${q6Confirmed}')`), /KSC_OPTION_IS_CONFIRMED/)
  assert.equal(count(`SELECT count(*) FROM public.draft_options WHERE id='${q6Confirmed}'`), 1)
})

test('10. an option with a visual cannot be removed silently', { skip }, () => {
  const id = psql(`SELECT id FROM public.draft_options WHERE draft_question_id='${q.q6}' AND position=0`)
  const media = addMedia(paper, { option: id })
  expectError(() => asUser(A, `SELECT public.ksc_remove_draft_option('${id}')`), /KSC_OPTION_HAS_MEDIA/)
  assert.equal(count(`SELECT count(*) FROM public.draft_options WHERE id='${id}'`), 1)
  assert.equal(count(`SELECT count(*) FROM public.draft_media WHERE id='${media}'`), 1)
})

test('direct DELETE is no longer possible; other teachers and anon are refused', { skip }, () => {
  const id = psql(`SELECT id FROM public.draft_options WHERE draft_question_id='${q.q6}' AND position=1`)
  expectError(() => asUser(A, `DELETE FROM public.draft_options WHERE id='${id}'`), /permission denied/)
  expectError(() => asUser(B, `SELECT public.ksc_remove_draft_option('${id}')`), /not found or unauthorized/)
  expectError(() => asAnon(`SELECT public.ksc_remove_draft_option('${id}')`), /permission denied/)
  expectError(() => asUser(A, `SELECT count(*) FROM ksc_private.draft_option_repair_log`), /permission denied/)
})

test('teacher edits (update/insert) still work under the invariant', { skip }, () => {
  asUser(A, `UPDATE public.draft_options SET content='19 ' WHERE draft_question_id='${q.q6}' AND position=1`)
  addOption(q.q6, 3, '24')
  assert.equal(rowsOf(q.q6), '0=15,1=19 ,2=22,3=24')
})
