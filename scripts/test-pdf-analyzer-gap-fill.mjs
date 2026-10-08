import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'

// Regression: the consistency check used to clear the candidates array after
// fillNumberingGaps returned that same array, wiping every candidate before
// persistence. Follows the repo convention of extracting logic from source.
const source = fs.readFileSync('src/services/pdfAnalyzer.js', 'utf8')

const sig = 'fillNumberingGaps(candidates) {'
const start = source.indexOf(sig) + sig.length
const end = source.indexOf('\n  },', start)
const fillNumberingGaps = new Function('candidates', source.substring(start, end))

// The call site as it exists in runPrototypeAnalysis.
const consistencyCheck = candidates => { fillNumberingGaps(candidates) }

const cand = (n, extra = {}) => ({ question_number: n, question_text: `Q${n}`, warnings: [], ...extra })

test('call site no longer clears the candidates array after gap filling', () => {
  const callIdx = source.indexOf('this.fillNumberingGaps(candidates)')
  assert.ok(callIdx > 0, 'gap fill is still invoked')
  const after = source.substring(callIdx, callIdx + 300)
  assert.ok(!/candidates\.length\s*=\s*0/.test(after), 'no truncation after gap fill')
})

test('non-empty candidate array remains non-empty and candidates survive', () => {
  const candidates = [cand('1'), cand('2'), cand('3')]
  const originals = [...candidates]
  consistencyCheck(candidates)
  assert.equal(candidates.length, 3)
  originals.forEach((c, i) => assert.equal(candidates[i], c, 'same candidate objects survive in order'))
})

test('numbering gaps are flagged and the flagged candidate survives', () => {
  // fillNumberingGaps flags gaps with a warning; it does not insert placeholder rows.
  const candidates = [cand('1'), cand('2'), cand('5')]
  consistencyCheck(candidates)
  assert.equal(candidates.length, 3)
  assert.ok(candidates[2].warnings.some(w => w.startsWith('QUESTION_ORDER_SUSPICIOUS')), 'gap warning kept')
  assert.equal(candidates[0].warnings.length, 0)
})

test('single fallback candidate survives', () => {
  const candidates = [cand('?', { question_text: 'Failed to extract any structured questions.', status: 'UNRESOLVED' })]
  consistencyCheck(candidates)
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].question_number, '?')
})

test('no candidate is duplicated', () => {
  const candidates = [cand('1'), cand('3'), cand('4')]
  consistencyCheck(candidates)
  assert.equal(candidates.length, 3)
  assert.equal(new Set(candidates).size, 3)
})
