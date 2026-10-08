import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'

// Migration 0020 (explicit option-slot conflict resolution) + 0021 (uniqueness) against a
// THROWAWAY local PostgreSQL cluster (OS temp dir, deleted afterwards). Reproduces the LIVE
// Q6 state: per slot an older row cleared to blank + a row with the intended value, all
// origin EXTRACTED, plus a question-owned DIAGRAM. Never connects to Supabase; no signUp.

const PG_BIN = process.env.KSC_PG_BIN || 'C:/Program Files/PostgreSQL/16/bin'
const exe = name => path.join(PG_BIN, process.platform === 'win32' ? `${name}.exe` : name)
const HAVE_PG = fs.existsSync(exe('initdb')) && fs.existsSync(exe('pg_ctl')) && fs.existsSync(exe('psql'))
const MIG = n => path.resolve(`supabase/migrations/${n}`)
const M20 = MIG('202609220020_draft_option_conflict_resolution.sql')
const M21 = MIG('202609220021_draft_option_uniqueness.sql')

let dataDir, port
const run = args => execFileSync(exe('psql'), ['-h', 'localhost', '-p', String(port), '-U', 'postgres', '-d', 'postgres',
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
const Q = { q6: randomUUID(), qConf: randomUUID(), qProp: randomUUID(), qVis: randomUUID(), qVis2: randomUUID() }
let paper

const addOption = (qid, position, content, extra = '') =>
  psql(`WITH ins AS (INSERT INTO public.draft_options (draft_question_id, position, content, origin${extra ? ', ' + extra.split('=')[0] : ''})
    VALUES ('${qid}', ${position}, '${content}', 'EXTRACTED'${extra ? ', ' + extra.split('=')[1] : ''}) RETURNING id) SELECT id FROM ins`)
const addMedia = ({ question = null, option = null, kind = 'DIAGRAM', page = 2 }) => {
  const id = randomUUID()
  const qv = v => (v ? `'${v}'` : 'NULL')
  return asUser(A, `WITH ins AS (INSERT INTO public.draft_media (id, draft_paper_id, draft_question_id, draft_option_id,
      media_kind, storage_path, source_page, region_x, region_y, region_w, region_h, page_width_pt, page_height_pt, render_scale)
    VALUES ('${id}', '${paper}', ${qv(question)}, ${qv(option)}, '${kind}', 'imports/${A}/draft-media/${paper}/${id}.png', ${page},
      0.1, 0.1, 0.3, 0.2, 595, 842, 2) RETURNING id) SELECT id FROM ins`)
}
const idsAt = (qid, pos) => psql(`SELECT string_agg(id::text, ',' ORDER BY created_at, id) FROM public.draft_options WHERE draft_question_id='${qid}' AND position=${pos}`).split(',')
const resolve = (uid, qid, pos, keep, expected, move = false) =>
  asUser(uid, `SELECT public.ksc_resolve_option_slot_conflict('${qid}', ${pos}, '${keep}', ARRAY[${expected.map(x => `'${x}'`).join(',')}]::uuid[], ${move})`)
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

let q6DiagramBefore, q6Diagram
before(() => {
  if (!HAVE_PG) return
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ksc-conflict-pg-'))
  port = 55000 + Math.floor(Math.random() * 900)
  execFileSync(exe('initdb'), ['-D', dataDir, '-U', 'postgres', '-A', 'trust', '-E', 'UTF8', '--no-locale'], { stdio: 'ignore' })
  execFileSync(exe('pg_ctl'), ['-D', dataDir, '-l', path.join(dataDir, 'server.log'),
    '-o', `-p ${port} -c listen_addresses=localhost`, '-w', 'start'], { stdio: 'ignore' })
  psql(STUBS)
  psql(`INSERT INTO auth.users VALUES ('${A}'), ('${B}'); INSERT INTO public.teacher_profiles VALUES ('${A}'), ('${B}');
        INSERT INTO public.test_imports (id, created_by) VALUES ('${imp}', '${A}');`)
  for (const f of ['202609220017_draft_paper_foundation.sql', '202609220018_draft_manual_questions.sql', '202609220019_draft_media.sql']) psqlFile(MIG(f))
  const questions = Object.entries(Q).map(([num, id], i) => ({ id, position: i, source_question_number: num, content: `Question ${num}`, source_page: 2 }))
  asUser(A, `SELECT public.ksc_replace_draft_analysis('${imp}', '{}'::jsonb, '[]'::jsonb, '${JSON.stringify(questions)}'::jsonb, '[]'::jsonb)`)
  paper = psql(`SELECT id FROM public.draft_papers WHERE source_import_id='${imp}'`)

  // LIVE Q6 shape: per slot an older row (later cleared to blank) + the intended value row.
  const values = ['15', '19', '22', '24']
  const older = values.map((v, i) => addOption(Q.q6, i, v))
  values.forEach((v, i) => addOption(Q.q6, i, v))
  psql(`UPDATE public.draft_options SET content = '' WHERE id IN (${older.map(x => `'${x}'`).join(',')})`) // edited_after_insert = true
  q6Diagram = addMedia({ question: Q.q6, kind: 'DIAGRAM', page: 2 })
  q6DiagramBefore = psql(`SELECT to_jsonb(m)::text FROM public.draft_media m WHERE id='${q6Diagram}'`)
})

after(() => {
  if (!HAVE_PG || !dataDir) return
  try { execFileSync(exe('pg_ctl'), ['-D', dataDir, '-m', 'immediate', '-w', 'stop'], { stdio: 'ignore' }) } catch {}
  try { fs.rmSync(dataDir, { recursive: true, force: true }) } catch {}
})

const skip = HAVE_PG ? false : 'PostgreSQL binaries not found (set KSC_PG_BIN)'

test('reproduced live Q6: per slot [blank (edited), value], all EXTRACTED; diagram is question-owned', { skip }, () => {
  assert.equal(rowsOf(Q.q6), '0=,0=15,1=,1=19,2=,2=22,3=,3=24')
  assert.equal(count(`SELECT count(*) FROM public.draft_options WHERE draft_question_id='${Q.q6}' AND origin <> 'EXTRACTED'`), 0)
  assert.equal(count(`SELECT count(*) FROM public.draft_options WHERE draft_question_id='${Q.q6}' AND content='' AND updated_at > created_at`), 4)
  assert.equal(psql(`SELECT coalesce(draft_option_id::text,'NULL') || '|' || media_kind || '|' || source_page FROM public.draft_media WHERE id='${q6Diagram}'`), 'NULL|DIAGRAM|2')
})

test('0020 applies cleanly while conflicts exist, adds no constraint, and is idempotent', { skip }, () => {
  psqlFile(M20)
  psqlFile(M20)
  assert.equal(hasConstraint(), false)
  assert.equal(count(`SELECT count(*) FROM public.draft_options WHERE draft_question_id='${Q.q6}'`), 8, '0020 changed no data')
})

test('0021 refuses while unresolved conflicts exist — nothing is chosen automatically', { skip }, () => {
  expectError(() => psqlFile(M21), /KSC_UNSAFE_DUPLICATE_OPTIONS[\s\S]*content differs/)
  assert.equal(hasConstraint(), false)
  assert.equal(rowsOf(Q.q6), '0=,0=15,1=,1=19,2=,2=22,3=,3=24')
})

test('2. no automatic choice: stale / missing expected rows or a foreign keep id are refused', { skip }, () => {
  const [blank, value] = idsAt(Q.q6, 0)
  expectError(() => resolve(A, Q.q6, 0, value, [value]), /KSC_CONFLICT_CHANGED/)
  expectError(() => resolve(A, Q.q6, 0, value, [blank, value, randomUUID()]), /KSC_CONFLICT_CHANGED/)
  expectError(() => resolve(A, Q.q6, 0, randomUUID(), [blank, value]), /KSC_CONFLICT_CHANGED/)
  assert.equal(count(`SELECT count(*) FROM public.draft_options WHERE draft_question_id='${Q.q6}'`), 8)
})

test('ordinary removal is refused on a conflicting slot', { skip }, () => {
  const [blank] = idsAt(Q.q6, 1)
  expectError(() => asUser(A, `SELECT public.ksc_remove_draft_option('${blank}')`), /KSC_OPTION_SLOT_CONFLICT/)
})

test('3. confirmed state is never silently lost', { skip }, () => {
  const a = addOption(Q.qConf, 0, 'x'); const b = addOption(Q.qConf, 0, 'y')
  psql(`UPDATE public.draft_options SET is_confirmed_correct = true WHERE id='${a}'`)
  expectError(() => resolve(A, Q.qConf, 0, b, [a, b]), /KSC_CONFLICT_CONFIRMED_ON_DISCARDED_ROW/)
  assert.equal(count(`SELECT count(*) FROM public.draft_options WHERE draft_question_id='${Q.qConf}'`), 2, 'refusal changed nothing')
  resolve(A, Q.qConf, 0, a, [a, b])
  assert.equal(psql(`SELECT content || '|' || is_confirmed_correct FROM public.draft_options WHERE draft_question_id='${Q.qConf}'`), 'x|true')
})

test('4. proposed state is preserved intentionally (moved to the kept row, with a warning)', { skip }, () => {
  const p = addOption(Q.qProp, 0, ''); const v = addOption(Q.qProp, 0, '15')
  psql(`UPDATE public.draft_options SET is_proposed_correct = true WHERE id='${p}'`)
  const out = JSON.parse(resolve(A, Q.qProp, 0, v, [p, v]))
  assert.equal(out.proposed_moved, true)
  assert.equal(psql(`SELECT is_proposed_correct FROM public.draft_options WHERE id='${v}'`), 't')
  assert.equal(psql(`SELECT warnings ? 'PROPOSED_FLAG_MOVED_FROM_RESOLVED_DUPLICATE' FROM public.draft_options WHERE id='${v}'`), 't')
})

test('5. option media is never silently lost', { skip }, () => {
  const m = addOption(Q.qVis, 0, ''); const v = addOption(Q.qVis, 0, '15')
  const media = addMedia({ option: m, kind: 'IMAGE' })
  expectError(() => resolve(A, Q.qVis, 0, v, [m, v]), /KSC_CONFLICT_VISUAL_ON_DISCARDED_ROW/)
  const out = JSON.parse(resolve(A, Q.qVis, 0, v, [m, v], true))
  assert.equal(out.moved_visuals, 1)
  assert.equal(psql(`SELECT draft_option_id FROM public.draft_media WHERE id='${media}'`), v, 'visual moved to the kept option')
  // Visuals on both competing rows -> refused.
  const x = addOption(Q.qVis2, 0, 'a'); const y = addOption(Q.qVis2, 0, 'a')
  addMedia({ option: x, kind: 'IMAGE' }); const my = addMedia({ option: y, kind: 'IMAGE' })
  expectError(() => resolve(A, Q.qVis2, 0, x, [x, y], true), /KSC_CONFLICT_VISUAL_ON_BOTH_ROWS/)
  psql(`DELETE FROM public.draft_media WHERE id='${my}'`) // teacher removes one visual first
  resolve(A, Q.qVis2, 0, x, [x, y])
  assert.equal(count(`SELECT count(*) FROM public.draft_options WHERE draft_question_id='${Q.qVis2}'`), 1)
})

test('1 + 7 + 8. teacher explicitly keeps 15/19/22/24 -> exactly four rows with those values', { skip }, () => {
  for (let pos = 0; pos < 4; pos++) {
    const [blank, value] = idsAt(Q.q6, pos)
    const out = JSON.parse(resolve(A, Q.q6, pos, value, [blank, value]))
    assert.equal(out.removed, 1)
  }
  assert.equal(rowsOf(Q.q6), '0=15,1=19,2=22,3=24')
  assert.equal(count(`SELECT count(*) FROM ksc_private.draft_option_repair_log
    WHERE draft_question_id='${Q.q6}' AND rule='TEACHER_RESOLVED_CONFLICT' AND resolved_by='${A}' AND removed_option->>'content' = ''`), 4,
  'each discarded blank row logged in full with the resolving teacher')
})

test('6. the question-owned triangle diagram is completely untouched', { skip }, () => {
  assert.equal(psql(`SELECT to_jsonb(m)::text FROM public.draft_media m WHERE id='${q6Diagram}'`), q6DiagramBefore)
})

test('11. re-reading (F5) returns the same resolved state; a resolved slot is no longer a conflict', { skip }, () => {
  assert.equal(rowsOf(Q.q6), '0=15,1=19,2=22,3=24')
  const [only] = idsAt(Q.q6, 0)
  expectError(() => resolve(A, Q.q6, 0, only, [only]), /KSC_NO_CONFLICT_AT_SLOT/)
})

test('security: other teachers and anon cannot resolve', { skip }, () => {
  const a = addOption(Q.qConf, 1, 'k'); const b = addOption(Q.qConf, 1, 'k')
  expectError(() => resolve(B, Q.qConf, 1, a, [a, b]), /not found or unauthorized/)
  expectError(() => asAnon(`SELECT public.ksc_resolve_option_slot_conflict('${Q.qConf}', 1, '${a}', ARRAY['${a}','${b}']::uuid[], false)`), /permission denied/)
  resolve(A, Q.qConf, 1, a, [a, b]) // owner resolves it
})

test('9. with every conflict resolved, 0021 creates the uniqueness constraint', { skip }, () => {
  psqlFile(M21)
  assert.equal(hasConstraint(), true)
  expectError(() => addOption(Q.q6, 0, '15'), /draft_options_one_row_per_position/)
  assert.equal(rowsOf(Q.q6), '0=15,1=19,2=22,3=24', '0021 changed nothing further')
  assert.equal(psql(`SELECT to_jsonb(m)::text FROM public.draft_media m WHERE id='${q6Diagram}'`), q6DiagramBefore)
})
