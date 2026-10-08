import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planDraftEdit, resolveSlotOptionId, optionRowsBySlot } from '../src/services/draftPaperMapping.js'

// P0-A: teacher repair of draft options on the four-slot SINGLE_CHOICE card,
// and protection of PROPOSED != CONFIRMED. Pure planning tests (no DB).

const row = (id, position, content, extra = {}) => ({
  id, position, content, is_proposed_correct: false, is_confirmed_correct: false, ...extra,
})
const fourRows = () => [row('o0', 0, 'A'), row('o1', 1, 'B'), row('o2', 2, 'C'), row('o3', 3, 'D')]

test('1. zero rows + four values -> four inserts at positions 0..3', () => {
  const p = planDraftEdit({ rows: [], formOptions: ['a', 'b', 'c', 'd'] })
  assert.deepEqual(p.inserts.map(i => i.position), [0, 1, 2, 3])
  assert.deepEqual(p.inserts.map(i => i.content), ['a', 'b', 'c', 'd'])
  assert.equal(p.updates.length, 0)
})

test('2. zero rows + three nonblank values -> three inserts, blank slot not created', () => {
  const p = planDraftEdit({ rows: [], formOptions: ['a', '  ', 'c', 'd'] })
  assert.deepEqual(p.inserts.map(i => i.position), [0, 2, 3])
})

test('3. four rows + one changed value -> exactly one update, no inserts', () => {
  const p = planDraftEdit({ rows: fourRows(), formOptions: ['A', 'B fixed', 'C', 'D'] })
  assert.deepEqual(p.updates, [{ id: 'o1', position: 1, content: 'B fixed' }])
  assert.equal(p.inserts.length, 0)
})

test('4. existing rows + one missing position -> only that nonblank position inserted', () => {
  const rows = [row('o0', 0, 'A'), row('o1', 1, 'B'), row('o3', 3, 'D')]
  const p = planDraftEdit({ rows, formOptions: ['A', 'B', 'C new', 'D'] })
  assert.deepEqual(p.inserts, [{ position: 2, content: 'C new' }])
  assert.equal(p.updates.length, 0)
})

test('5. no duplicate operation for an existing position', () => {
  const rows = [row('o0', 0, 'A'), row('dup', 0, 'A-dup'), row('o1', 1, 'B')]
  const p = planDraftEdit({ rows, formOptions: ['A2', 'B', 'c', ''] })
  const touched = [...p.updates.map(u => u.position), ...p.inserts.map(i => i.position)]
  assert.equal(new Set(touched).size, touched.length, 'each position touched at most once')
  assert.deepEqual(p.updates, [{ id: 'o0', position: 0, content: 'A2' }])
  assert.ok(!p.inserts.some(i => i.position === 0 || i.position === 1), 'no insert on existing positions')
})

test('6. newly inserted option resolves to an id usable for explicit confirmation', () => {
  const p = planDraftEdit({ rows: [], formOptions: ['a', 'b', 'c', 'd'], selectedSlot: 2, answerChosen: true })
  assert.equal(p.confirmSlot, 2)
  const inserted = p.inserts.map(i => ({ id: `new-${i.position}`, position: i.position }))
  assert.equal(resolveSlotOptionId(p.confirmSlot, [], inserted), 'new-2')
})

test('7. parser proposed answer + text-only edit -> no confirmation', () => {
  const rows = fourRows(); rows[1].is_proposed_correct = true
  const p = planDraftEdit({ rows, formOptions: ['A', 'B', 'C', 'D'], selectedSlot: null, answerChosen: false })
  assert.equal(p.confirmSlot, null)
})

test('8. parser proposed answer + option-text edit -> no confirmation', () => {
  const rows = fourRows(); rows[1].is_proposed_correct = true
  const p = planDraftEdit({ rows, formOptions: ['A', 'B edited', 'C', 'D'], selectedSlot: null, answerChosen: false })
  assert.equal(p.updates.length, 1)
  assert.equal(p.confirmSlot, null)
})

test('9. teacher explicitly selects the proposed option -> confirmation planned', () => {
  const rows = fourRows(); rows[1].is_proposed_correct = true
  const p = planDraftEdit({ rows, formOptions: ['A', 'B', 'C', 'D'], selectedSlot: 1, answerChosen: true })
  assert.equal(p.confirmSlot, 1)
  assert.equal(resolveSlotOptionId(1, rows, []), 'o1')
})

test('10. teacher explicitly selects a different option -> that option is confirmed', () => {
  const rows = fourRows(); rows[1].is_proposed_correct = true
  const p = planDraftEdit({ rows, formOptions: ['A', 'B', 'C', 'D'], selectedSlot: 3, answerChosen: true })
  assert.equal(p.confirmSlot, 3)
  assert.equal(resolveSlotOptionId(3, rows, []), 'o3')
})

test('11. existing confirmed answer + unrelated text edit -> confirmation unchanged', () => {
  const rows = fourRows(); rows[2].is_confirmed_correct = true
  // Edit opens with the confirmed slot pre-selected but not explicitly chosen.
  const p = planDraftEdit({ rows, formOptions: ['A', 'B', 'C', 'D changed'], selectedSlot: 2, answerChosen: false })
  assert.equal(p.confirmSlot, null, 'no confirm call, so existing confirmation is left intact')
  assert.equal(p.updates.length, 1)
})

test('choosing an empty slot with no row is blocked, not silently confirmed', () => {
  const p = planDraftEdit({ rows: [], formOptions: ['a', '', 'c', 'd'], selectedSlot: 1, answerChosen: true })
  assert.equal(p.confirmSlot, null)
  assert.equal(p.confirmBlocked, true)
})

test('optionRowsBySlot aligns rows by position, not array order', () => {
  const slots = optionRowsBySlot([row('o3', 3, 'D'), row('o0', 0, 'A')])
  assert.equal(slots[0].id, 'o0'); assert.equal(slots[3].id, 'o3')
  assert.equal(slots[1], null); assert.equal(slots[2], null)
})
