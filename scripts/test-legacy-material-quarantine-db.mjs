import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import crypto, { randomUUID } from 'crypto'
import { createLocalKscDb, createImport, kscMigrations, PG_BIN } from './lib/local-draft-db.mjs'

// Pre-0023 legacy-glyph quarantine (202609222350) on THROWAWAY local PostgreSQL shaped like the two
// KSC rows found by the pre-flight: a P0 Draft that already holds teacher work, and two P0-analyzer
// "Directions" materials (written with the analyzed questions, never edited) whose content_text has
// 229 / 103 private-use glyph codes and no Unicode Telugu, each linked to its questions.
// Never connects to Supabase.

const HAVE_PG = ['initdb', 'pg_ctl', 'psql'].every(n => fs.existsSync(path.join(PG_BIN, process.platform === 'win32' ? `${n}.exe` : n)))
const skip = HAVE_PG ? false : 'local PostgreSQL binaries not found'
const LAST_APPLIED = '202609220022_draft_language_texts.sql'
const QUARANTINE = '202609222350_draft_material_legacy_glyph_quarantine.sql'
const MARKER = 'LEGACY_GLYPH_TEXT_ARCHIVED'
const dbs = []
after(async () => { for (const d of dbs) await d.stop() })

// Legacy glyph codes as the golden paper encodes Telugu (U+F021..U+F0FE), in word-like runs.
const glyphs = n => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCodePoint(0xF021 + ((i * 37) % 0xDE)) + (i % 9 === 8 ? ' ' : ''); return s }
const M1_TEXT = 'Directions: In the question are given two statements A and B. Read both the statements and decide which of the following answer choices correctly depicts the relationship between these two statements.\n' + glyphs(229)
const M2_TEXT = 'Directions (11-12): Study the following information carefully and answer the questions given below.\n' + glyphs(103)
const PUA = /[-�]/gu
const codePoints = t => Object.entries([...t.matchAll(PUA)].reduce((o, [c]) => ((o[c.codePointAt(0)] = (o[c.codePointAt(0)] || 0) + 1), o), {}))
  .map(([cp, n]) => ({ code_point: 'U+' + Number(cp).toString(16).toUpperCase().padStart(4, '0'), count: n })).sort((a, b) => a.code_point.localeCompare(b.code_point))
const sha = t => crypto.createHash('sha256').update(Buffer.from(t, 'utf8')).digest('hex')

const q = async (db, sql, args = []) => (await db.pool.query(sql, args)).rows
const TABLES = {
  test_imports: `SELECT * FROM test_imports ORDER BY id`, draft_papers: `SELECT * FROM draft_papers ORDER BY id`,
  draft_materials: `SELECT * FROM draft_materials ORDER BY id`, draft_questions: `SELECT * FROM draft_questions ORDER BY id`,
  draft_options: `SELECT * FROM draft_options ORDER BY id`, draft_media: `SELECT * FROM draft_media ORDER BY id`,
  draft_question_texts: `SELECT * FROM draft_question_texts ORDER BY id`, draft_option_texts: `SELECT * FROM draft_option_texts ORDER BY id`,
}
async function snapshot(db) { const o = {}; for (const [k, s] of Object.entries(TABLES)) o[k] = JSON.parse(JSON.stringify(await q(db, s))); return o }
const teacherWork = async (db, paper) => (await q(db, `SELECT public.ksc_draft_has_teacher_work($1) AS w`, [paper]))[0].w

// Mirrors ksc_replace_draft_analysis (0017): materials, questions and options in ONE transaction
// (identical created_at), then optional later teacher work.
async function seed(db, { teacherWork: tw = true, legacy = [M1_TEXT, M2_TEXT], clean = true } = {}) {
  const imp = await createImport(db, { testName: 'SI/CONSTABLE TEST-10 (P0 analysis)' })
  const t = db.teacher, paper = randomUUID()
  await q(db, `INSERT INTO draft_papers (id, source_import_id, title, status, created_by) VALUES ($1,$2,'SI/CONSTABLE TEST-10','PREPARATION',$3)`, [paper, imp.id, t])
  const c = await db.pool.connect()
  const ids = { paper, imp, materials: [], questions: {} }
  try {
    await c.query('BEGIN')
    for (const [i, text] of legacy.entries()) {
      ids.materials.push((await c.query(`INSERT INTO draft_materials (draft_paper_id, material_type, content_text, source_page_start, source_page_end, warnings, created_by)
        VALUES ($1,'PASSAGE',$2,$3,$3,'[]',$4) RETURNING id`, [paper, text, i + 2, t])).rows[0].id)
    }
    if (clean) ids.clean = (await c.query(`INSERT INTO draft_materials (draft_paper_id, material_type, content_text, source_page_start, created_by)
      VALUES ($1,'INSTRUCTIONS','Directions: plain English only.',1,$2) RETURNING id`, [paper, t])).rows[0].id
    const links = [['5', ids.materials[0]], ['11', ids.materials[1]], ['12', ids.materials[1]], ['6', null]]
    for (const [pos, [num, mat]] of links.entries()) {
      const id = (await c.query(`INSERT INTO draft_questions (draft_paper_id, shared_material_id, position, source_question_number, content, origin, created_by)
        VALUES ($1,$2,$3,$4,$5,'EXTRACTED',$6) RETURNING id`, [paper, mat ?? null, pos, num, `Question ${num}`, t])).rows[0].id
      ids.questions[num] = id
      for (let k = 0; k < 4; k++) await c.query(`INSERT INTO draft_options (draft_question_id, position, content, is_proposed_correct) VALUES ($1,$2,$3,$4)`, [id, k, `opt ${k}`, k === 1])
    }
    await c.query('COMMIT')
  } finally { c.release() }
  if (tw) {  // later teacher work, as on KSC: an edited question, a captured figure, a typed Telugu stem
    await q(db, `UPDATE draft_questions SET teacher_review_status = 'EDITED', content = 'How many triangles are there?' WHERE id = $1`, [ids.questions['6']])
    const media = randomUUID()
    await q(db, `INSERT INTO draft_media (id, draft_paper_id, draft_question_id, media_kind, capture_method, storage_bucket, storage_path, mime_type, source_import_id,
        source_page, region_x, region_y, region_w, region_h, page_width_pt, page_height_pt, render_scale, created_by)
      VALUES ($1,$2,$3,'FIGURE','SOURCE_REGION','ksc-source-documents',$4,'image/png',$5,2,0.1,0.2,0.3,0.2,595,842,2,$6)`,
      [media, paper, ids.questions['6'], `imports/${t}/draft-media/${paper}/${media}.png`, imp.id, t])
    await q(db, `INSERT INTO draft_question_texts (draft_question_id, language, content, text_quality, source, created_by) VALUES ($1,'te','ఎన్ని త్రిభుజాలు ఉన్నాయి?','TEACHER_ENTERED','TEACHER',$2)`, [ids.questions['6'], t])
  }
  return ids
}

test('quarantine: archives exactly the two automatic legacy values, clears only them, keeps timestamps, links and teacher work', { skip, timeout: 300_000 }, async () => {
  const db = await createLocalKscDb({ upTo: LAST_APPLIED }); dbs.push(db)
  assert.deepEqual(kscMigrations().filter(f => f > LAST_APPLIED).slice(0, 2), [QUARANTINE, '202609230023_draft_analysis_automation.sql'], 'sorts after 0022, before 0023')
  const ids = await seed(db)
  const before = await snapshot(db)
  const pre = await q(db, `SELECT id, content_text, created_at, updated_at, created_by FROM draft_materials WHERE id = ANY($1) ORDER BY id`, [ids.materials])
  assert.deepEqual(pre.map(r => [r.content_text.match(PUA).length, (r.content_text.match(/[ఀ-౿]/gu) || []).length]).sort((a, b) => b[0] - a[0]), [[229, 0], [103, 0]])
  assert.ok(pre.every(r => r.updated_at.getTime() === r.created_at.getTime()), 'KSC shape: never edited')
  assert.equal(await teacherWork(db, ids.paper), true)

  db.applyMigration(QUARANTINE)
  const afterSnap = await snapshot(db)

  // Archive: exact originals with provenance and evidence.
  const archive = await q(db, `SELECT * FROM draft_material_legacy_text_archive ORDER BY draft_material_id`)
  assert.equal(archive.length, 2)
  for (const a of archive) {
    const m = pre.find(r => r.id === a.draft_material_id)
    assert.equal(a.original_content_text, m.content_text, 'exact original text')
    assert.equal(a.original_sha256, sha(m.content_text))
    assert.equal(a.private_use_char_count, m.content_text.match(PUA).length); assert.equal(a.telugu_unicode_char_count, 0); assert.equal(a.replacement_char_count, 0)
    assert.equal(a.original_char_count, [...m.content_text].length)
    assert.deepEqual(a.offending_code_points, codePoints(m.content_text))
    assert.equal(a.material_created_at.getTime(), m.created_at.getTime()); assert.equal(a.material_updated_at.getTime(), m.updated_at.getTime())
    assert.equal(a.material_created_by, m.created_by); assert.equal(a.owner_id, db.teacher); assert.equal(a.draft_paper_id, ids.paper); assert.equal(a.source_import_id, ids.imp.id)
    assert.deepEqual(a.original_warnings, [])
  }
  assert.deepEqual(archive.find(a => a.draft_material_id === ids.materials[0]).linked_question_numbers, ['5'])
  assert.deepEqual(archive.find(a => a.draft_material_id === ids.materials[1]).linked_question_numbers, ['11', '12'])

  // Live rows: only content_text and warnings changed, and only on the two materials.
  for (const [table, rows] of Object.entries(before)) {
    if (table === 'draft_materials') continue
    assert.deepEqual(afterSnap[table], rows, `${table} unchanged`)
  }
  for (const m of before.draft_materials) {
    const now = afterSnap.draft_materials.find(r => r.id === m.id)
    if (!ids.materials.includes(m.id)) { assert.deepEqual(now, m, 'clean material untouched'); continue }
    const { content_text: c0, warnings: w0, ...rest0 } = m
    const { content_text: c1, warnings: w1, ...rest1 } = now
    assert.deepEqual(rest1, rest0, 'every other column (incl. updated_at) identical')
    assert.equal(c1, null)
    assert.equal(w1.length, w0.length + 1); assert.deepEqual(w1.slice(0, -1), w0)
    const a = archive.find(x => x.draft_material_id === m.id)
    assert.match(w1.at(-1), new RegExp(`^${MARKER}: `)); assert.ok(w1.at(-1).includes(a.id) && w1.at(-1).includes(a.original_sha256))
  }
  assert.equal(await teacherWork(db, ids.paper), true, 'teacher work unchanged')
  assert.equal((await q(db, `SELECT tgenabled FROM pg_trigger WHERE tgname = 'set_draft_materials_updated_at'`))[0].tgenabled, 'O', 'updated_at trigger re-enabled')

  // Idempotent.
  db.applyMigration(QUARANTINE)
  assert.deepEqual(await snapshot(db), afterSnap)
  assert.equal((await q(db, `SELECT count(*)::int n FROM draft_material_legacy_text_archive`))[0].n, 2)

  // Security: RLS, owner-only read, no anon, no client writes, immutable.
  assert.equal((await q(db, `SELECT relrowsecurity FROM pg_class WHERE oid = 'public.draft_material_legacy_text_archive'::regclass`))[0].relrowsecurity, true)
  for (const [role, priv, want] of [['anon', 'SELECT', false], ['anon', 'INSERT', false], ['authenticated', 'SELECT', true], ['authenticated', 'INSERT', false],
    ['authenticated', 'UPDATE', false], ['authenticated', 'DELETE', false]]) {
    assert.equal((await q(db, `SELECT has_table_privilege($1, 'public.draft_material_legacy_text_archive', $2) AS p`, [role, priv]))[0].p, want, `${role} ${priv}`)
  }
  assert.equal((await q(db, `SELECT has_function_privilege('authenticated', 'public.ksc_guard_material_legacy_archive()', 'EXECUTE') AS p`))[0].p, false)
  const own = await db.runner.asUser(db.teacher, c => c.query(`SELECT draft_material_id FROM draft_material_legacy_text_archive`).then(r => r.rows))
  assert.equal(own.length, 2)
  const other = await db.runner.asUser(db.otherTeacher, c => c.query(`SELECT draft_material_id FROM draft_material_legacy_text_archive`).then(r => r.rows))
  assert.equal(other.length, 0)
  await assert.rejects(q(db, `UPDATE draft_material_legacy_text_archive SET reason = 'x'`), /KSC_LEGACY_ARCHIVE_IMMUTABLE/)
  await assert.rejects(q(db, `DELETE FROM draft_material_legacy_text_archive`), /KSC_LEGACY_ARCHIVE_IMMUTABLE/)

  // The rest of the chain now applies; the quarantine created no teacher work and no drift.
  for (const f of kscMigrations().filter(f => f > QUARANTINE)) db.applyMigration(f)
  assert.equal(await teacherWork(db, ids.paper), true)
  const m = await q(db, `SELECT id, content_text, origin, created_at, updated_at FROM draft_materials WHERE id = ANY($1)`, [ids.materials])
  assert.ok(m.every(r => r.content_text === null && r.origin === 'EXTRACTED' && r.updated_at.getTime() === r.created_at.getTime()))
  assert.equal((await q(db, `SELECT count(*)::int n FROM draft_material_legacy_text_archive`))[0].n, 2)
  const status = await db.runner.rpc(db.teacher, 'ksc_paper_preparation_status', { p_import_id: ids.imp.id })
  assert.equal(status.teacher_work, true); assert.equal(status.state, 'UPLOADED')
})

test('quarantine never creates teacher work: an untouched P0 Draft stays automatic through 0023-0030', { skip, timeout: 300_000 }, async () => {
  const db = await createLocalKscDb({ upTo: LAST_APPLIED }); dbs.push(db)
  const ids = await seed(db, { teacherWork: false })
  for (const f of kscMigrations().filter(f => f > LAST_APPLIED)) db.applyMigration(f)
  assert.equal(await teacherWork(db, ids.paper), false)
  assert.equal((await q(db, `SELECT count(*)::int n FROM draft_material_legacy_text_archive`))[0].n, 2)
})

for (const [name, tamper, pattern] of [
  ['edited after creation', (db, id) => q(db, `UPDATE draft_materials SET extraction_confidence = 0.5 WHERE id = $1`, [id]), /KSC_QUARANTINE_REFUSED/],
  ['not written by the paper owner', (db, id) => q(db, `ALTER TABLE draft_materials DISABLE TRIGGER set_draft_materials_updated_at; UPDATE draft_materials SET created_by = '${db.otherTeacher}' WHERE id = '${id}'; ALTER TABLE draft_materials ENABLE TRIGGER set_draft_materials_updated_at`), /KSC_QUARANTINE_REFUSED/],
]) {
  test(`quarantine refuses (changes nothing) when a legacy material was ${name}`, { skip, timeout: 300_000 }, async () => {
    const db = await createLocalKscDb({ upTo: LAST_APPLIED }); dbs.push(db)
    const ids = await seed(db)
    await tamper(db, ids.materials[1])
    const before = await snapshot(db)
    assert.throws(() => db.applyMigration(QUARANTINE), pattern)
    assert.deepEqual(await snapshot(db), before, 'nothing changed')
    assert.equal((await q(db, `SELECT to_regclass('public.draft_material_legacy_text_archive') IS NULL AS gone`))[0].gone, true, 'rolled back whole')
    assert.equal((await q(db, `SELECT tgenabled FROM pg_trigger WHERE tgname = 'set_draft_materials_updated_at'`))[0].tgenabled, 'O')
  })
}
