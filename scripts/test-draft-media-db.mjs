import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'

// P0-B2 behavioral checks of migrations 0017 + 0018 + 0019 against a THROWAWAY local
// PostgreSQL cluster in the OS temp dir (deleted afterwards). Never connects to
// Supabase; no auth.signUp. Minimal stubs stand in for KSC baseline objects.
// Skips if PostgreSQL binaries are unavailable (override with KSC_PG_BIN).

const PG_BIN = process.env.KSC_PG_BIN || 'C:/Program Files/PostgreSQL/16/bin'
const exe = name => path.join(PG_BIN, process.platform === 'win32' ? `${name}.exe` : name)
const HAVE_PG = fs.existsSync(exe('initdb')) && fs.existsSync(exe('pg_ctl')) && fs.existsSync(exe('psql'))
const MIG = n => path.resolve(`supabase/migrations/${n}`)

let dataDir, port
const psql = sql => execFileSync(exe('psql'), ['-h', 'localhost', '-p', String(port), '-U', 'postgres', '-d', 'postgres',
  '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const psqlFile = f => execFileSync(exe('psql'), ['-h', 'localhost', '-p', String(port), '-U', 'postgres', '-d', 'postgres',
  '-v', 'ON_ERROR_STOP=1', '-q', '-f', f], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const lastLine = out => out.split(/\r?\n/).filter(Boolean).pop() ?? ''
const asUser = (uid, sql) =>
  lastLine(psql(`SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', '${uid}', true); ${sql}`))
const asAnon = sql => lastLine(psql(`SET ROLE anon; ${sql}`))
function expectError(fn, pattern) {
  try { fn() } catch (e) { assert.match(String(e.stderr || e.message), pattern); return }
  assert.fail(`expected an error matching ${pattern}`)
}

const A = randomUUID(), B = randomUUID(), S = randomUUID()
const impA = randomUUID(), impA2 = randomUUID()
const mediaPath = (uid, paper, id) => `imports/${uid}/draft-media/${paper}/${id}.png`

function analysis() {
  const mat = randomUUID(), q9 = randomUUID(), q11 = randomUUID()
  const materials = [{ id: mat, material_type: 'TABLE', content_text: 'Directions', source_page_start: 2, source_page_end: 2 }]
  const questions = [
    { id: q9, position: 0, source_question_number: '9', content: 'Q9', shared_material_id: mat, source_page: 1 },
    { id: q11, position: 1, source_question_number: '11', content: 'Q11', source_page: 2 },
  ]
  const options = []
  for (const qid of [q9, q11]) for (let i = 0; i < 4; i++) {
    options.push({ id: randomUUID(), draft_question_id: qid, position: i, content: `opt${i}`, is_proposed_correct: i === 0 })
  }
  return { mat, q9, q11, materials, questions, options }
}
const replaceSql = (imp, a) =>
  `SELECT public.ksc_replace_draft_analysis('${imp}'::uuid, '{"title":"SI"}'::jsonb, '${JSON.stringify(a.materials)}'::jsonb, ` +
  `'${JSON.stringify(a.questions)}'::jsonb, '${JSON.stringify(a.options)}'::jsonb)`
const paperOf = imp => psql(`SELECT id FROM public.draft_papers WHERE source_import_id = '${imp}'`)
const optionId = (q, pos) => psql(`SELECT id FROM public.draft_options WHERE draft_question_id='${q}' AND position=${pos}`)

// Insert a draft_media row as `uid`. Returns "id|source_import_id".
function insertMedia(uid, { paper, question = null, option = null, material = null, kind = 'DIAGRAM', pathUid = uid,
  pathPaper = paper, storagePath = null, region = [0.1, 0.1, 0.3, 0.2], page = 2, pagePt = [595, 842] }) {
  const id = randomUUID()
  const sp = storagePath ?? mediaPath(pathUid, pathPaper, id)
  const q = v => (v === null ? 'NULL' : `'${v}'`)
  const r = region ? region.join(', ') : 'NULL, NULL, NULL, NULL'
  return asUser(uid, `WITH ins AS (INSERT INTO public.draft_media
      (id, draft_paper_id, draft_question_id, draft_option_id, draft_material_id, media_kind, storage_path,
       source_page, region_x, region_y, region_w, region_h, page_width_pt, page_height_pt, render_scale)
    VALUES ('${id}', ${q(paper)}, ${q(question)}, ${q(option)}, ${q(material)}, '${kind}', '${sp}',
       ${page ?? 'NULL'}, ${r}, ${pagePt ? pagePt.join(', ') : 'NULL, NULL'}, 2)
    RETURNING id, source_import_id) SELECT id || '|' || coalesce(source_import_id::text, 'NULL') FROM ins`)
}

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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ksc-b2-pg-'))
  port = 55000 + Math.floor(Math.random() * 900)
  execFileSync(exe('initdb'), ['-D', dataDir, '-U', 'postgres', '-A', 'trust', '-E', 'UTF8', '--no-locale'], { stdio: 'ignore' })
  execFileSync(exe('pg_ctl'), ['-D', dataDir, '-l', path.join(dataDir, 'server.log'),
    '-o', `-p ${port} -c listen_addresses=localhost`, '-w', 'start'], { stdio: 'ignore' })
  psql(STUBS)
  psql(`INSERT INTO auth.users VALUES ('${A}'), ('${B}'), ('${S}');
        INSERT INTO public.teacher_profiles VALUES ('${A}'), ('${B}');
        INSERT INTO public.test_imports (id, created_by) VALUES ('${impA}','${A}'), ('${impA2}','${A}');`)
})

after(() => {
  if (!HAVE_PG || !dataDir) return
  try { execFileSync(exe('pg_ctl'), ['-D', dataDir, '-m', 'immediate', '-w', 'stop'], { stdio: 'ignore' }) } catch {}
  try { fs.rmSync(dataDir, { recursive: true, force: true }) } catch {}
})

const skip = HAVE_PG ? false : 'PostgreSQL binaries not found (set KSC_PG_BIN)'
let a, paperA, a2, paperA2, qMediaId

test('0017 -> 0018 -> 0019 apply cleanly; 0019 is idempotent', { skip }, () => {
  psqlFile(MIG('202609220017_draft_paper_foundation.sql'))
  psqlFile(MIG('202609220018_draft_manual_questions.sql'))
  psqlFile(MIG('202609220019_draft_media.sql'))
  psqlFile(MIG('202609220019_draft_media.sql'))
  a = analysis(); asUser(A, replaceSql(impA, a)); paperA = paperOf(impA)
  a2 = analysis(); asUser(A, replaceSql(impA2, a2)); paperA2 = paperOf(impA2)
  assert.ok(paperA && paperA2)
})

test('9. media presence alone makes the Draft teacher work; Retry is refused', { skip }, () => {
  assert.equal(asUser(A, `SELECT public.ksc_draft_has_teacher_work('${paperA}')`), 'f', 'untouched before media')
  const out = insertMedia(A, { paper: paperA, question: a.q9 })
  qMediaId = out.split('|')[0]
  assert.equal(out.split('|')[1], impA, 'source import recorded from the paper')
  assert.equal(asUser(A, `SELECT public.ksc_draft_has_teacher_work('${paperA}')`), 't')
  expectError(() => asUser(A, replaceSql(impA, analysis())), /KSC_DRAFT_HAS_TEACHER_WORK/)
})

test('10. blocked Retry leaves Draft and media metadata intact', { skip }, () => {
  assert.equal(psql(`SELECT count(*) FROM public.draft_media WHERE id='${qMediaId}'`), '1')
  assert.equal(psql(`SELECT count(*) FROM public.draft_questions WHERE draft_paper_id='${paperA}'`), '2')
  assert.equal(psql(`SELECT draft_question_id FROM public.draft_media WHERE id='${qMediaId}'`), a.q9)
})

test('5. exactly one owner: question / option / material pass; none / multiple fail', { skip }, () => {
  insertMedia(A, { paper: paperA, option: optionId(a.q11, 1), kind: 'IMAGE' })
  insertMedia(A, { paper: paperA, material: a.mat, kind: 'TABLE' })
  expectError(() => insertMedia(A, { paper: paperA }), /draft_media_exactly_one_owner/)
  expectError(() => insertMedia(A, { paper: paperA, question: a.q9, option: optionId(a.q9, 0) }), /draft_media_exactly_one_owner/)
})

test('6. owner must belong to the same Draft paper', { skip }, () => {
  expectError(() => insertMedia(A, { paper: paperA, question: a2.q9 }), /same draft paper/)
  expectError(() => insertMedia(A, { paper: paperA2, option: optionId(a.q9, 0) }), /same draft paper/)
  expectError(() => insertMedia(A, { paper: paperA2, material: a.mat }), /same draft paper/)
})

test('4 (DB). storage path must be this teacher + this paper namespace, never a URL', { skip }, () => {
  expectError(() => insertMedia(A, { paper: paperA, question: a.q9, pathUid: B }), /row-level security/)
  expectError(() => insertMedia(A, { paper: paperA, question: a.q9, pathPaper: paperA2 }), /row-level security/)
  const url = 'https://x.supabase.co/storage/v1/object/sign/a.png?token=abc'
  // As the teacher, RLS rejects it first; with RLS bypassed the shape CHECK still rejects it.
  expectError(() => insertMedia(A, { paper: paperA, question: a.q9, storagePath: url }), /row-level security/)
  expectError(() => psql(`INSERT INTO public.draft_media (draft_paper_id, draft_question_id, media_kind, storage_path, source_page,
      region_x, region_y, region_w, region_h, page_width_pt, page_height_pt, created_by)
    VALUES ('${paperA}', '${a.q9}', 'DIAGRAM', '${url}', 2, 0.1, 0.1, 0.3, 0.2, 595, 842, '${A}')`), /draft_media_storage_path_shape/)
})

test('region and provenance contract enforced by the database', { skip }, () => {
  expectError(() => insertMedia(A, { paper: paperA, question: a.q9, region: [0.8, 0.1, 0.3, 0.2] }), /draft_media_region_valid/)
  expectError(() => insertMedia(A, { paper: paperA, question: a.q9, region: [0.1, 0.1, 0, 0.2] }), /draft_media_region_valid/)
  expectError(() => insertMedia(A, { paper: paperA, question: a.q9, region: null }), /draft_media_source_region_provenance/)
  expectError(() => insertMedia(A, { paper: paperA, question: a.q9, page: null }), /draft_media_source_region_provenance/)
})

test('11. TEXT_REGION is accepted; unknown kinds are rejected', { skip }, () => {
  insertMedia(A, { paper: paperA, question: a.q11, kind: 'TEXT_REGION' })
  expectError(() => insertMedia(A, { paper: paperA, question: a.q11, kind: 'VIDEO' }), /media_kind_check/)
})

test('13. option media does not alter answer correctness', { skip }, () => {
  const proposed = optionId(a.q9, 0)
  insertMedia(A, { paper: paperA, option: proposed, kind: 'IMAGE' })
  assert.equal(psql(`SELECT is_proposed_correct::text || '|' || is_confirmed_correct::text FROM public.draft_options WHERE id='${proposed}'`), 'true|false')
  assert.equal(psql(`SELECT teacher_review_status FROM public.draft_questions WHERE id='${a.q9}'`), 'UNREVIEWED')
})

test('7 + 8. teacher-owner scoped; students and anon have no access', { skip }, () => {
  assert.equal(asUser(B, `SELECT count(*) FROM public.draft_media WHERE draft_paper_id='${paperA}'`), '0')
  expectError(() => insertMedia(B, { paper: paperA, question: a.q9 }), /row-level security/)
  asUser(B, `DELETE FROM public.draft_media WHERE id='${qMediaId}'`) // RLS makes the row invisible to B
  assert.equal(psql(`SELECT count(*) FROM public.draft_media WHERE id='${qMediaId}'`), '1', 'other teacher could not delete')
  assert.equal(asUser(S, `SELECT count(*) FROM public.draft_media`), '0', 'student sees nothing')
  expectError(() => insertMedia(S, { paper: paperA, question: a.q9 }), /row-level security/)
  expectError(() => asAnon(`SELECT count(*) FROM public.draft_media`), /permission denied/)
})

test('deleting an owner cascades its media rows', { skip }, () => {
  const before = Number(psql(`SELECT count(*) FROM public.draft_media WHERE draft_question_id='${a.q11}'`))
  assert.ok(before > 0)
  psql(`DELETE FROM public.draft_questions WHERE id='${a.q11}'`)
  assert.equal(psql(`SELECT count(*) FROM public.draft_media WHERE draft_question_id='${a.q11}'`), '0')
})
