import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import {
  detectOptionConflicts, confirmTargetOptionId, optionRowsBySlot, planDraftEdit,
} from '../src/services/draftPaperMapping.js'
import { saveDraftQuestionEdit } from '../src/services/draftEditSave.js'

// Frontend conflict semantics (pure/static). Real SQL behavior of the resolve RPC and of
// 0021 is in scripts/test-draft-option-conflict-db.mjs. No DB, no network.

const t = s => `2026-09-22T10:00:0${s}Z`
// Live Q6 shape: per slot an older blank row + the value row, all EXTRACTED.
const q6Rows = () => ['15', '19', '22', '24'].flatMap((v, i) => [
  { id: `blank${i}`, position: i, content: '', origin: 'EXTRACTED', created_at: t(0), updated_at: t(5) },
  { id: `value${i}`, position: i, content: v, origin: 'EXTRACTED', created_at: t(1), updated_at: t(1) },
])
const resolvedRows = () => ['15', '19', '22', '24'].map((v, i) => ({ id: `value${i}`, position: i, content: v, created_at: t(1) }))

test('conflicts are detected per slot with every competing row (no first-row-wins)', () => {
  const conflicts = detectOptionConflicts(q6Rows())
  assert.deepEqual(conflicts.map(c => c.position), [0, 1, 2, 3])
  for (const c of conflicts) assert.deepEqual(c.rows.map(r => r.content === '' ? 'blank' : 'value'), ['blank', 'value'])
  assert.deepEqual(detectOptionConflicts(resolvedRows()), [])
})

test('ordinary option Save is refused while any slot conflicts — nothing is written', async () => {
  const plan = planDraftEdit({ rows: q6Rows(), formOptions: ['15', '19', '22', '24'] })
  assert.deepEqual(plan.conflicts, [0, 1, 2, 3])
  let writes = 0
  const w = async () => { writes++ }
  const service = {
    getDraftOptions: async () => q6Rows(),
    updateDraftQuestionText: w, updateDraftOptionText: w, confirmSingleChoice: w,
    insertDraftOption: async () => { writes++; return {} },
  }
  const r = await saveDraftQuestionEdit({ questionId: 'q6', form: { question_text: 'Q6', options: ['15', '19', '22', '24'] }, service })
  assert.equal(r.status, 'SLOT_CONFLICT')
  assert.equal(writes, 0)
})

test('Confirm target is looked up by slot and refused while conflicts exist', () => {
  assert.equal(confirmTargetOptionId(q6Rows()), null, 'no confirmation target while conflicting')
  const rows = resolvedRows(); rows[2].is_proposed_correct = true
  assert.equal(confirmTargetOptionId(rows), 'value2', 'proposed row by slot')
  rows[1].is_confirmed_correct = true
  assert.equal(confirmTargetOptionId(rows), 'value1', 'confirmed row wins over proposed')
})

test('10. after resolution the normal editor gets exactly four slots with 15/19/22/24', () => {
  const slots = optionRowsBySlot(resolvedRows())
  assert.equal(slots.length, 4)
  assert.deepEqual(slots.map(s => s.content), ['15', '19', '22', '24'])
  assert.deepEqual(planDraftEdit({ rows: resolvedRows(), formOptions: ['15', '19', '22', '24'] }).conflicts, [])
})

test('Workspace: conflict panel, explicit keep, and blocked Edit / Confirm / option visuals', () => {
  const src = fs.readFileSync('src/components/site/PdfImportWorkspace.jsx', 'utf8')
  assert.match(src, /OPTION CONFLICT — REVIEW REQUIRED/)
  assert.match(src, /optionConflicts: detectOptionConflicts\(opts\)/)
  // Edit, Confirm and the Languages panel are disabled and guarded while conflicts exist.
  assert.equal((src.match(/disabled=\{c\.optionConflicts\?\.length > 0\}/g) || []).length, 3)
  assert.match(src, /languageOpen\[c\.id\] && !\(c\.optionConflicts\?\.length > 0\)/, 'language panel hidden during conflicts')
  assert.match(src.slice(src.indexOf('const handleEditClick'), src.indexOf('const handleEditClick') + 300), /c\.optionConflicts\?\.length/)
  assert.match(src.slice(src.indexOf('const handleToggleConfirm'), src.indexOf('const handleToggleConfirm') + 300), /c\.optionConflicts\?\.length/)
  // The options grid (which holds the option-visual buttons) is replaced by the panel.
  assert.match(src, /\{!\(c\.optionConflicts\?\.length > 0\) && c\.options && c\.options\.length > 0 && \(/)
  // Confirm no longer maps a slot to a row by array index.
  assert.ok(!/c\.optionRows\?\.\[idx\]/.test(src))
  assert.match(src, /confirmTargetOptionId\(c\.optionRows \|\| \[\]\)/)
  // Resolution sends exactly the reviewed rows and the teacher's explicit keep choice.
  const handler = src.slice(src.indexOf('const handleResolveConflict'), src.indexOf('const renderConflictPanel'))
  assert.match(handler, /if \(!choice\?\.keepId\)/)
  assert.match(handler, /expectedOptionIds: conflict\.rows\.map\(r => r\.id\)/)
  assert.match(handler, /keepOptionId: choice\.keepId/)
  assert.match(handler, /window\.confirm\(/)
  // No row is pre-selected as the keeper.
  assert.ok(!/keepId: conflict\.rows\[/.test(src), 'no automatic default keeper')
})

test('migration layout: 0020 foundation + 0021 uniqueness; superseded file removed', () => {
  assert.ok(fs.existsSync('supabase/migrations/202609220020_draft_option_conflict_resolution.sql'))
  assert.ok(fs.existsSync('supabase/migrations/202609220021_draft_option_uniqueness.sql'))
  assert.ok(!fs.existsSync('supabase/migrations/202609220020_draft_option_uniqueness.sql'))
  const m20 = fs.readFileSync('supabase/migrations/202609220020_draft_option_conflict_resolution.sql', 'utf8').replace(/--.*$/gm, '')
  assert.ok(!/draft_media[\s\S]{0,80}draft_question_id\s*=/.test(m20.slice(m20.indexOf('ksc_resolve_option_slot_conflict'))),
    'resolve RPC never touches question-owned media')
})
