import { test } from 'node:test'
import assert from 'node:assert'
import { pdfAnalyzer } from '../src/services/pdfAnalyzer.js'

test('Column-Aware Layout Reconstruction', async (t) => {

  const W = 600

  await t.test('single-column page', () => {
    const bands = [
      { y: 700, items: [{ text: 'Question 1', x: 50, width: 200, right: 250 }] },
      { y: 650, items: [{ text: 'Question 2', x: 50, width: 100, right: 150 }] } // short line
    ]
    const res = pdfAnalyzer.reconstructLayout(bands, W)
    assert.strictEqual(res.length, 2)
    assert.strictEqual(res[0].text, 'Question 1')
    assert.strictEqual(res[1].text, 'Question 2')
  })

  await t.test('two-column page interleaving', () => {
    // Q1 and Q6 share Y=700
    // Q2 and Q7 share Y=600
    const bands = [
      { y: 700, items: [
        { text: '1. Left Q1', x: 50, width: 100, right: 150 },
        { text: '6. Right Q6', x: 350, width: 100, right: 450 }
      ]},
      { y: 600, items: [
        { text: '2. Left Q2', x: 50, width: 100, right: 150 },
        { text: '7. Right Q7', x: 350, width: 100, right: 450 }
      ]}
    ]
    const res = pdfAnalyzer.reconstructLayout(bands, W)
    assert.strictEqual(res.length, 4)
    assert.strictEqual(res[0].text, '1. Left Q1')
    assert.strictEqual(res[1].text, '2. Left Q2')
    assert.strictEqual(res[2].text, '6. Right Q6')
    assert.strictEqual(res[3].text, '7. Right Q7')
  })

  await t.test('full-width heading + two-column body', () => {
    const bands = [
      { y: 800, items: [
        { text: 'Directions: Answer the following', x: 200, width: 250, right: 450 }
      ]},
      { y: 700, items: [
        { text: '3. Q3', x: 50, width: 50, right: 100 },
        { text: '5. Q5', x: 350, width: 50, right: 400 }
      ]},
      { y: 600, items: [
        { text: '4. Q4', x: 50, width: 50, right: 100 },
        { text: '6. Q6', x: 350, width: 50, right: 400 }
      ]}
    ]
    const res = pdfAnalyzer.reconstructLayout(bands, W)
    assert.strictEqual(res.length, 5)
    assert.strictEqual(res[0].text, 'Directions: Answer the following')
    assert.strictEqual(res[1].text, '3. Q3')
    assert.strictEqual(res[2].text, '4. Q4')
    assert.strictEqual(res[3].text, '5. Q5')
    assert.strictEqual(res[4].text, '6. Q6')
  })
})

test('Numbering Gap Detection (fillNumberingGaps)', async (t) => {
  await t.test('sequential numbers: no gap warning', () => {
    const candidates = [
      { question_number: '1', warnings: [] },
      { question_number: '2', warnings: [] }
    ]
    const res = pdfAnalyzer.fillNumberingGaps(candidates)
    assert.strictEqual(res.length, 2)
    assert.strictEqual(res[1].warnings.length, 0)
  })

  await t.test('9 -> 11: missing 10 warning', () => {
    const candidates = [
      { question_number: '9', warnings: [] },
      { question_number: '11', warnings: [], source_page: 2 }
    ]
    const res = pdfAnalyzer.fillNumberingGaps(candidates)
    assert.strictEqual(res.length, 2)
    assert.strictEqual(res[0].question_number, '9')
    assert.strictEqual(res[1].question_number, '11')
    assert.ok(res[1].warnings[0].includes('QUESTION_ORDER_SUSPICIOUS'))
  })
})
