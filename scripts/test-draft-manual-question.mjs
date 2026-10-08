import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import {
  suggestMissingNumber, teacherAddedReference, manualInsertPosition,
  planDraftEdit, resolveSlotOptionId,
} from '../src/services/draftPaperMapping.js'

// P0-B1 pure + static checks. Behavioral DB checks (real SQL) live in
// scripts/test-draft-manual-question-db.mjs, which runs against a throwaway
// local Postgres only. No live auth.signUp, no remote calls.

const MIGRATION = fs.readFileSync('supabase/migrations/202609220018_draft_manual_questions.sql', 'utf8')
const cards = [
  { question_number: '8', position: 0 },
  { question_number: '9', position: 1 },
  { question_number: '11', position: 2 },
  { question_number: '12', position: 3 },
]

test('1. suggested number for Q9 -> Q11 is Q10', () => {
  assert.equal(suggestMissingNumber('9', '11'), '10')
})

test('2. sequential Q9 -> Q10 does not invent a missing number', () => {
  assert.equal(suggestMissingNumber('9', '10'), null)
  assert.equal(suggestMissingNumber('?', '11'), null, 'non-numeric neighbour -> no suggestion')
  assert.equal(suggestMissingNumber('12', undefined), '13', 'after the last question: previous + 1')
})

test('3. manual insertion marks origin TEACHER (migration contract)', () => {
  const fn = MIGRATION.slice(MIGRATION.indexOf('FUNCTION public.ksc_insert_draft_question'))
  assert.match(fn, /'TEACHER', auth\.uid\(\)\)/, 'insert RPC writes origin TEACHER')
  assert.match(MIGRATION, /origin TEXT NOT NULL DEFAULT 'EXTRACTED'/, 'existing/extracted rows default EXTRACTED')
})

test('4. insert position falls between the two neighbouring questions', () => {
  assert.equal(manualInsertPosition(cards, 1), 2, 'after Q9 (pos 1) -> pos 2, where Q11 was')
  assert.equal(manualInsertPosition(cards, -1), 0, 'before the first question')
  assert.equal(manualInsertPosition(cards, 3), 4, 'after the last question')
})

test('5. relative ordering is preserved by shifting only later positions', () => {
  const fn = MIGRATION.slice(MIGRATION.indexOf('FUNCTION public.ksc_insert_draft_question'))
  assert.match(fn, /SET position = position \+ 1\s+WHERE draft_paper_id = p_draft_paper_id AND position >= v_pos/)
  assert.ok(!/source_question_number\s*=/.test(fn.split('INSERT INTO')[0]), 'existing question numbers are not rewritten')
})

test('6. manual question starts without a confirmed answer', () => {
  const fn = MIGRATION.slice(MIGRATION.indexOf('FUNCTION public.ksc_insert_draft_question'))
  assert.ok(!/draft_options/.test(fn), 'insert RPC creates no options (so no answer)')
  assert.ok(!/confirmed_by|confirmed_at/.test(fn), 'insert RPC sets no confirmation')
  const p = planDraftEdit({ rows: [], formOptions: ['a', 'b', 'c', 'd'], selectedSlot: null, answerChosen: false })
  assert.equal(p.confirmSlot, null)
})

test('7. existing P0-A option insertion can populate the new question', () => {
  const p = planDraftEdit({ rows: [], formOptions: ['A', 'B', 'C', 'D'] })
  assert.deepEqual(p.inserts.map(i => i.position), [0, 1, 2, 3])
})

test('8. an explicit teacher answer choice can be confirmed on the new question', () => {
  const p = planDraftEdit({ rows: [], formOptions: ['A', 'B', 'C', 'D'], selectedSlot: 0, answerChosen: true })
  const inserted = p.inserts.map(i => ({ id: `new-${i.position}`, position: i.position }))
  assert.equal(resolveSlotOptionId(p.confirmSlot, [], inserted), 'new-0')
})

test('9. a proposed answer is never automatically confirmed', () => {
  const rows = [
    { id: 'o0', position: 0, content: 'A', is_proposed_correct: true, is_confirmed_correct: false },
    { id: 'o1', position: 1, content: 'B', is_proposed_correct: false, is_confirmed_correct: false },
  ]
  assert.equal(planDraftEdit({ rows, formOptions: ['A', 'B'], selectedSlot: null, answerChosen: false }).confirmSlot, null)
  const replaceFn = MIGRATION.slice(MIGRATION.indexOf('FUNCTION public.ksc_replace_draft_analysis'))
  assert.match(replaceFn, /false,\s+-- confirmed answer is NEVER set by analysis ingest/)
})

test('10-12. retry guard runs before any delete and aborts with a controlled token', () => {
  const fn = MIGRATION.slice(MIGRATION.indexOf('FUNCTION public.ksc_replace_draft_analysis'), MIGRATION.indexOf('FUNCTION public.ksc_insert_draft_question'))
  const guardAt = fn.indexOf('ksc_draft_has_teacher_work(v_existing_paper_id)')
  const deleteAt = fn.indexOf('DELETE FROM public.draft_questions')
  const upsertAt = fn.indexOf('INSERT INTO public.draft_papers')
  assert.ok(guardAt > 0 && guardAt < upsertAt && upsertAt < deleteAt, 'guard precedes upsert and delete')
  assert.match(fn, /RAISE EXCEPTION 'KSC_DRAFT_HAS_TEACHER_WORK'/)
  const guard = MIGRATION.slice(MIGRATION.indexOf('FUNCTION public.ksc_draft_has_teacher_work'), MIGRATION.indexOf('FUNCTION public.ksc_replace_draft_analysis'))
  for (const signal of [/q\.origin = 'TEACHER'/, /teacher_review_status <> 'UNREVIEWED'/, /confirmed_by IS NOT NULL/, /confirmed_at IS NOT NULL/, /o\.origin = 'TEACHER'/, /o\.is_confirmed_correct/, /o\.updated_at > o\.created_at/]) {
    assert.match(guard, signal)
  }
})

test('13. untouched extraction-only paper stays eligible (guard only fires on teacher work)', () => {
  const fn = MIGRATION.slice(MIGRATION.indexOf('FUNCTION public.ksc_replace_draft_analysis'))
  assert.match(fn, /IF v_existing_paper_id IS NOT NULL AND public\.ksc_draft_has_teacher_work/)
})

test('14. security stays teacher-owner scoped and additive', () => {
  assert.match(MIGRATION, /WHERE id = p_draft_paper_id AND created_by = auth\.uid\(\)\s+FOR UPDATE/, 'insert RPC checks ownership')
  assert.match(MIGRATION, /IF auth\.uid\(\) IS NULL OR NOT public\.is_teacher\(\)/)
  assert.match(MIGRATION, /SECURITY INVOKER/, 'teacher-work check is RLS-scoped for clients')
  assert.ok(!/TO anon/.test(MIGRATION), 'nothing granted to anon')
  assert.ok(/^BEGIN;/m.test(MIGRATION) && /^COMMIT;/m.test(MIGRATION), 'transactional')
  const code = MIGRATION.replace(/--.*$/gm, '') // scan executable SQL, not safety comments
  for (const forbidden of ['publish_test', 'test_attempts', 'attempt_answers', 'test_question_snapshots', 'ksc_replace_test_import_analysis', 'test_import_candidates', 'public.questions', 'public.question_options']) {
    assert.ok(!code.includes(forbidden), `migration must not touch ${forbidden}`)
  }
})

test('teacher provenance note is honest and names the neighbours', () => {
  assert.equal(teacherAddedReference('9', '11'), 'Teacher added during preparation between Q9 and Q11')
  assert.equal(teacherAddedReference('15', undefined), 'Teacher added during preparation after Q15')
  assert.equal(teacherAddedReference(undefined, '1'), 'Teacher added during preparation before Q1')
})
