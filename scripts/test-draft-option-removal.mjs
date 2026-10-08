import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import crypto from 'crypto'
import { planDraftEdit, compareDraftOptions } from '../src/services/draftPaperMapping.js'
import { saveDraftQuestionEdit } from '../src/services/draftEditSave.js'

// Option clearing/removal semantics + migration locks. Pure/static; no DB, no network.
// Real SQL behavior of 0020 is in scripts/test-draft-option-uniqueness-db.mjs.

function fakeService(rows) {
  const calls = { writes: 0 }
  const write = async () => { calls.writes++ }
  return {
    calls,
    service: {
      getDraftOptions: async () => rows.map(r => ({ ...r })),
      updateDraftQuestionText: write, updateDraftOptionText: write,
      insertDraftOption: async (q, position) => { calls.writes++; return { id: `n${position}`, position } },
      confirmSingleChoice: write,
    },
  }
}
const four = () => ['15', '19', '22', '24'].map((c, i) => ({ id: `o${i}`, position: i, content: c }))

test('6. a blank slot that never had an option creates no row', () => {
  const p = planDraftEdit({ rows: four().slice(0, 3), formOptions: ['15', '19', '22', ''] })
  assert.equal(p.inserts.length, 0)
  assert.deepEqual(p.blankedExisting, [])
})

test('7. clearing an existing option textbox is not a silent delete (Save refused, nothing written)', async () => {
  const p = planDraftEdit({ rows: four(), formOptions: ['15', '', '22', '24'] })
  assert.deepEqual(p.blankedExisting, [1])
  assert.equal(p.updates.length, 0, 'the old value is not overwritten with blank')
  const { calls, service } = fakeService(four())
  const r = await saveDraftQuestionEdit({ questionId: 'q6', form: { question_text: 'Q', options: ['15', '', '22', '24'] }, service })
  assert.equal(r.status, 'BLANK_EXISTING')
  assert.equal(calls.writes, 0, 'no write of any kind')
})

test('an option that was already empty may stay empty; editing text still updates', () => {
  const rows = [{ id: 'e', position: 0, content: '' }, ...four().slice(1)]
  const p = planDraftEdit({ rows, formOptions: ['', '19 fixed', '22', '24'] })
  assert.deepEqual(p.blankedExisting, [])
  assert.deepEqual(p.updates, [{ id: 'o1', position: 1, content: '19 fixed' }])
})

test('option order is deterministic for rows sharing a position (why cleared values "came back")', () => {
  const older = { id: 'b', position: 0, content: '15', created_at: '2026-09-22T10:00:00Z' }
  const newer = { id: 'a', position: 0, content: '', created_at: '2026-09-22T10:00:01Z' }
  assert.deepEqual([newer, older].sort(compareDraftOptions).map(r => r.id), ['b', 'a'])
  assert.deepEqual([older, newer].sort(compareDraftOptions).map(r => r.id), ['b', 'a'], 'same order regardless of database return order')
})

test('8-10 (UI). explicit Remove exists only for existing rows and pre-checks confirmed/visual', () => {
  const src = fs.readFileSync('src/components/site/PdfImportWorkspace.jsx', 'utf8')
  const handler = src.slice(src.indexOf('const handleRemoveOption ='), src.indexOf('// ---- P0-B1'))
  assert.match(handler, /row\.is_confirmed_correct/)
  assert.match(handler, /c\.optionMedia\?\.\[row\.id\]/)
  assert.match(handler, /window\.confirm\(/)
  assert.match(handler, /draftPaperService\.removeDraftOption\(row\.id\)/)
  assert.match(src, /const slotRow = optionRowsBySlot\(c\.optionRows \|\| \[\]\)\[i\]\s+return slotRow \?/, 'button only when a row exists')
  assert.match(src, /result\.status === 'BLANK_EXISTING'/)
  const svc = fs.readFileSync('src/services/draftPaperService.js', 'utf8')
  assert.match(svc, /rpc\('ksc_remove_draft_option'/)
  assert.ok(!/from\('draft_options'\)[\s\S]{0,40}\.delete\(/.test(svc), 'no direct client DELETE of options')
})

test('12. migrations 0017-0019 are byte-for-byte unchanged (as applied)', () => {
  const locked = {
    '202609220017_draft_paper_foundation.sql': '255c022d8febdc3ed6d49f3dad99b4ca306aaf97443562914c285512d26b5eba',
    '202609220018_draft_manual_questions.sql': 'd4264129070b67e49afefcb37b78ac699997f53994851c5c02a442a6ebf48260',
    '202609220019_draft_media.sql': '82d92f025cc5b991dd6a8471960834a954653c0b9e70702e5296c2d926f66901',
  }
  for (const [file, hash] of Object.entries(locked)) {
    const actual = crypto.createHash('sha256').update(fs.readFileSync(`supabase/migrations/${file}`)).digest('hex')
    assert.equal(actual, hash, `${file} changed`)
  }
})

test('13. migrations 0020/0021 touch no Exam Engine / Question Bank / legacy / storage objects', () => {
  const read = f => fs.readFileSync(`supabase/migrations/${f}`, 'utf8').replace(/--.*$/gm, '')
  const m20 = read('202609220020_draft_option_conflict_resolution.sql')
  const m21 = read('202609220021_draft_option_uniqueness.sql')
  for (const code of [m20, m21]) {
    for (const forbidden of ['publish_test', 'test_attempts', 'attempt_answers', 'test_question_snapshots', 'test_option_snapshots',
      'public.questions', 'public.question_options', 'question_answer_keys', 'ksc_replace_test_import_analysis',
      'test_import_candidates', 'storage.', 'FUNCTION public.ksc_replace_draft_analysis', 'FUNCTION public.ksc_draft_has_teacher_work']) {
      assert.ok(!code.includes(forbidden), `must not touch ${forbidden}`)
    }
    assert.ok(!/TO anon/.test(code))
    assert.ok(/^BEGIN;/m.test(code) && /^COMMIT;/m.test(code))
  }
  assert.match(m20, /REVOKE DELETE ON public\.draft_options FROM authenticated/)
  assert.ok(!/ADD CONSTRAINT/.test(m20), '0020 adds no uniqueness constraint')
  assert.match(m21, /ADD CONSTRAINT draft_options_one_row_per_position UNIQUE \(draft_question_id, position\)/)
})
