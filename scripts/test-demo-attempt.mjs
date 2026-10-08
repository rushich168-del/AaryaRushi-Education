import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createAttempt, updateAttempt, remainingSeconds, isValidAttempt, gradeAttempt } from '../src/features/tests/demoAttempt.js'

const paper = JSON.parse(fs.readFileSync(new URL('../src/data/tests/foundation-practice-test-1.json', import.meta.url)))
const key = JSON.parse(fs.readFileSync(new URL('../src/data/tests/foundation-practice-test-1-key.json', import.meta.url)))
const start = 1800000000000

test('25 original demo questions with a complete key', () => {
  assert.equal(paper.questions.length, 25)
  assert.deepEqual(paper.questions.map(q => q.id), Array.from({ length: 25 }, (_, i) => i + 1))
  assert.equal(paper.excludedQuestionCount, 0)
  assert.equal(key.teacherApproved, true)
  assert.equal(key.answers.length, 25)
  for (const q of paper.questions) {
    assert.equal(q.paragraphs.length, 5)
    assert.equal('answer' in q, false)
    assert.deepEqual(q.optionIds, [1, 2, 3, 4])
  }
  for (const a of key.answers) {
    assert.ok([1, 2, 3, 4].includes(a.option))
    assert.ok(a.explanation.length > 10)
  }
  const subjects = {}
  for (const q of paper.questions) subjects[q.subject] = (subjects[q.subject] || 0) + 1
  assert.deepEqual(Object.values(subjects), [5, 5, 5, 5, 5])
})

test('manual scoring reconciles correct, wrong and unanswered without fabricated marks', () => {
  let attempt = createAttempt(paper, start)
  attempt = updateAttempt(attempt, { type: 'answer', option: 3 }, paper, start + 1)
  attempt = updateAttempt(attempt, { type: 'navigate', index: 1 }, paper, start + 2)
  attempt = updateAttempt(attempt, { type: 'answer', option: 2 }, paper, start + 3)
  attempt = updateAttempt(attempt, { type: 'navigate', index: 23 }, paper, start + 4)
  attempt = updateAttempt(attempt, { type: 'answer', option: 2 }, paper, start + 5)
  assert.throws(() => gradeAttempt(paper, key, attempt), /Submit/)
  attempt = updateAttempt(attempt, { type: 'submit' }, paper, start + 6)
  const result = gradeAttempt(paper, key, attempt)
  assert.equal(result.score, 2)
  assert.equal(result.maximum, 25)
  assert.deepEqual(result.counts, { correct: 2, wrong: 1, unanswered: 22, 'needs-review': 0 })
  assert.equal(result.totalUnanswered, 22)
  assert.equal(result.answered, 3)
  assert.equal(Object.values(result.counts).reduce((a, b) => a + b), 25)
  assert.equal(updateAttempt(attempt, { type: 'answer', option: 4 }, paper, start + 7), attempt)
})

test('deadline wins over late answer or manual submit, including restored attempts', () => {
  const attempt = createAttempt(paper, start)
  assert.equal(remainingSeconds(attempt, start + 1), 1800)
  assert.equal(remainingSeconds(attempt, attempt.deadline), 0)
  const expired = updateAttempt(attempt, { type: 'answer', option: 4 }, paper, attempt.deadline + 60000)
  assert.equal(expired.submitReason, 'time-expired')
  assert.equal(expired.submittedAt, attempt.deadline)
  assert.deepEqual(expired.answers, {})
  assert.equal(isValidAttempt(JSON.parse(JSON.stringify(expired)), paper), true)
})

test('perfect, all wrong and blank attempts use the same maximum', () => {
  for (const mode of ['perfect', 'wrong', 'blank']) {
    const attempt = createAttempt(paper, start)
    if (mode !== 'blank') for (const entry of key.answers) {
      if (entry.option !== null) attempt.answers[entry.questionId] = mode === 'perfect' ? entry.option : entry.option % 4 + 1
    }
    const result = gradeAttempt(paper, key, updateAttempt(attempt, { type: 'submit' }, paper, start + 100))
    assert.equal(result.score, mode === 'perfect' ? 25 : 0)
    assert.equal(result.maximum, 25)
  }
})

test('clear/review/navigation and corrupt saved attempts are handled', () => {
  let attempt = createAttempt(paper, start)
  attempt = updateAttempt(attempt, { type: 'answer', option: 1 }, paper, start + 1)
  attempt = updateAttempt(attempt, { type: 'review' }, paper, start + 2)
  assert.deepEqual(attempt.review, [1])
  attempt = updateAttempt(attempt, { type: 'clear' }, paper, start + 3)
  assert.deepEqual(attempt.answers, {})
  assert.equal(isValidAttempt(attempt, paper), true)
  assert.equal(isValidAttempt({ ...attempt, answers: { 26: 1 } }, paper), false)
  assert.equal(isValidAttempt({ ...attempt, answers: { 1: 7 } }, paper), false)
  assert.equal(isValidAttempt({ ...attempt, currentIndex: 25 }, paper), false)
  assert.equal(isValidAttempt({ ...attempt, version: 'other' }, paper), false)
  assert.equal(isValidAttempt({ ...attempt, deadline: start + 1 }, paper), false)
})
