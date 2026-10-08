import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { createLocalKscDb, createImport, kscMigrations, PG_BIN } from './lib/local-draft-db.mjs'

// The B4 deployment SQL package (docs/ksc/deploy/*.sql) exercised on a THROWAWAY local PostgreSQL
// shaped like KSC: chain through 0022 + a P0-era Draft with teacher work and the two P0-analyzer
// "Directions" materials holding legacy glyph text (229 / 103 private-use characters, no Telugu).
// Pre-flight (all PASS), backup, quarantine + 0023 -> 0030, post-migration verification (all PASS):
// identical per-paper fingerprints, and the archive matching the pre-flight manifest.
// Every package query runs inside a READ ONLY transaction. Never connects to Supabase.

const HAVE_PG = ['initdb', 'pg_ctl', 'psql'].every(n => fs.existsSync(path.join(PG_BIN, process.platform === 'win32' ? `${n}.exe` : n)))
const skip = HAVE_PG ? false : 'local PostgreSQL binaries not found'
const LAST_APPLIED = '202609220022_draft_language_texts.sql'
const DIR = 'docs/ksc/deploy'
const queries = file => {
  const parts = fs.readFileSync(path.join(DIR, file), 'utf8').split(/^-- =+ QUERY \d+.*$/m)
  return (parts.length > 1 ? parts.slice(1) : parts).map(s => s.trim())
}
const sqlOnly = s => s.replace(/^--.*$/gm, '').trim()
const glyphs = n => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCodePoint(0xF021 + ((i * 37) % 0xDE)) + (i % 9 === 8 ? ' ' : ''); return s }
const dbs = []
after(async () => { for (const d of dbs) await d.stop() })

async function readOnly(db, sql) {
  const c = await db.pool.connect()
  try { await c.query('BEGIN TRANSACTION READ ONLY'); const r = await c.query(sql); await c.query('ROLLBACK'); return r.rows } finally { c.release() }
}

async function seedKscShape(db) {
  const imp = await createImport(db, { testName: 'SI/CONSTABLE TEST-10 (P0 analysis)' })
  const t = db.teacher, paper = randomUUID()
  const x = (sql, a) => db.pool.query(sql, a)
  await x(`INSERT INTO draft_papers (id, source_import_id, title, status, created_by) VALUES ($1,$2,'SI/CONSTABLE TEST-10','PREPARATION',$3)`, [paper, imp.id, t])
  const c = await db.pool.connect()
  const mats = [], qs = {}
  try {
    await c.query('BEGIN')   // one transaction, like ksc_replace_draft_analysis (0017)
    for (const [i, n] of [229, 103].entries()) {
      mats.push((await c.query(`INSERT INTO draft_materials (draft_paper_id, material_type, content_text, source_page_start, source_page_end, created_by)
        VALUES ($1,'PASSAGE',$2,$3,$3,$4) RETURNING id`, [paper, `Directions: read the statements carefully.\n${glyphs(n)}`, i + 2, t])).rows[0].id)
    }
    for (const [pos, [num, mat]] of [['5', mats[0]], ['11', mats[1]], ['12', mats[1]], ['6', null]].entries()) {
      qs[num] = (await c.query(`INSERT INTO draft_questions (draft_paper_id, shared_material_id, position, source_question_number, content, origin, created_by)
        VALUES ($1,$2,$3,$4,$5,'EXTRACTED',$6) RETURNING id`, [paper, mat, pos, num, `Question ${num}`, t])).rows[0].id
      for (let k = 0; k < 4; k++) await c.query(`INSERT INTO draft_options (draft_question_id, position, content, is_proposed_correct) VALUES ($1,$2,$3,$4)`, [qs[num], k, `opt ${k}`, k === 2])
    }
    await c.query('COMMIT')
  } finally { c.release() }
  // Later teacher work (the KSC paper has teacher work).
  await x(`UPDATE draft_questions SET teacher_review_status = 'EDITED', content = 'How many triangles?' WHERE id = $1`, [qs['6']])
  const media = randomUUID()
  await x(`INSERT INTO draft_media (id, draft_paper_id, draft_question_id, media_kind, capture_method, storage_bucket, storage_path, mime_type, source_import_id, source_page, region_x, region_y, region_w, region_h, page_width_pt, page_height_pt, render_scale, created_by)
    VALUES ($1,$2,$3,'FIGURE','SOURCE_REGION','ksc-source-documents',$4,'image/png',$5,2,0.1,0.2,0.3,0.2,595,842,2,$6)`, [media, paper, qs['6'], `imports/${t}/draft-media/${paper}/${media}.png`, imp.id, t])
  await x(`INSERT INTO draft_question_texts (draft_question_id, language, content, text_quality, source, created_by) VALUES ($1,'te','ఎన్ని త్రిభుజాలు?','TEACHER_ENTERED','TEACHER',$2)`, [qs['6'], t])
  return { paper, mats }
}

test('deployment SQL: pre-flight PASS, backup, quarantine + 0023->0030, verification PASS, fingerprints identical, archive = manifest', { skip, timeout: 300_000 }, async () => {
  const db = await createLocalKscDb({ upTo: LAST_APPLIED }); dbs.push(db)
  const { paper, mats } = await seedKscShape(db)

  const [pre1, pre2, pre3] = queries('B4-01-PREFLIGHT-READONLY.sql')
  const checks = await readOnly(db, pre1)
  assert.deepEqual(checks.filter(r => r.result === 'FAIL').map(r => r.check_name), [])
  assert.match(checks.find(r => r.check_name.startsWith('Legacy-glyph material rows')).detail, /^2 row\(s\)/)
  const invBefore = await readOnly(db, pre2)
  assert.equal(invBefore.length, 1); assert.equal(invBefore[0].draft_paper_id, paper); assert.equal(invBefore[0].teacher_work, true)
  const manifest = await readOnly(db, pre3)
  assert.deepEqual(manifest.map(r => r.material_id).sort(), [...mats].sort())
  assert.deepEqual(manifest.map(r => [r.private_use_chars, r.telugu_unicode_chars]).sort((a, b) => b[0] - a[0]), [[229, 0], [103, 0]])

  const [backup] = queries('B4-02-BACKUP-EXPORT-READONLY.sql')
  const b = await readOnly(db, backup)
  assert.equal(b[0].backup.materials.length, 2); assert.equal(b[0].backup.questions.length, 4); assert.equal(b[0].backup.media.length, 1)

  const pending = kscMigrations().filter(f => f > LAST_APPLIED)
  assert.equal(pending[0], '202609222350_draft_material_legacy_glyph_quarantine.sql')
  for (const f of pending) db.applyMigration(f)

  const [post1, post2, post3] = queries('B4-04-POSTMIGRATION-VERIFY-READONLY.sql')
  const verify = await readOnly(db, post1)
  assert.ok(verify.length >= 75)
  assert.deepEqual(verify.filter(r => r.result === 'FAIL').map(r => r.check_name), [])
  assert.equal(verify.find(r => r.check_name.startsWith('Legacy-glyph quarantine: archived rows')).detail, '2')
  assert.equal(sqlOnly(post2), sqlOnly(pre2), 'verification repeats the pre-flight inventory query verbatim')
  assert.deepEqual(await readOnly(db, post2), invBefore, 'inventory, teacher_work and fingerprints identical after migrating')
  const archived = await readOnly(db, post3)
  const key = r => JSON.stringify([r.material_id, r.draft_paper_id, r.content_sha256, r.char_count, r.private_use_chars, r.telugu_unicode_chars,
    new Date(r.created_at).toISOString(), new Date(r.updated_at).toISOString(), r.linked_question_numbers])
  assert.deepEqual(archived.map(key).sort(), manifest.map(key).sort(), 'archive matches the pre-flight manifest')
  for (const r of archived) for (const [k, v] of Object.entries(r)) if (k.startsWith('ok_')) assert.equal(v, true, `${r.material_id} ${k}`)
})

test('pre-flight catches a legacy material the quarantine would refuse (edited after creation), read-only', { skip, timeout: 300_000 }, async () => {
  const db = await createLocalKscDb({ upTo: LAST_APPLIED }); dbs.push(db)
  const { mats } = await seedKscShape(db)
  await db.pool.query(`UPDATE draft_materials SET extraction_confidence = 0.4 WHERE id = $1`, [mats[1]])
  const [pre1] = queries('B4-01-PREFLIGHT-READONLY.sql')
  assert.equal((await readOnly(db, pre1)).find(r => r.check_name.startsWith('Quarantine will accept')).result, 'FAIL')
})
