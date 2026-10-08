// EXPERIMENT COPY of scripts/b4-persist-local.mjs with --b44 <file> and --out <dir> (B4.4R-H routing test).
// Persist the complete automatic Draft into a THROWAWAY local PostgreSQL, then dump it.
//
// Runs the real writers in pipeline order against migrations 0017-0027:
//   writer v3 (B4.2R: stems, options, shared materials, links)
//   -> B4.3 question visuals (0024) -> B4.3 material figures + material Telugu crops (0026)
//   -> B4.4 Telugu language versions (0025) -> B4.5 review items from the persisted Draft (0027)
// then reads the persisted Draft back (questions, options, language rows, media, materials, review
// items, derived readiness) and writes reports/b4-preview/draft-dump.json + a storage-path ->
// local-crop map. The cluster is
// deleted afterwards. Never connects to Supabase; no auth.signUp; storage is an in-memory double.
//
// Usage: node scripts/b4-persist-local.mjs   (needs reports/b41, b43, b44 from the pipeline)

import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import { mapPaperModelToDraft, B4_ENGINE, B4_ENGINE_VERSION } from '../lib/paper-model-to-draft.mjs'
import { persistAutoVisuals } from '../lib/auto-visual-persistence.mjs'
import { persistAutoMaterialMedia } from '../lib/auto-material-persistence.mjs'
import { persistAutoTelugu } from '../lib/auto-telugu-persistence.mjs'
const argv = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d }
import { buildReviewItems, REVIEW_GENERATOR, REVIEW_GENERATOR_VERSION } from '../lib/review-items.mjs'

const PG_BIN = process.env.KSC_PG_BIN || 'C:/Program Files/PostgreSQL/16/bin'
const exe = n => path.join(PG_BIN, process.platform === 'win32' ? `${n}.exe` : n)
const OUT_DIR = argv('out', 'reports/ocr-bench/persist-baseline')
const MIGRATIONS = ['202609220017_draft_paper_foundation.sql', '202609220018_draft_manual_questions.sql',
  '202609220019_draft_media.sql', '202609220020_draft_option_conflict_resolution.sql',
  '202609220021_draft_option_uniqueness.sql', '202609220022_draft_language_texts.sql',
  '202609230023_draft_analysis_automation.sql', '202609230024_draft_auto_visuals.sql',
  '202609230025_draft_auto_telugu_ocr.sql', '202609230026_draft_shared_materials.sql', '202609230027_draft_review_items.sql']

const read = f => JSON.parse(fs.readFileSync(f, 'utf8'))
const model = read('reports/b41-paper-model.json')
const b43 = read('reports/b43/b43-manifest.json')
const b44 = read(argv('b44', 'reports/b44/b44-benchmark.json'))

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ksc-b42r-pg-'))
const port = 56000 + Math.floor(Math.random() * 900)
const run = args => execFileSync(exe('psql'), ['-h', 'localhost', '-p', String(port), '-U', 'postgres', '-d', 'postgres',
  '-v', 'ON_ERROR_STOP=1', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PGCLIENTENCODING: 'UTF8' }, maxBuffer: 256 * 1024 * 1024 })
const psql = sql => {
  const tmp = path.join(dataDir, `q_${randomUUID()}.sql`)
  fs.writeFileSync(tmp, sql, 'utf8')
  try { return run(['-At', '-f', tmp]).trim() } finally { fs.rmSync(tmp, { force: true }) }
}
const lastLine = out => out.split(/\r?\n/).filter(Boolean).pop() ?? ''
const teacher = randomUUID(), importId = randomUUID()
const asTeacher = sql => lastLine(psql(`SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', '${teacher}', false); ${sql}`))
const J = v => '$j$' + JSON.stringify(v) + '$j$'
const T = v => '$t$' + v + '$t$'
const rpc = async (name, a) => {
  try {
    let sql
    if (name === 'ksc_replace_auto_telugu') sql = `SELECT public.${name}('${a.p_draft_paper_id}', '${a.p_run_id}', ${T(a.p_ocr_engine)}, ${T(a.p_ocr_version)}, ${J(a.p_media)}::jsonb, ${J(a.p_question_texts)}::jsonb, ${J(a.p_option_texts)}::jsonb)`
    else sql = `SELECT public.${name}('${a.p_draft_paper_id}', '${a.p_run_id}', ${J(a.p_media)}::jsonb)`
    return { data: JSON.parse(asTeacher(sql)), error: null }
  } catch (e) { return { data: null, error: new Error(String(e.stderr || e.message)) } }
}
const storageMap = {}   // storage_path -> local crop file (stands in for the private bucket)
const storage = {
  async upload(p, bytes, opts) { if (opts?.upsert === false && storageMap[p]) return { error: new Error('exists') }; storageMap[p] = bytes.__file; return { error: null } },
  async remove(paths) { for (const p of paths) delete storageMap[p]; return { error: null } },
}
const fileBytes = f => { const b = fs.readFileSync(f); b.__file = f.replace(/\\/g, '/'); return b }

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

async function main() {
  const t0 = Date.now()
  execFileSync(exe('initdb'), ['-D', dataDir, '-U', 'postgres', '-A', 'trust', '-E', 'UTF8', '--no-locale'], { stdio: 'ignore' })
  execFileSync(exe('pg_ctl'), ['-D', dataDir, '-l', path.join(dataDir, 'server.log'), '-o', `-p ${port} -c listen_addresses=localhost`, '-w', 'start'], { stdio: 'ignore' })
  try {
    psql(STUBS)
    psql(`INSERT INTO auth.users VALUES ('${teacher}'); INSERT INTO public.teacher_profiles VALUES ('${teacher}');
          INSERT INTO public.test_imports (id, created_by) VALUES ('${importId}', '${teacher}');`)
    for (const f of MIGRATIONS) run(['-q', '-f', path.resolve('supabase/migrations', f)])

    // 1. B4.2R writer v3.
    const payload = mapPaperModelToDraft(model, { importId, title: 'SI/CONSTABLE TEST-10', sourceFilename: path.basename(model.meta?.file || 'paper.pdf'), visuals: b43 })
    const runId = asTeacher(`SELECT public.ksc_start_draft_analysis_run('${importId}', '${B4_ENGINE}', '${B4_ENGINE_VERSION}', ${J(payload.metrics)}::jsonb)`)
    const written = JSON.parse(asTeacher(`SELECT public.ksc_replace_draft_analysis_v3('${importId}', '${runId}', ${J(payload.paper)}::jsonb, ${J(payload.materials)}::jsonb, ${J(payload.questions)}::jsonb, ${J(payload.options)}::jsonb)`))
    const paperId = written.draft_paper_id
    const qIds = new Map(psql(`SELECT source_question_number || '|' || id FROM public.draft_questions WHERE draft_paper_id='${paperId}'`).split(/\r?\n/).filter(Boolean).map(l => l.split('|')))
    const materialIdByIndex = new Map(payload.materials.map(m => [m.position, m.id]))
    const optionsByKey = new Map(JSON.parse(psql(`SELECT coalesce(json_agg(json_build_object('k', q.source_question_number || '|' || o.marker, 'id', o.id, 'content', o.content)), '[]')
      FROM public.draft_options o JOIN public.draft_questions q ON q.id = o.draft_question_id WHERE q.draft_paper_id='${paperId}'`)).map(r => [r.k, { id: r.id, content: r.content }]))

    // 2. B4.3 question visuals, 3. material figures + Telugu source crops, 4. B4.4 Telugu.
    const visualsRes = await persistAutoVisuals({ rows: b43.accepted, questionIdByNumber: qIds, teacherId: teacher, draftPaperId: paperId, runId,
      readCrop: row => fileBytes(path.join('reports/b43', row.file)), storage, rpc })
    const materialRes = await persistAutoMaterialMedia({ manifest: b43, materialIdByIndex, teacherId: teacher, draftPaperId: paperId, runId,
      readCrop: e => fileBytes(path.join('reports/b43', e.file)), storage, rpc })
    const teluguRes = await persistAutoTelugu({ benchmark: b44, questionIdByNumber: qIds, optionsByKey, teacherId: teacher, draftPaperId: paperId, runId,
      readCrop: region => fileBytes(path.join('reports/b44', region.file)), storage, rpc })

    // 5. Read the persisted Draft back exactly as stored.
    const snapshot = () => JSON.parse(psql(`SELECT json_build_object(
      'paper', (SELECT row_to_json(p) FROM public.draft_papers p WHERE p.id = '${paperId}'),
      'run', (SELECT row_to_json(r) FROM public.draft_analysis_runs r WHERE r.id = '${runId}'),
      'materials', (SELECT coalesce(json_agg(json_build_object('row', m, 'media',
          (SELECT coalesce(json_agg(dm ORDER BY dm.media_kind, dm.position), '[]') FROM public.draft_media dm WHERE dm.draft_material_id = m.id)) ORDER BY m.position), '[]')
        FROM public.draft_materials m WHERE m.draft_paper_id = '${paperId}'),
      'questions', (SELECT json_agg(json_build_object('row', q,
          'media', (SELECT coalesce(json_agg(dm ORDER BY dm.media_kind, dm.position), '[]') FROM public.draft_media dm WHERE dm.draft_question_id = q.id),
          'texts', (SELECT coalesce(json_agg(t), '[]') FROM public.draft_question_texts t WHERE t.draft_question_id = q.id),
          'options', (SELECT json_agg(json_build_object('row', o,
              'texts', (SELECT coalesce(json_agg(ot), '[]') FROM public.draft_option_texts ot WHERE ot.draft_option_id = o.id)) ORDER BY o.position)
            FROM public.draft_options o WHERE o.draft_question_id = q.id)) ORDER BY q.position)
        FROM public.draft_questions q WHERE q.draft_paper_id = '${paperId}'),
      'teacherWork', public.ksc_draft_has_teacher_work('${paperId}'),
      'reviewItems', (SELECT coalesce(json_agg(ri ORDER BY ri.item_key), '[]') FROM public.draft_review_items ri WHERE ri.draft_paper_id = '${paperId}'),
      'readiness', (SELECT coalesce(json_agg(rd ORDER BY rd.position), '[]') FROM public.draft_question_readiness rd WHERE rd.draft_paper_id = '${paperId}'),
      'materialTexts', (SELECT coalesce(json_agg(mx), '[]') FROM public.draft_material_texts mx JOIN public.draft_materials m ON m.id = mx.draft_material_id WHERE m.draft_paper_id = '${paperId}'))`))

    // 6. B4.5: review items generated from the persisted Draft, written through 0027.
    const items = buildReviewItems(snapshot(), { visualCandidates: b43 })
    const reviewRes = JSON.parse(asTeacher(`SELECT public.ksc_replace_review_items('${paperId}', '${runId}', ${T(REVIEW_GENERATOR + '@' + REVIEW_GENERATOR_VERSION)}, ${J(items)}::jsonb)`))
    const dump = snapshot()
    fs.mkdirSync(OUT_DIR, { recursive: true })
    fs.writeFileSync(path.join(OUT_DIR, 'draft-dump.json'), JSON.stringify({ generated: new Date().toISOString(), writers: { written, visuals: visualsRes.inserted,
      materialMedia: materialRes.inserted, telugu: { crops: teluguRes.crops, questionTexts: teluguRes.question_texts, optionTexts: teluguRes.option_texts } },
      storage: storageMap, ...dump }, null, 1))
    console.log(JSON.stringify({ reviewItems: reviewRes.items, readiness: dump.readiness.reduce((o, r) => (o[r.readiness] = (o[r.readiness] || 0) + 1, o), {}), written, questionVisuals: visualsRes.inserted, materialMedia: materialRes.inserted, teluguCrops: teluguRes.crops,
      teluguQuestionRows: teluguRes.question_texts, teluguOptionRows: teluguRes.option_texts, teacherWork: dump.teacherWork, seconds: (Date.now() - t0) / 1000 }))
  } finally {
    try { execFileSync(exe('pg_ctl'), ['-D', dataDir, '-m', 'immediate', '-w', 'stop'], { stdio: 'ignore' }) } catch {}
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
}
main().catch(e => { console.error('Local persistence failed:', e.message?.slice(0, 2000) || e); process.exit(1) })
