import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import { parseOptions, extractEnglishStem, parseMaterialRange, extractMaterials, readingCompare } from './lib/paper-layout.mjs'
import { mapPaperModelToDraft } from './lib/paper-model-to-draft.mjs'

// B4.2R — Draft construction repair: the stem and the options are separate structural fields,
// and shared Directions blocks become explicit materials. Pure tests (synthetic lines) plus
// golden checks over reports/b41-paper-model.json when it exists.

const it_ = (str, x, extra = {}) => ({ str, x, width: Math.max(8, str.length * 5), height: 10, fontName: 'en', ...extra })
const line = (page, column, y, items, extra = {}) => {
  const l = { page, column, y, items, ...extra }
  l.text = items.map(i => i.str).join(' ')
  l.x = Math.min(...items.map(i => i.x))
  l.right = Math.max(...items.map(i => i.x + i.width))
  return l
}

test('stem stops at the option set and excludes the question number and Telugu-line fragments', () => {
  const lines = [
    line(2, 0, 800, [it_('1.', 28), it_('How many words can be formed', 54)]),
    line(2, 0, 786, [it_('with the letters LEGU?', 54)]),
    line(2, 0, 772, [it_('A) None', 54), it_('B) One', 150)]),
    line(2, 0, 758, [it_('C) Two', 54), it_('D) Three', 150)]),
    line(2, 0, 740, [it_('LEGU', 54)], { fromMixedLine: true }),        // Latin fragment of a Telugu line
    line(2, 0, 700, [it_('A)', 54), it_('B)', 150)], { fromMixedLine: true }),
  ]
  const parsed = parseOptions(lines, { numberX: 28 })
  assert.deepEqual(parsed.options.map(o => `${o.marker}:${o.text}`), ['A:None', 'B:One', 'C:Two', 'D:Three'])
  assert.equal(extractEnglishStem(lines, parsed.stemBoundary, { numberX: 28 }), 'How many words can be formed with the letters LEGU?')
})

test('an inline question number is stripped only from the first token', () => {
  const lines = [line(2, 0, 800, [it_('5. Statement A: 40 passengers', 28)]), line(2, 0, 786, [it_('A) x', 54), it_('B) y', 150)]),
    line(2, 0, 772, [it_('C) z', 54), it_('D) w', 150)])]
  const parsed = parseOptions(lines, { numberX: 28 })
  assert.equal(extractEnglishStem(lines, parsed.stemBoundary, { numberX: 28 }), 'Statement A: 40 passengers')
})

test('a stem at the bottom of column 1 is never claimed by an option at the top of column 2', () => {
  const lines = [
    line(5, 0, 60, [it_('24.', 28), it_('In an open ground, Rakesh walks', 54)]),
    line(5, 0, 46, [it_('20 m towards North.', 54)]),
    line(5, 1, 800, [it_('A) 10 m', 330), it_('B) 20 m', 427)]),
    line(5, 1, 786, [it_('C) 30 m', 330), it_('D) 40 m', 427)]),
  ]
  const parsed = parseOptions(lines, { numberX: 28 })
  assert.equal(parsed.options.find(o => o.marker === 'D').text, '40 m')
  assert.equal(extractEnglishStem(lines, parsed.stemBoundary, { numberX: 28 }), 'In an open ground, Rakesh walks 20 m towards North.')
  assert.ok(readingCompare(lines[1], lines[2]) < 0, 'column 1 precedes column 2 in reading order')
})

test('a full-width line under a two-up option row is not that option\'s continuation', () => {
  const lines = [
    line(7, 0, 100, [it_('34.', 28), it_('If 13 L 4 = 41 then 12 L 3 = ?', 54)]),
    line(7, 0, 86, [it_('A) 84', 54), it_('B) 42', 150)]),
    line(7, 0, 72, [it_('C) 39', 54), it_('D) 56', 150)]),
    line(7, 0, 58, [it_('Study the following statements carefully.', 54)]),
  ]
  const parsed = parseOptions(lines, { numberX: 28 })
  assert.equal(parsed.options.find(o => o.marker === 'D').text, '56')
  assert.equal(parsed.unassignedAfterOptions, 'Study the following statements carefully.', 'kept and flagged, never dropped')
})

test('match-the-following: "A." list labels stay in the stem; the "A)" set is the option set', () => {
  const lines = [
    line(15, 0, 500, [it_('102.', 28), it_('Match the list-1 items with the list-2 items?', 54)]),
    line(15, 0, 486, [it_('A. Aravalli', 54), it_('1. Dhupghar', 203)]),
    line(15, 0, 472, [it_('B. Satpura', 54), it_('2. Gurushikar', 206)]),
    line(15, 0, 458, [it_('C. Nilgiri', 54), it_('3. Anaimudi', 201)]),
    line(15, 0, 444, [it_('D. Annamalai', 54), it_('4. Dodabetta', 202)]),
    line(15, 0, 430, [it_('A) A-1, B-2, C-3, D-4', 54)]),
    line(15, 0, 416, [it_('B) A-2, B-1, C-4, D-3', 54)]),
    line(15, 0, 402, [it_('C) A-3, B-2, C-1, D-4', 54)]),
    line(15, 0, 388, [it_('D) A-2, B-4, C-1, D-3', 54)]),
  ]
  const parsed = parseOptions(lines, { numberX: 28 })
  assert.deepEqual(parsed.options.map(o => o.text), ['A-1, B-2, C-3, D-4', 'A-2, B-1, C-4, D-3', 'A-3, B-2, C-1, D-4', 'A-2, B-4, C-1, D-3'])
  assert.equal(parsed.duplicates, 0)
  const stem = extractEnglishStem(lines, parsed.stemBoundary, { numberX: 28 })
  assert.match(stem, /A\. Aravalli 1\. Dhupghar .* D\. Annamalai 4\. Dodabetta$/)
})

test('material ranges come only from heading evidence', () => {
  assert.deepEqual(parseMaterialRange('Directions (Q. Nos. 31-33): Study the following'), { covers: [31, 32, 33], rangeSource: 'HEADING_RANGE' })
  assert.deepEqual(parseMaterialRange('Directions (Q. No.s 11 and 12): Study the diagram'), { covers: [11, 12], rangeSource: 'HEADING_RANGE' })
  assert.deepEqual(parseMaterialRange('Directions (81-84 Q. No.s): Read the passage'), { covers: [81, 82, 83, 84], rangeSource: 'HEADING_RANGE' })
  assert.deepEqual(parseMaterialRange('Directions: In the question are given two statements'), { covers: null, rangeSource: 'SINGULAR_NEXT_QUESTION' })
  assert.deepEqual(parseMaterialRange('Directions: Read the following carefully.'), { covers: [], rangeSource: 'UNKNOWN' })
})

test('unowned Directions blocks become materials; unclear or non-adjacent ranges are never linked', () => {
  const q = (n, page, y) => ({ number: n, lines: [line(page, 0, y, [it_(`${n}.`, 28), it_(`Question ${n}`, 54)])] })
  const d1 = line(3, 0, 700, [it_('Directions (Q. Nos. 11 and 12): Study the diagram.', 28)])
  const d2 = line(3, 0, 600, [it_('Directions: Read the following carefully.', 28)])
  const d3 = line(3, 0, 500, [it_('Directions (Q. Nos. 40-41): Wrong range.', 28)])
  const q10 = q(10, 3, 750), q11 = q(11, 3, 680), q12 = q(12, 3, 650), q13 = q(13, 3, 580), q14 = q(14, 3, 480)
  const ordered = [...q10.lines, d1, ...q11.lines, ...q12.lines, d2, ...q13.lines, d3, ...q14.lines]
  const mats = extractMaterials(ordered, [q10, q11, q12, q13, q14], new Map())
  assert.equal(mats.length, 3)
  assert.deepEqual(mats[0].covers, [11, 12]); assert.equal(mats[0].rangeSource, 'HEADING_RANGE')
  assert.deepEqual(mats[1].covers, []); assert.ok(mats[1].reviewReasons.includes('MATERIAL_RANGE_UNKNOWN'))
  assert.deepEqual(mats[2].covers, []); assert.ok(mats[2].reviewReasons.some(r => r.startsWith('MATERIAL_RANGE_NOT_ADJACENT')))
  assert.equal(mats[0].sourceRegions[0].page, 3)
})

// ---------- golden (the real paper's model) --------------------------------------------------
const MODEL = 'reports/b41-paper-model.json'
const HAVE = fs.existsSync(MODEL)
const model = HAVE ? JSON.parse(fs.readFileSync(MODEL, 'utf8')) : null
const golden = { skip: !HAVE && 'run scripts/b41-analyze-paper.mjs first' }
const byNumber = n => model.questions.find(q => q.number === n)

// B4.8.2: 197 -> 200 with four options (Q115/Q126/Q135 printed the next marker inside an option; the
// provable split recovers it). Q28 (D already present as a separate empty marker) is NOT split.
test('golden: 200 questions in order, 200 with four options, 200 proposed answers from the key', golden, () => {
  assert.deepEqual(model.questions.map(q => q.number), Array.from({ length: 200 }, (_, i) => i + 1))
  assert.equal(model.questions.filter(q => q.options.length === 4).length, 200)
  assert.equal(model.questions.filter(q => q.proposedAnswer).length, 200)
  const key = new Map(model.answerKey.entries.map(e => [e.number, e.letter]))
  assert.ok(model.questions.every(q => q.proposedAnswer.letter === key.get(q.number)), 'answer mappings come straight from the key page')
})

test('golden: no stem carries option markers or option text; only Q3 (no printed stem) is empty', golden, () => {
  const leaking = model.questions.filter(q => /(^|\s)[A-D]\)/.test(q.englishStem))
  assert.deepEqual(leaking.map(q => q.number), [])
  const withOptionTail = model.questions.filter(q => q.options.length === 4 && q.options.every(o => o.text) &&
    q.englishStem.endsWith(q.options[3].text) && q.options[3].text.length > 3)
  assert.deepEqual(withOptionTail.map(q => q.number), [])
  assert.deepEqual(model.questions.filter(q => !q.englishStem).map(q => q.number), [3])
})

test('golden: named questions', golden, () => {
  assert.equal(byNumber(1).englishStem, 'How many meaning ful English words can be formed with the letters LEGU, using each letter only once in each word?')
  assert.deepEqual(byNumber(6).options.map(o => o.text), ['15', '19', '22', '24'])
  assert.equal(byNumber(6).englishStem, 'Count the number of triangles in the figure given below.')
  assert.equal(byNumber(6).proposedAnswer.letter, 'D')
  assert.deepEqual(byNumber(10).pages, [2, 3])
  assert.equal(byNumber(10).options.length, 4)
  assert.match(byNumber(10).englishStem, /^Assertion \(A\): Too much work causes stress\. Reason \(R\):.*given codes:$/)
  assert.equal(byNumber(24).options.find(o => o.marker === 'D').text, '40 m')
  assert.deepEqual(byNumber(102).options.map(o => o.text)[0], 'A-1, B-2, C-3, D-4')
})

test('golden: the 11 Directions blocks become materials covering the 24 questions', golden, () => {
  assert.equal(model.materials.length, 11)
  assert.deepEqual(model.materials.map(m => m.covers), [[5], [11, 12], [13, 14], [15], [22], [25], [30], [31, 32, 33], [36, 37, 38, 39], [71, 72, 73, 74], [81, 82, 83, 84]])
  assert.deepEqual(model.materials.map(m => m.materialType), ['INSTRUCTIONS', 'DIAGRAM', 'OTHER', 'INSTRUCTIONS', 'INSTRUCTIONS', 'INSTRUCTIONS', 'INSTRUCTIONS', 'INSTRUCTIONS', 'CHART', 'CHART', 'PASSAGE'])   // M7 heading is hyphenated ("infor- mation")
  const passage = model.materials[10]
  assert.match(passage.englishText, /Nearly a century ago, biologists/)
  assert.match(passage.englishText, /beaded DNA strings that guide the fate of the cells in which they are located\.$/)
  assert.equal(model.questions.filter(q => q.sharedMaterialIndex !== undefined).length, 24)
  for (const n of [81, 82, 83, 84]) assert.equal(byNumber(n).sharedMaterialIndex, 10)
  assert.ok(model.materials.every(m => m.sourceRegions.length && m.pages.length))
})

test('golden: the mapper stores the stem only and links questions to shared materials', golden, () => {
  const manifest = fs.existsSync('reports/b43/b43-manifest.json') ? JSON.parse(fs.readFileSync('reports/b43/b43-manifest.json', 'utf8')) : null
  const p = mapPaperModelToDraft(model, { importId: 'x', visuals: manifest })
  assert.equal(p.questions.length, 200)
  assert.equal(p.materials.length, 11)
  const materialIds = new Set(p.materials.map(m => m.id))
  const linked = p.questions.filter(q => q.shared_material_id)
  assert.equal(linked.length, 24)
  assert.ok(linked.every(q => materialIds.has(q.shared_material_id)))
  p.questions.forEach((q, i) => assert.equal(q.content, model.questions[i].englishStem || null))
  assert.equal(p.options.filter(o => o.is_proposed_correct).length, 200)   // B4.8.2: Q126's key letter D now has its option (was 199)
  assert.equal(p.options.filter(o => o.is_confirmed_correct).length, 0)
  if (manifest) {
    const venn = p.materials[1]
    assert.equal(venn.content_text, 'Directions (Q. No.s 11 and 12): Study the following diagram carefully and answer the questions based on it.', 'Venn labels live in the crop, not the prose')
    assert.ok(venn.warnings.some(w => w.startsWith('FIGURE_LABELS_SHOWN_IN_CROP')))
  }
})
