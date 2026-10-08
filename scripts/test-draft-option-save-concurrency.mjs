import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import { createSingleFlight, saveDraftQuestionEdit } from '../src/services/draftEditSave.js'

// Regression for duplicate draft_options rows at the same position caused by
// overlapping teacher Saves planning against a stale option snapshot.
// Uses an in-memory fake with async latency; no network, no Supabase.

function fakeStore({ rows = [], failInsertAfter = Infinity } = {}) {
  const db = { options: rows.map(r => ({ ...r })), inserts: 0, updates: 0, confirms: [] }
  const tick = () => new Promise(r => setTimeout(r, 5))
  const service = {
    async getDraftOptions(q) {
      await tick()
      return db.options.filter(o => o.qid === q).map(o => ({ ...o })).sort((a, b) => a.position - b.position)
    },
    async updateDraftQuestionText() { await tick() },
    async updateDraftOptionText(id, content) {
      await tick(); db.updates++
      db.options.find(o => o.id === id).content = content
    },
    async insertDraftOption(q, position, content) {
      await tick()
      if (db.inserts >= failInsertAfter) throw new Error('network error')
      const row = { id: `o${db.options.length + 1}`, qid: q, position, content, is_proposed_correct: false, is_confirmed_correct: false }
      db.options.push(row); db.inserts++
      return { id: row.id, position }
    },
    async confirmSingleChoice(q, optionId) {
      await tick(); db.confirms.push(optionId)
      for (const o of db.options) if (o.qid === q) o.is_confirmed_correct = o.id === optionId
    },
  }
  return { db, service }
}
const positions = db => db.options.map(o => o.position).sort()
const form = (options, extra = {}) => ({ question_text: 'Count the triangles', options, selectedSlot: null, answerChosen: false, ...extra })

test('rapid double Save causes one logical save operation', async () => {
  const { db, service } = fakeStore()
  const flight = createSingleFlight()
  const save = () => flight.run(() => saveDraftQuestionEdit({ questionId: 'q6', form: form(['15', '19', '22', '24']), service }))
  const first = save()
  const second = save() // clicked again while the first is still running
  assert.equal(second, null, 'second invocation is ignored')
  assert.equal(flight.busy, true)
  await first
  assert.equal(db.inserts, 4)
  assert.deepEqual(positions(db), [0, 1, 2, 3], 'no duplicate positions')
})

test('four missing option slots cause at most four inserts, even if saved again', async () => {
  const { db, service } = fakeStore()
  await saveDraftQuestionEdit({ questionId: 'q6', form: form(['15', '19', '22', '24']), service })
  // A second, sequential Save of the same (stale) form must not insert again.
  await saveDraftQuestionEdit({ questionId: 'q6', form: form(['15', '19', '22', '24']), service })
  assert.equal(db.inserts, 4)
  assert.deepEqual(positions(db), [0, 1, 2, 3])
})

test('existing option rows are updated, never duplicated', async () => {
  const rows = ['A', 'B', 'C', 'D'].map((c, i) => ({ id: `e${i}`, qid: 'q', position: i, content: c }))
  const { db, service } = fakeStore({ rows })
  await saveDraftQuestionEdit({ questionId: 'q', form: form(['A', 'B fixed', 'C', 'D']), service })
  assert.equal(db.inserts, 0)
  assert.equal(db.updates, 1)
  assert.equal(db.options.length, 4)
})

test('already-duplicated slots are not multiplied further (no deletion either)', async () => {
  const rows = [0, 0, 1, 1].map((p, i) => ({ id: `d${i}`, qid: 'q', position: p, content: String(p) }))
  const { db, service } = fakeStore({ rows })
  await saveDraftQuestionEdit({ questionId: 'q', form: form(['0', '1', '', '']), service })
  assert.equal(db.inserts, 0, 'no new rows for occupied positions; blank slots create nothing')
  assert.equal(db.options.length, 4, 'existing duplicates are left for separate repair')
})

test('a failed save unlocks for retry, and the retry fills only the missing slots', async () => {
  const { db, service } = fakeStore({ failInsertAfter: 2 })
  const flight = createSingleFlight()
  const f = form(['15', '19', '22', '24'])
  await assert.rejects(flight.run(() => saveDraftQuestionEdit({ questionId: 'q6', form: f, service })), /network error/)
  assert.equal(flight.busy, false, 'unlocked after failure')
  assert.equal(db.inserts, 2, 'partial save persisted two slots')
  // Restore a working insert that writes into the same store.
  service.insertDraftOption = async (q, position, content) => {
    const row = { id: `o${db.options.length + 1}`, qid: q, position, content, is_proposed_correct: false, is_confirmed_correct: false }
    db.options.push(row); db.inserts++
    return { id: row.id, position }
  }
  const retry = flight.run(() => saveDraftQuestionEdit({ questionId: 'q6', form: f, service }))
  assert.notEqual(retry, null, 'retry is accepted')
  await retry
  assert.deepEqual(positions(db), [0, 1, 2, 3], 'retry inserted only the two missing slots')
})

test('answer confirmation still happens only from explicit teacher selection', async () => {
  const { db, service } = fakeStore()
  await saveDraftQuestionEdit({ questionId: 'q', form: form(['15', '19', '22', '24'], { selectedSlot: 1, answerChosen: false }), service })
  assert.deepEqual(db.confirms, [], 'pre-selected but not chosen: no confirmation')
  await saveDraftQuestionEdit({ questionId: 'q', form: form(['15', '19', '22', '24'], { selectedSlot: 2, answerChosen: true }), service })
  const chosen = db.options.find(o => o.position === 2)
  assert.deepEqual(db.confirms, [chosen.id], 'explicit choice confirms the row at that slot')
})

test('choosing an empty slot writes nothing', async () => {
  const { db, service } = fakeStore()
  const r = await saveDraftQuestionEdit({ questionId: 'q', form: form(['a', '', 'c', 'd'], { selectedSlot: 1, answerChosen: true }), service })
  assert.equal(r.status, 'CONFIRM_BLOCKED')
  assert.equal(db.inserts, 0)
})

test('Workspace wires the guard: single-flight, disabled button, Saving…, fresh rows', () => {
  const src = fs.readFileSync('src/components/site/PdfImportWorkspace.jsx', 'utf8')
  const handler = src.slice(src.indexOf('const handleSaveEdit ='), src.indexOf('// Teacher-approved resolution of one conflicting slot'))
  assert.match(handler, /editSaveFlight\.current\.run\(/)
  assert.match(handler, /saveDraftQuestionEdit\(/)
  assert.ok(!/c\.optionRows/.test(handler), 'edit save no longer plans from the card snapshot')
  assert.match(handler, /finally \{\s+setSavingEdit\(false\)/, 'unlocks after success or failure')
  assert.match(src, /disabled=\{savingEdit\}/)
  assert.match(src, /savingEdit \? 'Saving…' : 'Save'/)
  assert.match(src, /const handleSaveNewQuestion = \(\) => newSaveFlight\.current\.run\(/, 'B1 new-question save is single-flight too')
})
