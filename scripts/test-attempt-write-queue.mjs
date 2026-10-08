import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAttemptWriteQueue } from '../src/services/attemptWriteQueue.js'

const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const tick = () => new Promise(resolve => setImmediate(resolve))

test('rapid answers save in order; duplicate submit drains saves and finalizes once', async () => {
  const first = deferred(), calls = []
  const queue = createAttemptWriteQueue({
    save: async (id, answer) => { calls.push(answer.selected_option_id); if (calls.length === 1) await first.promise },
    finalize: async () => calls.push('submit')
  })
  queue.enqueue('q', { selected_option_id: 'a' })
  queue.enqueue('q', { selected_option_id: 'b', is_marked_for_review: true })
  await tick()
  const submit = queue.submit()
  assert.equal(queue.submit(), submit)
  assert.equal(queue.enqueue('q', { selected_option_id: 'c' }), false)
  assert.deepEqual(calls, ['a'])
  first.resolve()
  await submit
  assert.deepEqual(calls, ['a', 'b', 'submit'])
  assert.equal(queue.state().unsaved, 0)
})

test('a failed answer stays unsaved after another question succeeds; retry precedes submit', async () => {
  let fail = true, submissions = 0
  const stored = new Map()
  const queue = createAttemptWriteQueue({
    save: async (id, answer) => { if (id === 'q1' && fail) throw Error('Offline'); stored.set(id, answer) },
    finalize: async () => submissions++
  })
  queue.enqueue('q1', { selected_option_id: 'a' })
  queue.enqueue('q2', { selected_option_id: 'b' })
  await assert.rejects(queue.submit(), /not saved/)
  assert.equal(queue.state().unsaved, 1)
  assert.equal(submissions, 0)
  fail = false
  await queue.retry()
  await queue.submit()
  assert.equal(stored.get('q1').selected_option_id, 'a')
  assert.equal(submissions, 1)
})

test('clear and review flag persist as the latest complete answer after an earlier failure', async () => {
  let count = 0, stored
  const queue = createAttemptWriteQueue({
    save: async (id, answer) => { if (++count === 1) throw Error('Offline'); stored = answer },
    finalize: async () => {}
  })
  queue.enqueue('q', { selected_option_id: 'a' })
  queue.enqueue('q', { selected_option_id: null, is_marked_for_review: true })
  await queue.submit()
  assert.deepEqual(stored, { selected_option_id: null, is_marked_for_review: true })
  assert.equal(queue.state().unsaved, 0)
})

test('expiry skips queued writes, drains an in-flight request, and can retry finalization', async () => {
  const first = deferred(), calls = []
  let offline = true
  const queue = createAttemptWriteQueue({
    save: async (id, answer) => { calls.push(answer.selected_option_id); await first.promise },
    finalize: async () => { calls.push('submit'); if (offline) throw Error('Offline') }
  })
  queue.enqueue('q', { selected_option_id: 'a' })
  queue.enqueue('q', { selected_option_id: 'b' })
  await tick()
  const submit = queue.submit({ deadlineReached: true })
  first.reject(Error('Expired'))
  await assert.rejects(submit, /Offline/)
  assert.deepEqual(calls, ['a', 'submit'])
  assert.equal(queue.enqueue('q', { selected_option_id: 'c' }), false)
  assert.equal(queue.state().unsaved, 1)
  offline = false
  await queue.submit({ deadlineReached: true })
  assert.deepEqual(calls, ['a', 'submit', 'submit'])
})

test('expiry during manual save drain uses the same finalization request', async () => {
  const save = deferred()
  let finalized = 0
  const queue = createAttemptWriteQueue({ save: () => save.promise, finalize: async () => finalized++ })
  queue.enqueue('q', {})
  await tick()
  const manual = queue.submit()
  assert.equal(queue.submit({ deadlineReached: true }), manual)
  save.reject(Error('Expired'))
  await manual
  assert.equal(finalized, 1)
})

test('closing the view cancels queued work and ignores completion notifications', async () => {
  const first = deferred()
  let saves = 0, notifications = 0, finalized = 0
  const queue = createAttemptWriteQueue({ save: async () => { saves++; await first.promise },
    finalize: async () => finalized++, onChange: () => notifications++ })
  queue.enqueue('q1', {})
  queue.enqueue('q2', {})
  await tick()
  const submission = queue.submit()
  queue.dispose()
  const previous = notifications
  first.resolve()
  await assert.rejects(submission, /view closed/)
  assert.equal(saves, 1)
  assert.equal(finalized, 0)
  assert.equal(notifications, previous)
})

test('ambiguous submit failure retries finalization without replaying accepted answers', async () => {
  let saves = 0, finalized = 0
  const queue = createAttemptWriteQueue({ save: async () => saves++, finalize: async () => {
    if (++finalized === 1) throw Error('Response lost')
  } })
  queue.enqueue('q', { selected_option_id: 'a' })
  await assert.rejects(queue.submit(), /Response lost/)
  assert.equal(queue.enqueue('q', { selected_option_id: 'b' }), false)
  assert.equal(queue.state().confirmationPending, true)
  await queue.submit()
  assert.equal(saves, 1)
  assert.equal(finalized, 2)
})
