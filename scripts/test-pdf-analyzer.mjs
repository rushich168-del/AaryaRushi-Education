import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'

const source = fs.readFileSync('src/services/pdfAnalyzer.js', 'utf8')
// Extract the function body of applyAnswerKeyMappings
const startIndex = source.indexOf('applyAnswerKeyMappings(keyText, hasKeySection, candidates) {') + 'applyAnswerKeyMappings(keyText, hasKeySection, candidates) {'.length
const endIndex = source.lastIndexOf('}') // last brace is for pdfAnalyzer object, one before is for function
const fnBody = source.substring(startIndex, source.lastIndexOf('}', endIndex - 1))
const applyAnswerKeyMappings = new Function('keyText', 'hasKeySection', 'candidates', fnBody)

test('Answer Key Parsing Logic', async (t) => {

  await t.test('A. "KEY" text alone does not assign index 0', () => {
    const candidates = [{ question_number: '1', proposed_correct_index: null }]
    const keyText = 'Here is the ANSWER KEY for the test. Good luck!'
    
    applyAnswerKeyMappings(keyText, true, candidates)
    
    assert.equal(candidates[0].proposed_correct_index, null, 'Unmapped question remains null')
    assert.equal(candidates[0].status, 'UNRESOLVED', 'Status is marked UNRESOLVED')
    assert.ok(candidates[0].warnings.join('').includes('no explicit mapping found'), 'Warning indicates no mapping')
  })

  await t.test('B. Explicit 1 - A maps to index 0', () => {
    const candidates = [{ question_number: '1', proposed_correct_index: null }]
    const keyText = 'ANSWER KEY \n 1 - A \n 2 - B'
    
    applyAnswerKeyMappings(keyText, true, candidates)
    
    assert.equal(candidates[0].proposed_correct_index, 0, '1 - A maps to 0')
    assert.ok(candidates[0].warnings.join('').includes('explicitly mapped'), 'Has mapping warning')
  })

  await t.test('C. Explicit 2 = C maps to index 2', () => {
    const candidates = [{ question_number: '2', proposed_correct_index: null }]
    const keyText = 'ANSWERS: 1=D, 2=C, 3=B'
    
    applyAnswerKeyMappings(keyText, true, candidates)
    
    assert.equal(candidates[0].proposed_correct_index, 2, '2 = C maps to 2')
  })

  await t.test('D. Unmapped question remains null', () => {
    const candidates = [
      { question_number: '1', proposed_correct_index: null },
      { question_number: '2', proposed_correct_index: null }
    ]
    // Only maps question 1
    const keyText = '1 -> 3'
    
    applyAnswerKeyMappings(keyText, false, candidates)
    
    // Q1 maps to index 2 (option 3)
    assert.equal(candidates[0].proposed_correct_index, 2, '1 -> 3 maps to index 2')
    
    // Q2 remains null
    assert.equal(candidates[1].proposed_correct_index, null, 'Unmapped Q2 remains null')
    assert.equal(candidates[1].status, 'UNRESOLVED')
  })

})
