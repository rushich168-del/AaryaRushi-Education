import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'

// Migration 0022 (bilingual Draft language versions) against a THROWAWAY local PostgreSQL
// cluster (OS temp dir, deleted afterwards). Models the two golden slices: Q6 (numeric
// options) and Q1 (textual options). Never connects to Supabase; no auth.signUp.

const PG_BIN = process.env.KSC_PG_BIN || 'C:/Program Files/PostgreSQL/16/bin'
const exe = name => path.join(PG_BIN, process.platform === 'win32' ? `${name}.exe` : name)
const HAVE_PG = fs.existsSync(exe('initdb')) && fs.existsSync(exe('pg_ctl')) && fs.existsSync(exe('psql'))
const MIG = n => path.resolve(`supabase/migrations/${n}`)
const CHAIN = ['202609220017_draft_paper_foundation.sql', '202609220018_draft_manual_questions.sql',
  '202609220019_draft_media.sql', '202609220020_draft_option_conflict_resolution.sql',
  '202609220021_draft_option_uniqueness.sql']
const M22 = MIG('202609220022_draft_language_texts.sql')

let dataDir, port
const run = args => execFileSync(exe('psql'), ['-h', 'localhost', '-p', String(port), '-U', 'postgres', '-d', 'postgres',
  '-v', 'ON_ERROR_STOP=1', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PGCLIENTENCODING: 'UTF8' } })
// SQL goes through a UTF-8 file: Windows transcodes non-ASCII command-line arguments to
// the ANSI code page, which corrupts Telugu and breaks a UTF-8 database.
const psql = sql => {
  const tmp = path.join(dataDir, `q_${randomUUID()}.sql`)
  fs.writeFileSync(tmp, sql, 'utf8')
  try { return run(['-At', '-f', tmp]).trim() } finally { fs.rmSync(tmp, { force: true }) }
}
const psqlFile = f => run(['-q', '-f', f])
const lastLine = out => out.split(/\r?\n/).filter(Boolean).pop() ?? ''
// Session-scoped (not transaction-scoped): with file input each statement commits separately.
const asUser = (uid, sql) =>
  lastLine(psql(`SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', '${uid}', false); ${sql}`))
const asAnon = sql => lastLine(psql(`SET ROLE anon; ${sql}`))
function expectError(fn, pattern) {
  try { fn() } catch (e) { assert.match(String(e.stderr || e.message), pattern); return }
  assert.fail(`expected an error matching ${pattern}`)
}

const A = randomUUID(), B = randomUUID(), S = randomUUID()
const imp = randomUUID(), impOther = randomUUID(), impFresh = randomUUID()
const Q6 = randomUUID(), Q1 = randomUUID(), QOTHER = randomUUID(), QFRESH = randomUUID()
let freshPaper
let paper, otherPaper, q6Diagram, q6DiagramBefore, q6Options = [], q1Options = [], q6TextRegion, otherTextRegion

const addOption = (qid, position, content) =>
  asUser(A, `WITH ins AS (INSERT INTO public.draft_options (draft_question_id, position, content, origin)
    VALUES ('${qid}', ${position}, '${content}', 'TEACHER') RETURNING id) SELECT id FROM ins`)
const addMedia = (paperId, { question = null, option = null, kind = 'DIAGRAM' }) => {
  const id = randomUUID(); const qv = v => (v ? `'${v}'` : 'NULL')
  return asUser(A, `WITH ins AS (INSERT INTO public.draft_media (id, draft_paper_id, draft_question_id, draft_option_id,
      media_kind, storage_path, source_page, region_x, region_y, region_w, region_h, page_width_pt, page_height_pt, render_scale)
    VALUES ('${id}', '${paperId}', ${qv(question)}, ${qv(option)}, '${kind}', 'imports/${A}/draft-media/${paperId}/${id}.png', 2,
      0.1, 0.1, 0.3, 0.2, 595, 842, 2) RETURNING id) SELECT id FROM ins`)
}
const upsertQText = (uid, qid, lang, content, quality, media = null) =>
  asUser(uid, `WITH up AS (INSERT INTO public.draft_question_texts (draft_question_id, language, content, text_quality, source, source_media_id)
    VALUES ('${qid}', '${lang}', ${content === null ? 'NULL' : `'${content}'`}, '${quality}', 'TEACHER', ${media ? `'${media}'` : 'NULL'})
    ON CONFLICT (draft_question_id, language) DO UPDATE SET content=EXCLUDED.content, text_quality=EXCLUDED.text_quality,
      source_media_id=EXCLUDED.source_media_id RETURNING id) SELECT id FROM up`)
const upsertOText = (uid, oid, lang, content, quality, media = null) =>
  asUser(uid, `WITH up AS (INSERT INTO public.draft_option_texts (draft_option_id, language, content, text_quality, source, source_media_id)
    VALUES ('${oid}', '${lang}', ${content === null ? 'NULL' : `'${content}'`}, '${quality}', 'TEACHER', ${media ? `'${media}'` : 'NULL'})
    ON CONFLICT (draft_option_id, language) DO UPDATE SET content=EXCLUDED.content, text_quality=EXCLUDED.text_quality,
      source_media_id=EXCLUDED.source_media_id RETURNING id) SELECT id FROM up`)
const count = sql => Number(psql(sql))
const PUA = '\\uF06E\\uF071\\uF054'   // real private-use Telugu bytes from the probe

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

before(() => {
  if (!HAVE_PG) return
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ksc-b3-pg-'))
  port = 55000 + Math.floor(Math.random() * 900)
  execFileSync(exe('initdb'), ['-D', dataDir, '-U', 'postgres', '-A', 'trust', '-E', 'UTF8', '--no-locale'], { stdio: 'ignore' })
  execFileSync(exe('pg_ctl'), ['-D', dataDir, '-l', path.join(dataDir, 'server.log'),
    '-o', `-p ${port} -c listen_addresses=localhost`, '-w', 'start'], { stdio: 'ignore' })
  psql(STUBS)
  psql(`INSERT INTO auth.users VALUES ('${A}'), ('${B}'), ('${S}');
        INSERT INTO public.teacher_profiles VALUES ('${A}'), ('${B}');
        INSERT INTO public.test_imports (id, created_by) VALUES ('${imp}','${A}'), ('${impOther}','${A}'), ('${impFresh}','${A}');`)
  for (const f of CHAIN) psqlFile(MIG(f))

  const qs = [
    { id: Q6, position: 0, source_question_number: '6', content: 'Count the number of triangles in the figure given below.', source_page: 2 },
    { id: Q1, position: 1, source_question_number: '1', content: 'How many meaning ful English words can be formed with the letters LEGU…', source_page: 2 },
  ]
  asUser(A, `SELECT public.ksc_replace_draft_analysis('${imp}', '{}'::jsonb, '[]'::jsonb, '${JSON.stringify(qs)}'::jsonb, '[]'::jsonb)`)
  paper = psql(`SELECT id FROM public.draft_papers WHERE source_import_id='${imp}'`)
  asUser(A, `SELECT public.ksc_replace_draft_analysis('${impOther}', '{}'::jsonb, '[]'::jsonb,
    '${JSON.stringify([{ id: QOTHER, position: 0, source_question_number: '9', content: 'Other paper', source_page: 1 }])}'::jsonb, '[]'::jsonb)`)
  otherPaper = psql(`SELECT id FROM public.draft_papers WHERE source_import_id='${impOther}'`)
  // A paper with NO media and NO edits, so language work alone can be shown to block Retry.
  asUser(A, `SELECT public.ksc_replace_draft_analysis('${impFresh}', '{}'::jsonb, '[]'::jsonb,
    '${JSON.stringify([{ id: QFRESH, position: 0, source_question_number: '3', content: 'Fresh paper question', source_page: 1 }])}'::jsonb, '[]'::jsonb)`)
  freshPaper = psql(`SELECT id FROM public.draft_papers WHERE source_import_id='${impFresh}'`)

  q6Options = ['15', '19', '22', '24'].map((v, i) => addOption(Q6, i, v))
  q1Options = ['None', 'One', 'Two', 'Three'].map((v, i) => addOption(Q1, i, v))
  q6Diagram = addMedia(paper, { question: Q6, kind: 'DIAGRAM' })
  q6DiagramBefore = psql(`SELECT to_jsonb(m)::text FROM public.draft_media m WHERE id='${q6Diagram}'`)
  q6TextRegion = addMedia(paper, { question: Q6, kind: 'TEXT_REGION' })
  otherTextRegion = addMedia(otherPaper, { question: QOTHER, kind: 'TEXT_REGION' })
  // The confirmed answer for Q6 is set BEFORE any language work, and must never move.
  asUser(A, `SELECT public.ksc_confirm_draft_single_choice('${Q6}', '${q6Options[1]}')`)
})

after(() => {
  if (!HAVE_PG || !dataDir) return
  try { execFileSync(exe('pg_ctl'), ['-D', dataDir, '-m', 'immediate', '-w', 'stop'], { stdio: 'ignore' }) } catch {}
  try { fs.rmSync(dataDir, { recursive: true, force: true }) } catch {}
})

const skip = HAVE_PG ? false : 'PostgreSQL binaries not found (set KSC_PG_BIN)'

test('0022 applies on top of 0017-0021 and is idempotent; 0021 uniqueness stays active', { skip }, () => {
  psqlFile(M22)
  psqlFile(M22)
  assert.equal(count(`SELECT count(*) FROM pg_constraint WHERE conname='draft_options_one_row_per_position'`), 1)
  expectError(() => addOption(Q6, 0, '15'), /draft_options_one_row_per_position/)
})

test('one question + two language versions is still ONE question', { skip }, () => {
  upsertQText(A, Q1, 'en', 'How many meaning ful English words…', 'VALID_UNICODE')
  upsertQText(A, Q1, 'te', 'తెలుగు ప్రశ్న', 'TEACHER_ENTERED')
  assert.equal(count(`SELECT count(*) FROM public.draft_questions WHERE id='${Q1}'`), 1)
  assert.equal(count(`SELECT count(*) FROM public.draft_question_texts WHERE draft_question_id='${Q1}'`), 2)
  expectError(() => upsertQText(A, Q1, 'te', 'x', 'TEACHER_ENTERED') && psql(
    `INSERT INTO public.draft_question_texts (draft_question_id, language, content, text_quality, created_by)
     VALUES ('${Q1}','te','dup','TEACHER_ENTERED','${A}')`), /draft_question_texts_one_per_language/)
})

test('four bilingual options remain exactly four draft_options', { skip }, () => {
  ;['తెలుగు ఏదీ కాదు', 'ఒకటి', 'రెండు', 'మూడు'].forEach((te, i) => upsertOText(A, q1Options[i], 'te', te, 'TEACHER_ENTERED'))
  assert.equal(count(`SELECT count(*) FROM public.draft_options WHERE draft_question_id='${Q1}'`), 4)
  assert.equal(count(`SELECT count(*) FROM public.draft_option_texts t JOIN public.draft_options o ON o.id=t.draft_option_id
    WHERE o.draft_question_id='${Q1}'`), 4)
  assert.equal(psql(`SELECT string_agg(position::text, ',' ORDER BY position) FROM public.draft_options WHERE draft_question_id='${Q1}'`), '0,1,2,3')
})

test('Q6 numeric options work as script-neutral without Telugu text', { skip }, () => {
  q6Options.forEach(o => upsertOText(A, o, 'te', null, 'SCRIPT_NEUTRAL'))
  assert.equal(count(`SELECT count(*) FROM public.draft_options WHERE draft_question_id='${Q6}'`), 4)
  assert.equal(count(`SELECT count(*) FROM public.draft_option_texts t JOIN public.draft_options o ON o.id=t.draft_option_id
    WHERE o.draft_question_id='${Q6}' AND t.text_quality='SCRIPT_NEUTRAL' AND t.content IS NULL`), 4)
})

test('legacy U+F0xx text is never persisted as Telugu semantic content', { skip }, () => {
  // The workflow stores UNRELIABLE + the source region, with NO text.
  upsertQText(A, Q6, 'te', null, 'UNRELIABLE', q6TextRegion)
  assert.equal(psql(`SELECT coalesce(content,'<null>') || '|' || text_quality FROM public.draft_question_texts
    WHERE draft_question_id='${Q6}' AND language='te'`), '<null>|UNRELIABLE')
  assert.equal(count(`SELECT count(*) FROM public.draft_question_texts WHERE content ~ '[\\uE000-\\uF8FF]'`), 0,
    'no private-use glyphs anywhere in language content')
  // Then the teacher types the real Telugu, keeping the same source region.
  upsertQText(A, Q6, 'te', 'త్రిభుజాల సంఖ్యను లెక్కించండి', 'TEACHER_ENTERED', q6TextRegion)
  assert.equal(psql(`SELECT text_quality FROM public.draft_question_texts WHERE draft_question_id='${Q6}' AND language='te'`), 'TEACHER_ENTERED')
})

test('a linked source region must be a TEXT_REGION in the same question context', { skip }, () => {
  expectError(() => upsertQText(A, Q6, 'te', 'x', 'TEACHER_ENTERED', q6Diagram), /KSC_TEXT_SOURCE_NOT_TEXT_REGION/)
  expectError(() => upsertQText(A, Q6, 'te', 'x', 'TEACHER_ENTERED', otherTextRegion), /KSC_TEXT_SOURCE_WRONG_CONTEXT/)
  expectError(() => upsertOText(A, q1Options[0], 'te', 'x', 'TEACHER_ENTERED', q6TextRegion), /KSC_TEXT_SOURCE_WRONG_CONTEXT/)
  // One question-level crop may back the stem AND its own options.
  const q1Region = addMedia(paper, { question: Q1, kind: 'TEXT_REGION' })
  upsertOText(A, q1Options[0], 'te', 'తెలుగు ఏదీ కాదు', 'TEACHER_ENTERED', q1Region)
  assert.equal(psql(`SELECT source_media_id FROM public.draft_option_texts WHERE draft_option_id='${q1Options[0]}'`), q1Region)
})

test('language editing never changes proposed/confirmed answer state', { skip }, () => {
  assert.equal(psql(`SELECT string_agg(is_confirmed_correct::text, ',' ORDER BY position) FROM public.draft_options WHERE draft_question_id='${Q6}'`),
    'false,true,false,false', 'the confirmed answer is still option 2')
  assert.equal(count(`SELECT count(*) FROM public.draft_options WHERE draft_question_id='${Q6}' AND is_proposed_correct`), 0)
  assert.equal(psql(`SELECT to_jsonb(m)::text FROM public.draft_media m WHERE id='${q6Diagram}'`), q6DiagramBefore, 'B2 diagram intact')
})

test('teacher language work blocks Retry', { skip }, () => {
  assert.equal(asUser(A, `SELECT public.ksc_draft_has_teacher_work('${freshPaper}')`), 'f', 'clean paper: no teacher work yet')
  upsertQText(A, QFRESH, 'te', 'తెలుగు', 'TEACHER_ENTERED')
  assert.equal(asUser(A, `SELECT public.ksc_draft_has_teacher_work('${freshPaper}')`), 't', 'language work alone counts')
  expectError(() => asUser(A, `SELECT public.ksc_replace_draft_analysis('${impFresh}', '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb)`),
    /KSC_DRAFT_HAS_TEACHER_WORK/)
  assert.equal(count(`SELECT count(*) FROM public.draft_question_texts WHERE draft_question_id='${QFRESH}'`), 1, 'nothing deleted')
})

test('reload (F5) returns the same Telugu text and source region', { skip }, () => {
  assert.equal(psql(`SELECT content || '|' || text_quality || '|' || (source_media_id='${q6TextRegion}')::text
    FROM public.draft_question_texts WHERE draft_question_id='${Q6}' AND language='te'`),
  'త్రిభుజాల సంఖ్యను లెక్కించండి|TEACHER_ENTERED|true')
})

test('security: other teachers, students and anon have no access', { skip }, () => {
  assert.equal(asUser(B, `SELECT count(*) FROM public.draft_question_texts`), '0')
  assert.equal(asUser(S, `SELECT count(*) FROM public.draft_option_texts`), '0')
  expectError(() => upsertQText(B, Q6, 'te', 'hack', 'TEACHER_ENTERED'), /row-level security/)
  expectError(() => asAnon(`SELECT count(*) FROM public.draft_question_texts`), /permission denied/)
})

test('B3 repair: pasted Telugu Unicode survives save/reload with its code points intact', { skip }, () => {
  const telugu = 'ఎన్ని అర్థవంతమైన ఆంగ్ల పదాలు'
  upsertQText(A, Q1, 'te', telugu, 'TEACHER_ENTERED')
  const back = psql(`SELECT content FROM public.draft_question_texts WHERE draft_question_id='${Q1}' AND language='te'`)
  assert.equal(back, telugu, 'round-trips byte-for-byte')
  assert.ok([...back].every(ch => { const cp = ch.codePointAt(0); return (cp >= 0x0C00 && cp <= 0x0C7F) || cp === 0x20 }),
    'every character is still a Telugu code point')
  // Nothing anywhere carries the PDF's unrenderable glyphs.
  assert.equal(count(`SELECT count(*) FROM public.draft_question_texts WHERE content ~ '[\\uE000-\\uF8FF\\uFFFD]'`), 0)
  assert.equal(count(`SELECT count(*) FROM public.draft_option_texts WHERE content ~ '[\\uE000-\\uF8FF\\uFFFD]'`), 0)
})

test('B3 repair: script-neutral is reversible without disturbing the option, answer or region', { skip }, () => {
  const before = {
    options: count(`SELECT count(*) FROM public.draft_options WHERE draft_question_id='${Q6}'`),
    flags: psql(`SELECT string_agg(is_confirmed_correct::text || '/' || is_proposed_correct::text, ',' ORDER BY position)
                 FROM public.draft_options WHERE draft_question_id='${Q6}'`),
    region: psql(`SELECT source_media_id FROM public.draft_question_texts WHERE draft_question_id='${Q6}' AND language='te'`),
    diagram: psql(`SELECT to_jsonb(m)::text FROM public.draft_media m WHERE id='${q6Diagram}'`),
  }
  const opt = q6Options[0]
  assert.equal(psql(`SELECT text_quality FROM public.draft_option_texts WHERE draft_option_id='${opt}'`), 'SCRIPT_NEUTRAL')

  // "Enter Telugu instead": back to editable, then the teacher types Telugu.
  upsertOText(A, opt, 'te', null, 'MISSING')
  assert.equal(psql(`SELECT text_quality || '|' || coalesce(content,'<null>') FROM public.draft_option_texts WHERE draft_option_id='${opt}'`), 'MISSING|<null>')
  upsertOText(A, opt, 'te', 'పదిహేను', 'TEACHER_ENTERED')
  assert.equal(psql(`SELECT text_quality || '|' || content FROM public.draft_option_texts WHERE draft_option_id='${opt}'`), 'TEACHER_ENTERED|పదిహేను')

  assert.equal(count(`SELECT count(*) FROM public.draft_options WHERE draft_question_id='${Q6}'`), before.options, 'still four logical options')
  assert.equal(count(`SELECT count(*) FROM public.draft_option_texts WHERE draft_option_id='${opt}'`), 1, 'one Telugu row, not a second option')
  assert.equal(psql(`SELECT string_agg(is_confirmed_correct::text || '/' || is_proposed_correct::text, ',' ORDER BY position)
                     FROM public.draft_options WHERE draft_question_id='${Q6}'`), before.flags, 'answer/proposed flags unchanged')
  assert.equal(psql(`SELECT source_media_id FROM public.draft_question_texts WHERE draft_question_id='${Q6}' AND language='te'`), before.region, 'TEXT_REGION still attached')
  assert.equal(psql(`SELECT to_jsonb(m)::text FROM public.draft_media m WHERE id='${q6Diagram}'`), before.diagram, 'Q6 diagram unaffected')
  assert.equal(count(`SELECT count(*) FROM pg_constraint WHERE conname='draft_options_one_row_per_position'`), 1)
})

test('0022 touches no exam-engine / question-bank / student objects', { skip }, () => {
  const code = fs.readFileSync(M22, 'utf8').replace(/--.*$/gm, '')
  for (const forbidden of ['publish_test', 'test_attempts', 'attempt_answers', 'test_question_snapshots', 'test_option_snapshots',
    'public.questions', 'public.question_options', 'question_answer_keys', 'ksc_replace_test_import_analysis',
    'test_import_candidates', 'storage.', 'ALTER TABLE public.draft_options', 'ALTER TABLE public.draft_questions']) {
    assert.ok(!code.includes(forbidden), `must not touch ${forbidden}`)
  }
})
