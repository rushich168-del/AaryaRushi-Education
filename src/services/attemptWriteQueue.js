// One coordinator per mounted attempt. Backend RPCs remain authoritative.
export function createAttemptWriteQueue({ save, finalize, onChange = () => {} }) {
  let tail = Promise.resolve()
  let revision = 0
  let pending = 0
  let expired = false
  let disposed = false
  let finished = false
  let confirmationPending = false
  let submission = null
  let submitError = ''
  const dirty = new Map()

  const state = () => ({ pending, unsaved: dirty.size, expired,
    submitting: submission !== null, confirmationPending, finished, submitError })
  const notify = () => { if (!disposed) onChange(state()) }

  function schedule(questionId, answer) {
    const entry = { answer: { ...answer }, revision: ++revision }
    dirty.set(questionId, entry)
    pending++
    tail = tail.then(async () => {
      try {
        if (disposed || expired || finished) return
        await save(questionId, entry.answer)
        if (dirty.get(questionId)?.revision === entry.revision) dirty.delete(questionId)
      } catch {
        // Keep the newest visible intent dirty until that exact revision succeeds.
      } finally {
        pending--
        notify()
      }
    })
    notify()
    return tail
  }

  return {
    state,
    enqueue(questionId, answer) {
      if (disposed || expired || finished || submission || confirmationPending) return false
      submitError = ''
      schedule(questionId, answer)
      return true
    },
    retry() {
      if (disposed || expired || finished || submission || confirmationPending || pending) return tail
      submitError = ''
      for (const [id, entry] of [...dirty]) schedule(id, entry.answer)
      return tail
    },
    submit({ deadlineReached = false } = {}) {
      if (disposed) return Promise.reject(new Error('Attempt view closed'))
      if (deadlineReached) expired = true
      if (submission) { notify(); return submission }
      if (finished) return Promise.resolve()
      submitError = ''
      // Install the lock before notifying or awaiting any save.
      submission = Promise.resolve().then(async () => {
        await tail
        if (disposed) throw new Error('Attempt view closed')
        if (dirty.size && !expired) throw new Error('Some answers are not saved. Retry saving before submitting.')
        // A lost response can mean the server already finalized. Keep edits locked.
        confirmationPending = true
        await finalize()
        confirmationPending = false
        finished = true
      }).catch(error => {
        submitError = error.message || 'Submission failed. Please retry.'
        throw error
      }).finally(() => {
        submission = null
        notify()
      })
      notify()
      return submission
    },
    dispose() { disposed = true }
  }
}
