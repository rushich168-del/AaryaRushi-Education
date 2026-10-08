// Throwaway local PostgreSQL with the REAL KSC schema (B4.6/B4.7 local environment).
//
// initdb -> minimal Supabase auth/storage stubs -> every KSC migration 0001 -> 0029 in order (the same
// files the SQL editor would run) -> local fixture users (owner teacher, second teacher) and a small
// program/track catalogue so the teacher-facing upload form works. Nothing else is seeded: a Draft
// exists only after a teacher uploads a paper and runs "Prepare Paper Automatically" — or, for tools
// and tests, through prepareGoldenDraft(), which runs the SAME orchestrator (scripts/lib/paper-preparation.mjs).
// Never connects to Supabase; no auth.signUp. The cluster lives in the OS temp dir; stop() deletes it.

import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import pg from 'pg'
import { createPgRunner, readDraftFlatAs } from './local-pg-api.mjs'
import { runPaperPreparation, snapshotFromFlat } from './paper-preparation.mjs'
import { createNodePlatform } from './preparation-platform-node.mjs'

export const PG_BIN = process.env.KSC_PG_BIN || 'C:/Program Files/PostgreSQL/16/bin'
const exe = n => path.join(PG_BIN, process.platform === 'win32' ? `${n}.exe` : n)
export const SOURCE_BUCKET = 'ksc-source-documents'
export const GOLDEN_PDF = process.env.KSC_GOLDEN_PDF || 'C:/Users/AARYA RUSHI/Downloads/PDF files/SI-CONSTABLE TEST-10(27.03.2026)28 PAGES.pdf'
// The KSC chain only (Atlas/Career migrations are excluded): 2026-09-1x and 2026-09-2x files.
export const kscMigrations = () => fs.readdirSync('supabase/migrations').filter(f => /^2026(091|092)\d+_.*\.sql$/.test(f)).sort()

// numeric/bigint as JSON numbers, like PostgREST.
pg.types.setTypeParser(20, v => Number(v))
pg.types.setTypeParser(1700, v => Number(v))

function supabaseStubSql() {
  // scripts/setup_auth.sql without its data-directory allowlist guard (that guard names another
  // disposable cluster), plus the few Supabase columns/schemas the KSC migrations reference.
  const auth = fs.readFileSync('scripts/setup_auth.sql', 'utf8')
  const guardEnd = auth.indexOf('END $$;') + 'END $$;'.length
  return `${auth.slice(guardEnd)}
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS raw_user_meta_data jsonb DEFAULT '{}'::jsonb, ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
CREATE SCHEMA IF NOT EXISTS storage;
CREATE TABLE IF NOT EXISTS storage.buckets(id text PRIMARY KEY, name text, public boolean DEFAULT false, file_size_limit bigint, allowed_mime_types text[], created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS storage.objects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text, owner uuid, created_at timestamptz DEFAULT now());
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array(name, '/') $$;
GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;
`
}

const ownerAlive = dir => {
  try { const pid = Number(fs.readFileSync(path.join(dir, 'owner.pid'), 'utf8')); if (!pid || pid === process.pid) return false; process.kill(pid, 0); return true } catch { return false }
}

// A hard-killed local backend (e.g. a stopped preview) cannot stop its cluster; clean those up.
// Clusters whose owning process is still alive (another local backend or test) are left alone.
export function cleanupStaleClusters(log = () => {}) {
  for (const d of fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('ksc-local-draft-pg-')).map(n => path.join(os.tmpdir(), n)).filter(d => !ownerAlive(d))) {
    for (const pgDir of [path.join(d, 'pg'), d]) { try { execFileSync(exe('pg_ctl'), ['-D', pgDir, '-m', 'immediate', '-w', 'stop'], { stdio: 'ignore' }) } catch {} }
    try { fs.rmSync(d, { recursive: true, force: true }); log(`removed stale cluster ${d}`) } catch {}
  }
}

// upTo: apply the chain only through that migration file name (deploy rehearsal: load pre-existing
// data, then db.applyMigration(file) for the rest, exactly as the SQL editor would run them).
export async function createLocalKscDb({ port = 56000 + Math.floor(Math.random() * 900), log = () => {}, upTo = null } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ksc-local-draft-pg-'))
  fs.writeFileSync(path.join(dataDir, 'owner.pid'), String(process.pid))
  const storageDir = path.join(dataDir, 'storage')
  const psql = file => execFileSync(exe('psql'), ['-h', 'localhost', '-p', String(port), '-U', 'postgres', '-d', 'postgres', '-q', '-v', 'ON_ERROR_STOP=1', '-f', file],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PGCLIENTENCODING: 'UTF8' } })
  let pool = null
  const stop = async () => {
    try { await pool?.end() } catch {}
    try { execFileSync(exe('pg_ctl'), ['-D', path.join(dataDir, 'pg'), '-m', 'immediate', '-w', 'stop'], { stdio: 'ignore' }) } catch {}
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
  execFileSync(exe('initdb'), ['-D', path.join(dataDir, 'pg'), '-U', 'postgres', '-A', 'trust', '-E', 'UTF8', '--no-locale'], { stdio: 'ignore' })
  const stopPg = () => { try { execFileSync(exe('pg_ctl'), ['-D', path.join(dataDir, 'pg'), '-m', 'immediate', '-w', 'stop'], { stdio: 'ignore' }) } catch {} }
  execFileSync(exe('pg_ctl'), ['-D', path.join(dataDir, 'pg'), '-l', path.join(dataDir, 'server.log'), '-o', `-p ${port} -c listen_addresses=localhost`, '-w', 'start'], { stdio: 'ignore' })
  try {
    const stubFile = path.join(dataDir, 'stubs.sql')
    fs.writeFileSync(stubFile, supabaseStubSql())
    psql(stubFile)
    const migrations = kscMigrations().filter(f => !upTo || f <= upTo)
    for (const f of migrations) psql(path.resolve('supabase/migrations', f))
    log(`KSC schema: ${migrations.length} migrations applied (${migrations[0].slice(0, 12)} … ${migrations.at(-1).slice(0, 12)})`)

    pool = new pg.Pool({ host: 'localhost', port, user: 'postgres', database: 'postgres', max: 8 })
    const teacher = randomUUID(), otherTeacher = randomUUID()
    await pool.query(`INSERT INTO auth.users (id, email, role) VALUES ($1, 'owner.teacher@ksc.local', 'authenticated'), ($2, 'other.teacher@ksc.local', 'authenticated')`, [teacher, otherTeacher])
    await pool.query(`INSERT INTO public.teacher_profiles (id, full_name, role) VALUES ($1, 'Local owner teacher', 'teacher'), ($2, 'Local other teacher', 'teacher')
      ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name`, [teacher, otherTeacher])
    const cat = (await pool.query(`INSERT INTO public.program_categories (name, slug) VALUES ('Police Recruitment (local)', 'police-local') RETURNING id`)).rows[0].id
    const exam = (await pool.query(`INSERT INTO public.exams (name, slug, category_id) VALUES ('SI / Constable (local)', 'si-constable-local', $1) RETURNING id`, [cat])).rows[0].id
    const level = (await pool.query(`INSERT INTO public.exam_levels (exam_id, name) VALUES ($1, 'Preliminary') RETURNING id`, [exam])).rows[0].id
    fs.mkdirSync(storageDir, { recursive: true })
    const applyMigration = f => psql(path.resolve('supabase/migrations', f))
    return { port, dataDir, storageDir, storageMap: {}, pool, runner: createPgRunner(pool), teacher, otherTeacher, catalogue: { categoryId: cat, examId: exam, levelId: level }, applyMigration, stop }
  } catch (e) { stopPg(); fs.rmSync(dataDir, { recursive: true, force: true }); throw e }
}

// The orchestrator's `api` for a local database, acting as `uid` (RPCs via the same typed runner the
// HTTP backend uses; storage writes files under db.storageDir).
export function localPreparationApi(db, uid) {
  return {
    async rpc(name, args) {
      try { return { data: await db.runner.rpc(uid, name, args), error: null } } catch (e) { return { data: null, error: { message: e.message, details: e.detail ?? null, hint: e.hint ?? null, code: e.code } } }
    },
    storage: {
      async upload(objectPath, bytes, opts = {}) {
        if (!objectPath.startsWith(`imports/${uid}/`)) return { error: new Error('storage policy: not your folder') }
        if (db.storageMap[objectPath] && opts.upsert === false) return { error: new Error('exists') }
        const file = path.join(db.storageDir, ...objectPath.split('/'))
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, bytes)
        db.storageMap[objectPath] = file
        return { error: null }
      },
      async remove(paths) { for (const p of paths) { if (db.storageMap[p]) { try { fs.rmSync(db.storageMap[p]) } catch {} delete db.storageMap[p] } } return { error: null } },
    },
    readDraftFlat: paperId => readDraftFlatAs(db.runner, uid, paperId),
  }
}

// Upload a PDF as the teacher would (storage object + test_imports row through RLS).
export async function createImport(db, { uid = db.teacher, pdfFile = GOLDEN_PDF, testName = 'SI/CONSTABLE TEST-10' } = {}) {
  const objectPath = `imports/${uid}/${randomUUID()}.pdf`
  await localPreparationApi(db, uid).storage.upload(objectPath, fs.readFileSync(pdfFile), { upsert: false })
  return db.runner.asUser(uid, c => c.query(`INSERT INTO public.test_imports (exam_id, level_id, test_kind, test_name, storage_path, filename, file_size_bytes, status)
    VALUES ($1, $2, 'FULL_MOCK', $3, $4, $5, $6, 'UPLOADED') RETURNING *`,
    [db.catalogue.examId, db.catalogue.levelId, testName, objectPath, path.basename(pdfFile), fs.statSync(pdfFile).size]).then(r => r.rows[0]))
}

// Tools/tests: the golden paper prepared through the one production orchestrator (Node platform).
export async function prepareGoldenDraft(db, { pdfFile = GOLDEN_PDF, hooks = {} } = {}) {
  const importRecord = await createImport(db, { pdfFile })
  const result = await runPaperPreparation({ platform: createNodePlatform(), api: localPreparationApi(db, db.teacher), importRecord, teacherId: db.teacher,
    pdfBytes: fs.readFileSync(pdfFile), hooks })
  return { importRecord, ...result }
}

// Read-back of a persisted Draft in the shape of reports/b4-preview/draft-dump.json.
export async function dumpDraft(db, paperId, runId) {
  const flat = await readDraftFlatAs(db.runner, db.teacher, paperId)
  const snap = snapshotFromFlat(flat)
  return db.runner.asUser(db.teacher, async c => ({
    ...snap,
    run: (await c.query('SELECT * FROM public.draft_analysis_runs WHERE id = $1', [runId])).rows[0],
    teacherWork: (await c.query('SELECT public.ksc_draft_has_teacher_work($1) AS t', [paperId])).rows[0].t,
    reviewItems: (await c.query('SELECT * FROM public.draft_review_items WHERE draft_paper_id = $1 ORDER BY item_key', [paperId])).rows,
    readiness: (await c.query('SELECT * FROM public.draft_question_readiness WHERE draft_paper_id = $1 ORDER BY position', [paperId])).rows,
    materialTexts: flat.materialTexts,
  }))
}
