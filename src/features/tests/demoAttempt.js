// Local demonstration state only. Production timing, grading and ownership belong on the server.
export const storageKey = test => `ksc.demo.${test.id}.${test.version}`

export function createAttempt(test, now = Date.now()) {
  return { version: test.version, testId: test.id, status: 'in-progress', startedAt: now,
    deadline: now + test.durationSeconds * 1000, submittedAt: null, submitReason: null,
    answers: {}, review: [], currentIndex: 0 }
}

export function isValidAttempt(value, test) {
  if (!value || value.version !== test.version || value.testId !== test.id) return false
  if (!['in-progress', 'submitted'].includes(value.status)) return false
  if (!Number.isFinite(value.startedAt) || value.startedAt <= 0 || !Number.isFinite(value.deadline) || value.deadline !== value.startedAt + test.durationSeconds * 1000) return false
  if (!Number.isInteger(value.currentIndex) || value.currentIndex < 0 || value.currentIndex >= test.questions.length) return false
  if (!value.answers || typeof value.answers !== 'object' || Array.isArray(value.answers) || !Array.isArray(value.review)) return false
  const ids = new Set(test.questions.map(q => String(q.id)))
  if (!Object.entries(value.answers).every(([id, option]) => ids.has(id) && test.questions.find(q => String(q.id) === id).optionIds.includes(option))) return false
  if (!value.review.every(id => Number.isInteger(id) && ids.has(String(id))) || new Set(value.review).size !== value.review.length) return false
  if (value.status === 'submitted') return Number.isFinite(value.submittedAt) && value.submittedAt >= value.startedAt && value.submittedAt <= value.deadline && ['manual', 'time-expired'].includes(value.submitReason)
  return value.submittedAt === null && value.submitReason === null
}

export function remainingSeconds(attempt, now = Date.now()) {
  return Math.max(0, Math.ceil((attempt.deadline - now) / 1000))
}

export function updateAttempt(attempt, action, test, now = Date.now()) {
  if (!attempt || attempt.status === 'submitted') return attempt
  if (now >= attempt.deadline) return { ...attempt, status: 'submitted', submittedAt: attempt.deadline, submitReason: 'time-expired' }
  if (action.type === 'submit') return { ...attempt, status: 'submitted', submittedAt: now, submitReason: 'manual' }
  if (action.type === 'navigate' && Number.isInteger(action.index) && action.index >= 0 && action.index < test.questions.length) return { ...attempt, currentIndex: action.index }
  const question = test.questions[attempt.currentIndex]
  if (action.type === 'answer' && question.optionIds.includes(action.option)) return { ...attempt, answers: { ...attempt.answers, [question.id]: action.option } }
  if (action.type === 'clear') {
    const answers = { ...attempt.answers }
    delete answers[question.id]
    return { ...attempt, answers }
  }
  if (action.type === 'review') return { ...attempt, review: attempt.review.includes(question.id) ? attempt.review.filter(id => id !== question.id) : [...attempt.review, question.id] }
  return attempt
}

export function gradeAttempt(test, key, attempt) {
  if (attempt?.status !== 'submitted') throw new Error('Submit the test before opening the answer key.')
  if (test.keyVersion !== key.version) throw new Error('The answer key version has changed.')
  const byId = new Map(key.answers.map(answer => [answer.questionId, answer]))
  if (byId.size !== test.questions.length) throw new Error('The answer key is incomplete.')
  const rows = test.questions.map(question => {
    const answer = byId.get(question.id)
    if (!answer || (answer.option !== null && !question.optionIds.includes(answer.option))) throw new Error('Invalid answer key entry.')
    const selected = attempt.answers[question.id] ?? null
    const status = answer.option === null ? 'needs-review' : selected === null ? 'unanswered' : selected === answer.option ? 'correct' : 'wrong'
    return { question, answer, selected, status }
  })
  const counts = { correct: 0, wrong: 0, unanswered: 0, 'needs-review': 0 }
  for (const row of rows) counts[row.status]++
  const maximum = (rows.length - counts['needs-review']) * test.marksPerCorrect
  return { rows, counts, maximum, score: counts.correct * test.marksPerCorrect - counts.wrong * test.negativeMarks,
    answered: Object.keys(attempt.answers).length, totalUnanswered: rows.length - Object.keys(attempt.answers).length }
}
