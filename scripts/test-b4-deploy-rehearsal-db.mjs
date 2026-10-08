import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { createLocalKscDb, createImport, kscMigrations, PG_BIN } from './lib/local-draft-db.mjs'

// B4 pre-deploy rehearsal on a THROWAWAY local PostgreSQL: the KSC chain through 0022 (what the
// real project has), P0-era Draft data like the real SI Draft (teacher edits, a manual question,
// a SOURCE_REGION capture, teacher Telugu rows, an analyzer material), then 0023 -> 0030 applied
// file by file exactly as the SQL editor runs them. Existing rows must be unchanged, teacher work
// must still be recognised (automatic preparation refused), nobody but the owning teacher reaches
// the new tables/RPCs, and a migration that fails half-way must leave nothing behind.
// Never connects to Supabase.

const HAVE_PG = ['initdb', 'pg_ctl', 'psql'].every(n => fs.existsSync(path.join(PG_BIN, process.platform === 'win32' ? `${n}.exe` : n)))
const skip = HAVE_PG ? false : 'local PostgreSQL binaries not found'
const LAST_APPLIED = '202609220022_draft_language_texts.sql'
const pending = () => kscMigrations().filter(f => f > LAST_APPLIED)
const dbs = []
after(async () => { for (const d of dbs) await d.stop() })

const q = async (db, sql, args = []) => (await db.pool.query(sql, args)).rows

// P0-era Draft (inserted as the database owner, like data the P0 app wrote through its RPCs).
async function seedP0Draft(db, { teacherWork = true, legacyMaterialGlyphs = false } = {}) {
  const imp = await createImport(db, { testName: 'SI/CONSTABLE TEST-10 (P0 Draft)' })
  const t = db.teacher
  const paper = randomUUID(), m = randomUUID(), q1 = randomUUID(), q2 = randomUUID()
  const o = Array.from({ length: 6 }, () => randomUUID()), media = randomUUID()
  await q(db, `INSERT INTO draft_papers (id, source_import_id, title, source_filename, status, created_by) VALUES ($1,$2,'SI/CONSTABLE TEST-10','si.pdf','PREPARATION',$3)`, [paper, imp.id, t])
  await q(db, `INSERT INTO draft_materials (id, draft_paper_id, material_type, content_text, created_by) VALUES ($1,$2,'INSTRUCTIONS',$3,$4)`,
    [m, paper, legacyMaterialGlyphs ? 'Directions ' : 'Directions: read the passage and answer Q1-Q2.', t])
  await q(db, `INSERT INTO draft_questions (id, draft_paper_id, shared_material_id, position, source_question_number, content, origin, teacher_review_status, created_by)
    VALUES ($1,$2,$3,0,'1','How many triangles?','EXTRACTED',$4,$5), ($6,$2,NULL,1,'2','Second question',$7,'UNREVIEWED',$5)`,
    [q1, paper, m, teacherWork ? 'EDITED' : 'UNREVIEWED', t, q2, teacherWork ? 'TEACHER' : 'EXTRACTED'])
  for (const [i, [id, qid, content, proposed]] of [[o[0], q1, '15', false], [o[1], q1, '19', false], [o[2], q1, '22', false], [o[3], q1, '24', true], [o[4], q2, 'Yes', false], [o[5], q2, 'No', false]].entries()) {
    await q(db, `INSERT INTO draft_options (id, draft_question_id, position, content, is_proposed_correct) VALUES ($1,$2,$3,$4,$5)`, [id, qid, i % 4, content, proposed])
  }
  if (teacherWork) {
    await q(db, `UPDATE draft_options SET content = '24', updated_at = now() + interval '1 second' WHERE id = $1`, [o[3]])
    await q(db, `INSERT INTO draft_media (id, draft_paper_id, draft_question_id, media_kind, capture_method, storage_bucket, storage_path, mime_type,
        source_import_id, source_page, region_x, region_y, region_w, region_h, page_width_pt, page_height_pt, render_scale, created_by)
      VALUES ($1,$2,$3,'FIGURE','SOURCE_REGION','ksc-source-documents',$4,'image/png',$5,2,0.1,0.2,0.3,0.2,595,842,2,$6)`,
      [media, paper, q1, `imports/${t}/draft-media/${paper}/${media}.png`, imp.id, t])
    await q(db, `INSERT INTO draft_question_texts (draft_question_id, language, content, text_quality, source, created_by) VALUES ($1,'te','ఎన్ని త్రిభుజాలు?','TEACHER_ENTERED','TEACHER',$2)`, [q1, t])
    await q(db, `INSERT INTO draft_option_texts (draft_option_id, language, content, text_quality, source, created_by) VALUES ($1,'te','15','SCRIPT_NEUTRAL','TEACHER',$2)`, [o[0], t])
  }
  return { imp, paper }
}

// Every pre-existing row of the paper, restricted to the columns it had before the migration.
async function snapshot(db, paper, columns = null) {
  const tables = {
    draft_papers: `SELECT * FROM draft_papers WHERE id = $1`,
    draft_materials: `SELECT * FROM draft_materials WHERE draft_paper_id = $1`,
    draft_questions: `SELECT * FROM draft_questions WHERE draft_paper_id = $1`,
    draft_options: `SELECT o.* FROM draft_options o JOIN draft_questions q ON q.id = o.draft_question_id WHERE q.draft_paper_id = $1`,
    draft_media: `SELECT * FROM draft_media WHERE draft_paper_id = $1`,
    draft_question_texts: `SELECT t.* FROM draft_question_texts t JOIN draft_questions q ON q.id = t.draft_question_id WHERE q.draft_paper_id = $1`,
    draft_option_texts: `SELECT t.* FROM draft_option_texts t JOIN draft_options o ON o.id = t.draft_option_id JOIN draft_questions q ON q.id = o.draft_question_id WHERE q.draft_paper_id = $1`,
  }
  const out = {}
  for (const [name, sql] of Object.entries(tables)) {
    const rows = (await q(db, sql, [paper])).sort((a, b) => String(a.id).localeCompare(String(b.id)))
    const cols = columns?.[name] ?? Object.keys(rows[0] || {})
    out[name] = { cols, rows: rows.map(r => Object.fromEntries(cols.map(c => [c, r[c] instanceof Date ? r[c].toISOString() : r[c]]))) }
  }
  return out
}

test('0023 -> 0030 on P0-era data: existing Draft and teacher work unchanged, preparation refused, access owner-only', { skip, timeout: 300_000 }, async () => {
  const db = await createLocalKscDb({ upTo: LAST_APPLIED }); dbs.push(db)
  const { imp, paper } = await seedP0Draft(db, { teacherWork: true })
  const before = await snapshot(db, paper)
  const workBefore = (await q(db, `SELECT public.ksc_draft_has_teacher_work($1) AS w`, [paper]))[0].w
  assert.equal(workBefore, true)

  // B4.8.2 adds 0031 (review-item reconciliation), B4.8.3C adds 0032 (math-image recovery) and B4.8.4C adds 0033
  // (Telugu teacher-work compression): all are rehearsed here over the same P0-era data.
  assert.deepEqual(pending().map(f => f.slice(8, 12)), ['2350', '0023', '0024', '0025', '0026', '0027', '0028', '0029', '0030', '0031', '0032', '0033'])
  for (const f of pending()) db.applyMigration(f)
  assert.equal((await q(db, `SELECT (SELECT count(*) FROM draft_math_image_resolutions) + (SELECT count(*) FROM draft_math_image_placement_log) AS n`))[0].n, 0,
    '0032 writes no recovery rows')
  assert.equal((await q(db, `SELECT (SELECT count(*) FROM draft_telugu_decisions) + (SELECT count(*) FROM draft_telugu_decision_items) AS n`))[0].n, 0,
    '0033 writes no decision evidence')

  // Existing rows: every pre-existing column value is identical (new columns are only added).
  const afterSnap = await snapshot(db, paper, Object.fromEntries(Object.entries(before).map(([k, v]) => [k, v.cols])))
  for (const k of Object.keys(before)) assert.deepEqual(afterSnap[k].rows, before[k].rows, `${k} changed`)
  assert.equal(before.draft_media.rows.length, 1); assert.equal(before.draft_question_texts.rows.length, 1)
  assert.equal((await q(db, `SELECT count(*)::int n FROM draft_options WHERE is_confirmed_correct`))[0].n, 0)
  // New columns on existing rows take neutral values.
  const mat = (await q(db, `SELECT origin, analysis_run_id FROM draft_materials WHERE draft_paper_id = $1`, [paper]))[0]
  assert.deepEqual(mat, { origin: 'EXTRACTED', analysis_run_id: null })

  // Teacher work is still teacher work under the final (0027) definition; preparation is refused.
  assert.equal((await q(db, `SELECT public.ksc_draft_has_teacher_work($1) AS w`, [paper]))[0].w, true)
  const status = await db.runner.rpc(db.teacher, 'ksc_paper_preparation_status', { p_import_id: imp.id })
  assert.equal(status.state, 'UPLOADED'); assert.equal(status.teacher_work, true); assert.equal(status.draft_paper_id, paper)
  await assert.rejects(db.runner.rpc(db.teacher, 'ksc_start_paper_preparation', { p_import_id: imp.id, p_engine: 'e', p_engine_version: '1', p_client: {} }),
    /KSC_DRAFT_HAS_TEACHER_WORK/)
  assert.equal((await q(db, `SELECT count(*)::int n FROM draft_analysis_runs`))[0].n, 0, 'a refused start creates no run')

  // 0019 provenance constraint is present again (0030) and enforced.
  assert.equal((await q(db, `SELECT count(*)::int n FROM pg_constraint WHERE conname = 'draft_media_source_region_provenance'`))[0].n, 1)
  await assert.rejects(q(db, `INSERT INTO draft_media (draft_paper_id, draft_question_id, media_kind, capture_method, storage_bucket, storage_path, mime_type, created_by)
    SELECT $1::uuid, id, 'FIGURE', 'SOURCE_REGION', 'ksc-source-documents', 'imports/' || $2::text || '/draft-media/' || $1::text || '/' || gen_random_uuid() || '.png', 'image/png', $2::uuid
    FROM draft_questions WHERE draft_paper_id = $1::uuid LIMIT 1`, [paper, db.teacher]), /draft_media_source_region_provenance/)

  // Access: anon has nothing; RLS enabled; another teacher sees nothing.
  for (const t of ['draft_analysis_runs', 'draft_review_items', 'draft_material_texts']) {
    assert.equal((await q(db, `SELECT relrowsecurity FROM pg_class WHERE oid = $1::regclass`, [`public.${t}`]))[0].relrowsecurity, true, `${t} RLS`)
    assert.equal((await q(db, `SELECT has_table_privilege('anon', $1, 'SELECT') OR has_table_privilege('anon', $1, 'INSERT') OR has_table_privilege('anon', $1, 'UPDATE') AS p`, [`public.${t}`]))[0].p, false, `${t} anon`)
  }
  assert.equal((await q(db, `SELECT has_table_privilege('anon', 'public.draft_question_readiness', 'SELECT') AS p`))[0].p, false)
  const fns = (await q(db, `SELECT p.oid::regprocedure::text AS f FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname LIKE 'ksc\\_%' AND (p.proname LIKE '%prepar%' OR p.proname LIKE '%review%' OR p.proname LIKE '%auto%' OR p.proname LIKE '%analysis%' OR p.proname LIKE '%language%')`)).map(r => r.f)
  assert.ok(fns.length >= 15)
  for (const f of fns) assert.equal((await q(db, `SELECT has_function_privilege('anon', $1, 'EXECUTE') AS p`, [f]))[0].p, false, `${f} anon EXECUTE`)
  const other = await db.runner.rpc(db.otherTeacher, 'ksc_paper_preparation_status', { p_import_id: imp.id })
  assert.equal(other.draft_paper_id, null); assert.equal(other.state, 'UPLOADED')
  assert.deepEqual(await db.runner.asUser(db.otherTeacher, c => c.query(`SELECT id FROM draft_questions WHERE draft_paper_id = $1`, [paper]).then(r => r.rows)), [])
})

test('an untouched P0 Draft reads as automatic (preparation may replace it) — disclosed behaviour', { skip, timeout: 300_000 }, async () => {
  const db = await createLocalKscDb({ upTo: LAST_APPLIED }); dbs.push(db)
  const { imp, paper } = await seedP0Draft(db, { teacherWork: false })
  for (const f of pending()) db.applyMigration(f)
  const status = await db.runner.rpc(db.teacher, 'ksc_paper_preparation_status', { p_import_id: imp.id })
  assert.equal(status.teacher_work, false); assert.equal(status.draft_paper_id, paper); assert.equal(status.state, 'UPLOADED')
})

test('a migration failing half-way changes nothing: legacy glyphs in a material (quarantine deliberately skipped) stop 0026, which rolls back whole', { skip, timeout: 300_000 }, async () => {
  const db = await createLocalKscDb({ upTo: LAST_APPLIED }); dbs.push(db)
  const { paper } = await seedP0Draft(db, { teacherWork: true, legacyMaterialGlyphs: true })
  const [m23, m24, m25, m26] = pending().filter(f => f >= '202609230023')
  db.applyMigration(m23); db.applyMigration(m24); db.applyMigration(m25)
  const before = await snapshot(db, paper)
  assert.throws(() => db.applyMigration(m26), /draft_materials_no_legacy_glyphs/)
  // Nothing of 0026 exists; 0023-0025 are intact; data unchanged.
  assert.equal((await q(db, `SELECT to_regprocedure('public.ksc_replace_draft_analysis_v3(uuid,uuid,jsonb,jsonb,jsonb,jsonb)') IS NULL AS gone`))[0].gone, true)
  assert.equal((await q(db, `SELECT count(*)::int n FROM information_schema.columns WHERE table_name = 'draft_materials' AND column_name = 'origin'`))[0].n, 0)
  assert.equal((await q(db, `SELECT to_regprocedure('public.ksc_replace_auto_telugu(uuid,uuid,text,text,jsonb,jsonb,jsonb)') IS NOT NULL AS present`))[0].present, true)
  assert.deepEqual(await snapshot(db, paper, Object.fromEntries(Object.entries(before).map(([k, v]) => [k, v.cols]))), before)
})
