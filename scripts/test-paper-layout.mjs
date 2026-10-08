import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import { analysePaper, detectColumnsFromNumbers, classifyItemScript, buildFontScriptMap, parseAnswerKey, findAnswerKeyPage, buildLines, findBareMarkerSet, findQuestionStarts, parseMaterialRange, segmentQuestions, parseOptions, splitInlineMarker, extractMaterials, findRasterPages, scoreQuestion, mergeTeluguRepeats } from './lib/paper-layout.mjs'

test('table row near page bottom is retained while the running page number is excluded', () => {
  const lines=buildLines({page:1,heightPt:842,items:[{str:'72',x:54,y:28.1,width:12},{str:'23',x:288,y:8.4,width:16}]},{columns:[{index:0,from:0,to:595}]})
  assert.deepEqual(lines.map(l=>l.text),['72'])
})

test('odd-group and missing-term instructions follow their stated ranges, not the preceding question',()=>{
 const model=analysePaper(JSON.parse(fs.readFileSync('scripts/fixtures/group2-test4-instruction-boundaries.json')).pages)
 for(const [range,previous] of [[[96,97],95],[[98,99],97]]){
  const material=model.materials.find(m=>m.covers.join(',')===range.join(','));assert.ok(material)
  assert.equal(material.rangeSource,'HEADING_RANGE')
  assert.ok(material.sourceRegions.length)
  assert.doesNotMatch(model.questions.find(q=>q.number===previous).englishText,/Choose or find odd|Choose missing term/)
  for(const n of range)assert.equal(model.questions.find(q=>q.number===n).sharedMaterialIndex,material.index)
 }
 assert.deepEqual(parseMaterialRange('12–13. Choose the correct answer:').covers,[12,13])
 assert.deepEqual(parseMaterialRange('12–13. Total distance').covers,[])
})

test('direction in a stem cannot truncate its options or cross-page translation',()=>{
 const model=analysePaper(JSON.parse(fs.readFileSync('scripts/fixtures/group2-test4-instruction-boundaries.json')).pages)
 const q=model.questions.find(q=>q.number===117)
 assert.match(q.englishStem,/direction from the starting point\?/)
 assert.deepEqual(q.pages,[19,20]);assert.equal(q.sourceRegions.length,2)
 assert.equal(q.options.length,4);assert.ok(q.teluguRegions.length)
 assert.doesNotMatch(q.englishText,/Directions\(Q\.118\)|Statements/)
 const material=model.materials.find(m=>m.covers.join(',')==='118');assert.ok(material)
 assert.equal(model.questions.find(q=>q.number===118).sharedMaterialIndex,material.index)
 const lines=[{text:'7. How far and in which'},{text:'direction from the starting point?'},{text:'A) East B) West C) North D) South'},{text:'Direction 8:'},{text:'Read the next question'},{text:'8. Next question'}]
 const segments=segmentQuestions(lines,[{index:0,number:7,line:lines[0]},{index:5,number:8,line:lines[5]}]);assert.equal(segments[0].lines.length,3)
})

test('compact and singular directions belong to their explicitly named question', () => {
  assert.deepEqual(parseMaterialRange('DirectionsQ 143:').covers,[143])
  assert.deepEqual(parseMaterialRange('Direction 150:').covers,[150])
  const lines=[{text:'149. Previous question'},{text:'Direction 150:'},{text:'Choose the odd word'},{text:'150. A) Iron'}]
  const segments=segmentQuestions(lines,[{index:0,number:149,line:lines[0]},{index:3,number:150,line:lines[3]}])
  assert.equal(segments[0].lines.length,1)
})

test('explicit range headings split bilingual shared tables out of the preceding question',()=>{
 for(const dash of ['-','–','—'])assert.deepEqual(parseMaterialRange(`41${dash}43: Look at the table below`).covers,[41,42,43])
 assert.deepEqual(parseMaterialRange('41-43: total marks').covers,[])
 assert.deepEqual(parseMaterialRange('43-41: Look at the table below').covers,[])
 const lines=[{text:'40. Fill in the blank'},{text:'A) 12 B) 64 C) 32 D) 16'},{text:'41-43: Look at the table below'},{text:'Arjun 90 80 70 80'},{text:'41. Name the student'}]
 const segments=segmentQuestions(lines,[{index:0,number:40,line:lines[0]},{index:4,number:41,line:lines[4]}])
 assert.equal(segments[0].lines.length,2)
 const real=analysePaper(JSON.parse(fs.readFileSync('scripts/fixtures/group2-test1-shared-table-page.json')).pages)
 const shared=real.materials.find(m=>m.covers.join(',')==='41,42,43')
 assert.ok(shared);assert.equal(shared.materialType,'TABLE');assert.equal(shared.sourceRegions.length,2)
 assert.equal(real.questions.find(q=>q.number===40).sourceRegions.length,1)
 assert.doesNotMatch(real.questions.find(q=>q.number===40).englishText,/Syllabus|41-43|Arjun/)
 for(const n of [41,42,43])assert.equal(real.questions.find(q=>q.number===n).sharedMaterialIndex,shared.index)
 assert.equal(real.questions.find(q=>q.number===44).sharedMaterialIndex,undefined)
})

test('indented numeric lists cannot create a phantom column', () => {
  const items=[]
  for(let i=0;i<8;i++)for(const [x,y] of [[28,750-i*60],[54,735-i*60],[305,725-i*60]])items.push({str:`${i+1}.`,x,y,width:12})
  const cols=detectColumnsFromNumbers([{page:1,widthPt:595,heightPt:842,items}]).columns
  assert.equal(cols.length,2)
  assert.ok(cols[0].to>290)
})

test('embedded 1/2 list stays inside Q134 when Q135 resumes; unexplained duplicates remain', () => {
  const lines=[133,134,1,2,135].map(number=>({column:0,text:`${number}. Text`,items:[{x:28,str:`${number}.`}]}))
  assert.deepEqual(findQuestionStarts(lines,[{index:0,numberX:28}]).map(s=>s.number),[133,134,135])
  assert.deepEqual(findQuestionStarts([lines[0],lines[1],lines[2]],[{index:0,numberX:28}]).map(s=>s.number),[133,134,1])
})

// B4.1 regression tests over FROZEN fixtures taken from the real golden paper
// (pages 1-3, 18 and 28 of SI-CONSTABLE TEST-10). Pure: no PDF, no database, no OCR,
// no network. Acceptance against the whole paper is measured by scripts/b41-analyze-paper.mjs.

const { pages } = JSON.parse(fs.readFileSync('scripts/fixtures/si-golden-pages.json', 'utf8'))
const result = analysePaper(pages)
const q = n => result.questions.find(x => x.number === n)

test('fixture shape: the five golden pages with text and background images', () => {
  assert.deepEqual(pages.map(p => p.page), [1, 2, 3, 18, 28])
  assert.ok(pages.every(p => p.items.length > 0))
  assert.ok(pages.every(p => Math.abs(p.widthPt - 595) < 1 && Math.abs(p.heightPt - 842) < 1), 'A4 pages')
})

test('two columns are recovered from question-number clusters, not from the narrow gutter', () => {
  const cols = detectColumnsFromNumbers(pages)
  assert.equal(cols.columns.length, 2, 'exactly two columns (page-number footers excluded)')
  assert.equal(cols.source, 'QUESTION_NUMBER_CLUSTERS')
  assert.ok(Math.abs(cols.columns[0].numberX - 27) <= 3)
  assert.ok(Math.abs(cols.columns[1].numberX - 306) <= 3)
})

test('script classification: English, legacy Telugu (private use / ANSI) and neutral', () => {
  assert.equal(classifyItemScript('Count the number of triangles'), 'LATIN')
  assert.equal(classifyItemScript(''), 'TELUGU_LEGACY')
  assert.equal(classifyItemScript('≈£î{Ïº düº&û'), 'TELUGU_LEGACY')
  assert.equal(classifyItemScript('15'), 'NEUTRAL')
  const fonts = buildFontScriptMap(pages)
  const legacy = [...fonts.entries()].filter(([, s]) => s === 'TELUGU_LEGACY').map(([f]) => f)
  assert.ok(legacy.length >= 1, 'at least one font id is a legacy-Telugu cluster')
})

test('Q1: four textual options, Telugu kept as a region, proposed answer B', () => {
  const q1 = q(1)
  assert.ok(q1, 'Q1 detected')
  assert.match(q1.englishText, /How many meaning ful English words/)
  assert.equal(q1.options.length, 4)
  assert.deepEqual(q1.options.map(o => o.marker), ['A', 'B', 'C', 'D'])
  assert.deepEqual(q1.options.map(o => o.text), ['None', 'One', 'Two', 'Three'])
  assert.ok(q1.teluguRegions.length >= 1, 'Telugu preserved as a region')
  assert.equal(q1.proposedAnswer.letter, 'B')
})

test('Q6 golden case: one question, four numeric options, figure gap, Telugu region, answer D', () => {
  const q6 = q(6)
  assert.ok(q6, 'Q6 detected')
  assert.match(q6.englishText, /Count the number of triangles/)
  assert.equal(q6.options.length, 4, 'exactly four logical options — never eight')
  assert.deepEqual(q6.options.map(o => o.text), ['15', '19', '22', '24'])
  assert.ok(q6.teluguRegions.length >= 1)
  assert.ok(q6.visuals.figureGaps.length >= 1, 'triangle figure found as a layout gap')
  assert.equal(q6.proposedAnswer.letter, 'D')
  assert.equal(q6.proposedAnswer.position, 3)
  assert.equal(q6.status, 'NEEDS_REVIEW')
  assert.ok(q6.reviewReasons.includes('VISUAL_FROM_LAYOUT_GAP_NEEDS_CONFIRMATION'))
})

test('Q10 golden case: cross-column AND cross-page question assembled whole', () => {
  const q10 = q(10)
  assert.ok(q10, 'Q10 detected')
  assert.deepEqual(q10.pages, [2, 3], 'stem on page 2, options on page 3')
  assert.equal(q10.crossPage, true)
  assert.equal(q10.crossColumn, true)
  assert.match(q10.englishText, /Assertion \(A\): Too much work causes stress/)
  assert.equal(q10.options.length, 4)
  assert.match(q10.options[0].text, /Both A and R are true and R is the correct/)
  assert.match(q10.options[3].text, /A is false, but R is true/)
  assert.equal(q10.status, 'READY', 'no teacher intervention needed')
  assert.equal(q10.proposedAnswer.letter, 'A')
})

test('bare A B C D markers are accepted only as a complete ordered set (Q124)', () => {
  const q124 = q(124)
  assert.ok(q124)
  assert.match(q124.englishText, /total number of stars in the universe/)
  assert.equal(q124.options.length, 4, 'four logical options from the bare marker set')
  assert.deepEqual(q124.options.map(o => o.marker), ['A', 'B', 'C', 'D'])
  assert.equal(q124.status, 'NEEDS_REVIEW')
  assert.ok(q124.reviewReasons.includes('EMPTY_OPTION_TEXT'), 'option text still needs a teacher')
  assert.ok(q124.teluguRegions.length >= 1)
  assert.equal(q124.proposedAnswer.letter, 'B')
})

test('an isolated bare letter is never treated as an option marker', () => {
  const line = (items) => ({ page: 1, column: 0, y: 100, items: items.map((s, i) => ({ str: s, x: 50 + i * 30, width: 8 })), text: items.join(' ') })
  assert.deepEqual(findBareMarkerSet([line(['A', 'and', 'B'])]), [], 'prose letters rejected')
  assert.deepEqual(findBareMarkerSet([line(['A', 'B', 'C'])]), [], 'incomplete set rejected')
  assert.deepEqual(findBareMarkerSet([line(['A', 'C', 'B', 'D'])]), [], 'out-of-order set rejected')
  assert.equal(findBareMarkerSet([line(['A', 'B', 'C', 'D'])]).length, 4, 'complete ordered set accepted')
  const tight = { page: 1, column: 0, y: 100, text: 'ABCD', items: ['A', 'B', 'C', 'D'].map((s, i) => ({ str: s, x: 50 + i * 3, width: 3 })) }
  assert.deepEqual(findBareMarkerSet([tight]), [], 'letters without real separation rejected')
})

test('answer key: page 28 parsed in N) X form, all entries, none duplicated', () => {
  const linesByPage = new Map(pages.map(p => [p.page, buildLines(p, detectColumnsFromNumbers(pages))]))
  const keyPage = findAnswerKeyPage(pages, linesByPage)
  assert.equal(keyPage.page, 28)
  const parsed = parseAnswerKey(keyPage)
  assert.equal(parsed.entries.length, 200)
  assert.deepEqual(parsed.duplicates, [])
  assert.deepEqual(parsed.entries.slice(0, 6).map(e => `${e.number}${e.letter}`), ['1B', '2A', '3C', '4D', '5A', '6D'])
  assert.ok(parsed.entries.every(e => e.position >= 0 && e.position <= 3))
})

test('answers are only ever proposed — never confirmed', () => {
  const json = JSON.stringify(result)
  assert.ok(!/is_confirmed_correct|confirmed/i.test(json), 'no confirmation anywhere in the model')
  assert.ok(result.questions.filter(x => x.proposedAnswer).every(x => x.proposedAnswer.source === 'ANSWER_KEY_PAGE'))
})

test('legacy Telugu is preserved as regions and never as text', () => {
  for (const question of result.questions) {
    for (const r of question.teluguRegions) {
      assert.ok(r.w > 0 && r.h > 0 && r.page > 0, 'region has geometry')
      assert.ok(!('text' in r), 'no Telugu text is carried')
    }
    assert.ok(!/[-]/.test(question.englishText || ''), 'no legacy glyphs in English text')
    for (const o of question.options) assert.ok(!/[-]/.test(o.text || ''), 'no legacy glyphs in options')
  }
})

test('the repeated background image is rejected as decoration, never attached', () => {
  assert.equal(result.stats.visualsAttached, 0, 'no XObject is treated as a figure in this paper')
  assert.ok(result.stats.decorationSignatures >= 1)
  for (const question of result.questions) {
    assert.ok(question.visuals.rejected.every(r => ['DECORATION', 'TOO_SMALL', 'PAGE_SIZED', 'PARTIAL_CONTAINMENT'].includes(r.reason)))
  }
})

test('every uncertain question carries an explicit review reason', () => {
  for (const question of result.questions) {
    if (question.status === 'READY') assert.deepEqual(question.reviewReasons.filter(r => !r.startsWith('NO_TELUGU_REGION')), [])
    else assert.ok(question.reviewReasons.length > 0, `Q${question.number} routed to review without a reason`)
  }
})

// SI & Constable Test-4 (samples/si-constable-test4.pdf): FROZEN page models of pages 1, 2, 6, 10, 11,
// 13, 15, 16, 19, 24 and the answer-key page 27. Pure, like the golden fixture above.
const police = analysePaper(JSON.parse(fs.readFileSync('scripts/fixtures/si-constable-test4-pages.json', 'utf8')).pages)
const pq = n => police.questions.find(x => x.number === n)
const texts = n => pq(n).options.map(o => o.text)
// The fixture's pages are not consecutive, so paper-wide checks use the questions printed whole inside it.
const WHOLE = [1, 2, 3, 4, 5, 54, 55, 56, 101, 103, 104, 105, 113, 126, 133, 135, 151, 153, 184, 187]
const flagged = reason => WHOLE.filter(n => pq(n).reviewReasons.some(r => r.startsWith(reason)))
const OPTION_FLAGS = /DUPLICATE_OPTION_MARKERS|MORE_THAN_4_OPTIONS|FEWER_THAN_4_OPTIONS|UNASSIGNED_TEXT_AFTER_OPTIONS|EMPTY_OPTION_TEXT/
// A synthetic line: cells are [x, text].
const row = (y, ...cells) => {
  const items = cells.map(([x, str]) => ({ str, x, y, width: str.length * 5, fontName: 'latin' }))
  return { page: 1, column: 0, y, x: items[0].x, right: items.at(-1).x + items.at(-1).width, items, text: items.map(i => i.str).join(' ') }
}

test('Test-4: the passage before Q1 is one material for Q1-5; the cover page is not material; Q54-56 stay linked', () => {
  assert.deepEqual(police.materials.map(m => m.covers.join(',')), ['1,2,3,4,5', '54,55,56'])
  const passage = police.materials[0]
  assert.equal(passage.materialType, 'PASSAGE'); assert.equal(passage.rangeSource, 'HEADING_RANGE'); assert.deepEqual(passage.pages, [2])
  assert.match(passage.englishText, /^Directions \(1-5 Q\. No\.s\): Read the passage given below/)
  assert.match(passage.englishText, /Education has a significant place.*doing equally resonsible works\.$/)
  assert.deepEqual(passage.reviewReasons, [])
  for (const n of [1, 2, 3, 4, 5]) assert.equal(pq(n).sharedMaterialIndex, passage.index)
  assert.equal(pq(6).sharedMaterialIndex, undefined)
  assert.match(pq(1).englishStem, /^Education of women is necessary because$/); assert.equal(pq(1).status, 'READY')
  // Nothing printed on the cover page becomes material or part of the passage.
  for (const m of police.materials) { assert.ok(!m.pages.includes(1)); assert.doesNotMatch(m.englishText, /MODEL TEST|COACHING|BRANCH|Contact Number/) }
  const diagram = police.materials[1]
  assert.equal(diagram.materialType, 'DIAGRAM'); assert.equal(diagram.rangeSource, 'HEADING_RANGE')
  for (const n of [54, 55, 56]) assert.equal(pq(n).sharedMaterialIndex, diagram.index)
})

test('shared material: a heading opens its own block, text that is not material ends at a page change, a passage continues over a page', () => {
  const line = (page, y, text) => ({ page, column: 0, y, x: 28, right: 280, text, items: [{ str: text, x: 28, y, width: 250, fontName: 'latin' }] })
  const cover = [line(1, 700, 'MODEL TEST'), line(1, 600, 'Time : 2 Hrs')]
  const heading = line(2, 800, 'Directions (1-2 Q. No.s): Read the passage given below.')
  const passage = [line(2, 786, 'A passage begins here'), line(3, 800, 'and ends on the next page.')]
  const q1 = line(3, 780, '1. First question'), q2 = line(3, 760, '2. Second question')
  const segments = [{ number: 1, lines: [q1] }, { number: 2, lines: [q2] }]
  const [only, ...rest] = extractMaterials([...cover, heading, ...passage, q1, q2], segments, new Map())
  assert.equal(rest.length, 0); assert.deepEqual(only.covers, [1, 2]); assert.deepEqual(only.pages, [2, 3]); assert.equal(only.lineCount, 3)
  assert.equal(only.englishText, 'Directions (1-2 Q. No.s): Read the passage given below. A passage begins here and ends on the next page.')
  // A passage line that merely starts with the word "Directions" does not cut the passage in two.
  const prose = line(2, 772, 'Directions of the wind were noted every day.')
  const whole = extractMaterials([...cover, heading, passage[0], prose, passage[1], q1, q2], segments, new Map())
  assert.equal(whole.length, 1); assert.equal(whole[0].lineCount, 4); assert.deepEqual(whole[0].covers, [1, 2])
  // Two headings that each state a range are two materials.
  const second = line(3, 790, 'Directions (2 Q. No.): Read the note below.')
  const two = extractMaterials([heading, passage[0], q1, second, line(3, 785, 'A short note.'), q2], segments, new Map())
  assert.deepEqual(two.map(m => m.covers), [[1], [2]].map((c, i) => i ? c : two[0].covers)); assert.deepEqual(two[1].covers, [2])
  // Unlabelled text before the first question on a later page is still not material.
  assert.deepEqual(extractMaterials([...cover, line(2, 800, 'General instructions for candidates'), q1, q2], segments, new Map()), [])
})

test('Test-4: a statement list lettered like the options stays in the stem and the answer codes are the options', () => {
  assert.deepEqual(texts(101), ['A and B', 'B and C', 'A, B, C and', 'B, C and D'])
  assert.match(pq(101).englishStem, /^Consider the following statements regarding the Legislative Powers of Governor: A\) He can summon or prorogue the state legislature\./)
  assert.match(pq(101).englishStem, /D\) He can send messages to the State Legislatures for meetings\. Choose the correct answer from the given codes:$/)
  assert.equal(pq(101).optionDuplicates, 0); assert.doesNotMatch(pq(101).reviewReasons.join(' '), OPTION_FLAGS)
  assert.deepEqual(pq(101).optionSetSource, { kind: 'STATEMENT_LIST_BEFORE_OPTIONS', listMarkers: ['A', 'B', 'C', 'D'] })
  // The Telugu rendering, with its own A-D options, stays a region; the key still proposes the answer.
  assert.ok(pq(101).teluguRegions.length >= 1); assert.ok(pq(101).teluguLineCount >= 6)
  assert.equal(pq(101).proposedAnswer.letter, 'C'); assert.equal(pq(101).status, 'READY')
  // Lists of three, five (the fifth is "E)") and two statements; items printed two to a row.
  assert.deepEqual(texts(103), ['Only A', 'A and B', 'A, B and C', 'All the above'])
  assert.deepEqual(texts(105), ['A, B and E', 'A and C', 'B and D', 'C and D']); assert.match(pq(105).englishStem, /E\) After Consulting the two Supreme Court judges/)
  assert.deepEqual(texts(135), ['A', 'Both A and B', 'B', 'None of the above'])
  assert.deepEqual(texts(104), ['A and B', 'A, B and C', 'A, B, C and D', 'A, C and D'])
  assert.match(pq(104).englishStem, /A\) Article 13 B\) Article 32 C\) Article 131 D\) Article 226 Choose the correct answer from the given codes:$/)
  assert.deepEqual(texts(151), ['D, A, C and B', 'C, B, D and A', 'A, C, B and D', 'D, C, A and B'])
  for (const n of [103, 104, 105, 135, 151]) { assert.equal(pq(n).optionDuplicates, 0, `Q${n}`); assert.doesNotMatch(pq(n).reviewReasons.join(' '), OPTION_FLAGS, `Q${n}`); assert.equal(pq(n).optionSetSource.kind, 'STATEMENT_LIST_BEFORE_OPTIONS') }
})

test('Test-4: an option set printed again in Latin inside the Telugu block is the same options, not duplicates', () => {
  assert.deepEqual(texts(113), ['a-1, b-2, c-3, d-4', 'a-3, b-1, c-4, d-2', 'a-4, b-3, c-2, d-1', 'a-2, b-4, c-1, d-3'])
  assert.equal(pq(113).optionDuplicates, 0); assert.doesNotMatch(pq(113).reviewReasons.join(' '), OPTION_FLAGS)
  assert.deepEqual(pq(113).optionSetSource, { kind: 'OPTION_SET_REPEATED_IN_TELUGU_BLOCK' })
  assert.match(pq(113).englishStem, /1\. DPSP.*4\. Fundamental Duties.*Choose the correct Answer from the given codes:$/)
})

test('real duplicate markers stay flagged: a misprinted set (Q126) and sets with no evidence of a list or a repeat', () => {
  assert.deepEqual(flagged('DUPLICATE_OPTION_MARKERS'), [126]); assert.equal(pq(126).status, 'NEEDS_REVIEW')
  const two = (between, second = [['One', 'Two'], ['Three', 'Four']], opts = {}) => parseOptions([
    row(140, [28, '7.'], [54, 'Which colour is primary?']), row(126, [54, 'A) Red'], [150, 'B) Blue']), row(112, [54, 'C) Green'], [150, 'D) White']),
    ...between.map((text, i) => row(98 - i * 14, [54, text])),
    row(60, [54, 'A) ' + second[0][0]], [150, 'B) ' + second[0][1]]), row(46, [54, 'C) ' + second[1][0]], [150, 'D) ' + second[1][1]])], { numberX: 28, ...opts })
  assert.equal(two(['Another line without a prompt.']).duplicates, 4)
  assert.equal(two([]).duplicates, 4)
  // A prompt alone is not evidence: the second set must be codes of the list, or the prompt must refer to the list above.
  assert.equal(two(['Which one is correct?']).duplicates, 4)
  const above = two(['The above colours are related to which flag:'])
  assert.equal(above.duplicates, 0); assert.deepEqual(above.options.map(o => o.text), ['One', 'Two', 'Three', 'Four']); assert.equal(above.optionSetSource.kind, 'STATEMENT_LIST_BEFORE_OPTIONS')
  const codes = two(['Choose the correct answer'], [['A and B', 'Only C'], ['A, C and D', 'None of the above']])
  assert.equal(codes.duplicates, 0); assert.deepEqual(codes.options.map(o => o.text), ['A and B', 'Only C', 'A, C and D', 'None of the above'])
  // The same set twice is a repeat only when Telugu text lies between the two.
  const same = [['Red', 'Blue'], ['Green', 'White']]
  assert.equal(two([], same).duplicates, 4)
  const telugu = two([], same, { teluguLines: [row(90, [54, 'telugu'])] })
  assert.equal(telugu.duplicates, 0); assert.deepEqual(telugu.options.map(o => o.text), ['Red', 'Blue', 'Green', 'White']); assert.equal(telugu.optionSetSource.kind, 'OPTION_SET_REPEATED_IN_TELUGU_BLOCK')
  assert.equal(two([], [['Red', 'Blue'], ['Green', 'Black']], { teluguLines: [row(90, [54, 'telugu'])] }).duplicates, 4)
})

test('a lettered list followed by numbered answer codes: the numbered set is the options (golden Q160)', () => {
  // Golden paper Q160 prints "A) Octroi .. D) Estate duty" and then "1) A, B  2) C, D  3) A, B, D  4) B, C, D".
  const numbered = (prompt, codes, list = ['A) Octroi', 'B) Interest tax', 'C) Gift tax', 'D) Estate duty']) => parseOptions([
    row(140, [28, '8.'], [54, 'Which of the following taxes have been withdrawn?']),
    row(126, [54, list[0]], [150, list[1]]), ...(list.length > 2 ? [row(112, [54, list[2]], ...(list[3] ? [[150, list[3]]] : []))] : []),
    ...(prompt ? [row(98, [54, prompt])] : []),
    row(84, [54, '1) ' + codes[0]], [150, '2) ' + codes[1]]), row(70, [54, '3) ' + codes[2]], [150, '4) ' + codes[3]])], { numberX: 28 })
  const codes = numbered('', ['A, B', 'C, D', 'A, B, D', 'B, C, D'])
  assert.deepEqual(codes.options.map(o => [o.marker, o.text]), [['1', 'A, B'], ['2', 'C, D'], ['3', 'A, B, D'], ['4', 'B, C, D']])
  assert.deepEqual(codes.optionSetSource, { kind: 'LETTERED_LIST_BEFORE_NUMBERED_OPTIONS', listMarkers: ['A', 'B', 'C', 'D'] })
  assert.equal(codes.duplicates, 0); assert.equal(codes.unassignedAfterOptions, '')
  // A list of three, and a prompt that refers to the list above when the options are not plain codes.
  assert.deepEqual(numbered('', ['Only A', 'A and C', 'B and C', 'All of the above'], ['A. Kurnool', 'B. Chittoor', 'C. Kadapa']).options.map(o => o.marker), ['1', '2', '3', '4'])
  assert.deepEqual(numbered('Mark the correct one among the above:', ['A, B are correct', 'B, C are correct', 'A, B, C are correct', 'All are correct']).options.map(o => o.text), ['A, B are correct', 'B, C are correct', 'A, B, C are correct', 'All are correct'])
  // Codes written as full phrases or as pairs (Grand Test-10 Q78, Q67); numbers alone do not name the list.
  assert.deepEqual(numbered('', ['A, B, D', 'A, B, C', 'A, C', 'All of the above are correct']).options.map(o => o.marker), ['1', '2', '3', '4'])
  assert.equal(numbered('', ['A-1, B-2, C-3, D-4', 'A-4, B-2, C-3, D-1', 'A-4, B-2, C-1, D-3', 'A-4, B-3, C-2, D-1']).options[1].text, 'A-4, B-2, C-3, D-1')
  assert.deepEqual(numbered('', ['1 and 2', '2 and 3', '1 only', 'None']).options.map(o => o.marker), ['A', 'B', 'C', 'D'])
  // Without that evidence the letters stay the options and the numbered text stays with the option it follows.
  const plain = numbered('', ['Rajasthan', 'Punjab', 'Kerala', 'Assam'])
  assert.deepEqual(plain.options.map(o => o.marker), ['A', 'B', 'C', 'D']); assert.equal(plain.optionSetSource, null)
  assert.ok(plain.unassignedAfterOptions.includes('1) Rajasthan') || plain.options.some(o => o.text.includes('1) Rajasthan')))
  // The real golden question, when its page is in the fixture.
  if (q(160)) { assert.deepEqual(q(160).options.map(o => [o.marker, o.text]), [['1', 'A, B'], ['2', 'C, D'], ['3', 'A, B, D'], ['4', 'B, C, D']]); assert.match(q(160).englishStem, /D\) Estate duty$/) }
})

test('Test-4: match-the-following lists stay in the stem and two options printed in one run are split (Q133)', () => {
  assert.deepEqual(texts(133), ['a-2, b-3, c-1, d-4', 'a-2, b-3, c-4, d-1', 'a-1, b-2, c-3, d-4', 'a-4, b-3, c-1, d-2'])
  assert.deepEqual(pq(133).markerSequence, ['A', 'B', 'C', 'D'])
  assert.match(pq(133).englishStem, /^Match List-I \(Mining Centres\) with List-II/)
  assert.match(pq(133).englishStem, /a\) Malanjkhand 1\) Coal b\) Kudremukh 2\) Copper c\) Korba 3\) Iron ore d\) Jaduguda 4\) uranium Choose the correct anser from the given codes:$/)
  assert.doesNotMatch(pq(133).reviewReasons.join(' '), OPTION_FLAGS); assert.equal(pq(133).unassignedEnglish, '')
  assert.deepEqual(pq(133).optionRepairs, [
    { kind: 'SPLIT_AT_INLINE_MARKER', host: 'A', marker: 'B', source: 'a-2, b-3, c-1, d-4 B) a-2, b-3, c-4, d-1' },
    { kind: 'SPLIT_AT_INLINE_MARKER', host: 'C', marker: 'D', source: 'a-1, b-2, c-3, d-4 D) a-4, b-3, c-1, d-2' }])
  assert.equal(pq(133).status, 'READY'); assert.deepEqual(flagged('MORE_THAN_4_OPTIONS'), [])
  // Each missing letter must sit, once, in the option just before it; nothing is created from nothing.
  const parsed = (...pairs) => pairs.map(([marker, text], position) => ({ marker, text, position }))
  assert.deepEqual(splitInlineMarker(parsed(['A', 'x B) y C) z'], ['D', 'w'])).options.map(o => [o.marker, o.text]), [['A', 'x'], ['B', 'y'], ['C', 'z'], ['D', 'w']])
  assert.equal(splitInlineMarker(parsed(['A', 'x C) z'], ['D', 'w'])), null)
  assert.equal(splitInlineMarker(parsed(['A', 'x B) y'], ['C', 'z D)'])), null)
  // Inline pairs still split when a numbered list comes first.
  const match = parseOptions([row(140, [28, '9.'], [54, 'Match the lists:']), row(126, [54, 'a) Korba'], [150, '1) Coal']), row(112, [54, 'b) Kolar'], [150, '2) Gold']),
    row(98, [54, 'A) a-1, b-2 B) a-2, b-1']), row(84, [54, 'C) a-1, b-1 D) a-2, b-2'])], { numberX: 28 })
  assert.deepEqual(match.options.map(o => [o.marker, o.text]), [['A', 'a-1, b-2'], ['B', 'a-2, b-1'], ['C', 'a-1, b-1'], ['D', 'a-2, b-2']]); assert.equal(match.unassignedAfterOptions, '')
})

test('Test-4: option markers with a space before or no space after the bracket are read (Q153)', () => {
  assert.deepEqual(texts(153), ['Gravitational force', 'Frictional force', 'Centrifugal force', 'Centripetal force'])
  assert.doesNotMatch(pq(153).reviewReasons.join(' '), OPTION_FLAGS); assert.equal(pq(153).status, 'READY')
  const read = (...rows) => parseOptions([row(140, [28, '3.'], [54, 'Pick one of the following']), ...rows], { numberX: 28 })
  const spaced = read(row(126, [54, 'A )One'], [150, 'B)Two']), row(112, [54, 'C ) Three'], [150, '(D) Four']))
  assert.deepEqual(spaced.options.map(o => [o.marker, o.text]), [['A', 'One'], ['B', 'Two'], ['C', 'Three'], ['D', 'Four']]); assert.equal(spaced.duplicates, 0)
  const bracketed = read(row(126, [54, '(A) One'], [150, '(B) Two']), row(112, [54, '(C)'], [70, 'Three'], [150, '(D) Four']))
  assert.deepEqual(bracketed.options.map(o => [o.marker, o.text]), [['A', 'One'], ['B', 'Two'], ['C', 'Three'], ['D', 'Four']])
  // Decimals and abbreviations are text, and a bracketed letter in the stem is not a second option A.
  const prose = read(row(133, [54, '(A) is the assertion and 3.5 km is the distance'], [200, '2.5 A.P. border']),
    row(126, [54, 'A) 1.5 km'], [150, 'B) 2.5 km']), row(112, [54, 'C) 3.14'], [150, 'D) A.P. state']))
  assert.deepEqual(prose.options.map(o => [o.marker, o.text]), [['A', '1.5 km'], ['B', '2.5 km'], ['C', '3.14'], ['D', 'A.P. state']]); assert.equal(prose.duplicates, 0)
  // A marker of another style inside the option area is that option's text; nothing is dropped.
  const inside = read(row(126, [54, 'A) Only'], [100, '(1)'], [150, 'B) Both'], [200, '(1) and (2)']), row(112, [54, 'C) May'], [100, '4)June'], [150, 'D) Vitamin'], [210, 'A.']))
  assert.deepEqual(inside.options.map(o => [o.marker, o.text]), [['A', 'Only (1)'], ['B', 'Both (1) and (2)'], ['C', 'May 4)June'], ['D', 'Vitamin A.']]); assert.equal(inside.unassignedAfterOptions, '')
})

test('Test-4: English options split from one run are not mixed with the Telugu block\'s own A)-D) markers (Q184, Q187)', () => {
  assert.deepEqual(texts(184), ['A.R. Rahman', 'Ilaiyaraaja', 'Shankar–Ehsaan–Loy', 'M.M. Keeravani'])
  assert.deepEqual(texts(187), ['Red Sea', 'Black Sea', 'South China Sea', 'Arabian Sea'])
  for (const n of [184, 187]) { assert.equal(pq(n).optionDuplicates, 0); assert.doesNotMatch(pq(n).reviewReasons.join(' '), OPTION_FLAGS); assert.equal(pq(n).status, 'READY') }
})

// Group-2 G.S. Test-2 (samples/group2-gs-test2.pdf): FROZEN page models of pages 20-22. Page 21 is a raster
// page: six full-width picture strips cover it and the text layer lies on top. The Venn diagram for
// Q121-125 is printed between the directions and Q121 and exists only in those pixels.
const rasterPages = JSON.parse(fs.readFileSync('scripts/fixtures/group2-test2-raster-page.json', 'utf8')).pages
const raster = analysePaper(rasterPages)
const rq = n => raster.questions.find(x => x.number === n)

test('Test-2: the material for Q121-125 reaches down to Q121, so the diagram printed between them is inside its crop', () => {
  const material = raster.materials.find(m => m.covers.join(',') === '121,122,123,124,125')
  const left = material.sourceRegions.find(r => r.page === 21 && r.column === 0), right = material.sourceRegions.find(r => r.page === 21 && r.column === 1)
  const q121 = rq(121).sourceRegions[0]
  // The right-column part now ends where Q121 begins (y ≈ 611) instead of under its last text line (y ≈ 735).
  assert.ok(Math.abs(right.y - q121.y1) <= 1, `material bottom ${right.y} vs Q121 top ${q121.y1}`)
  assert.ok(right.y <= 612); assert.ok(Math.abs(right.y + right.h - 817.7) < 0.1, 'the top of the part did not move')
  // It never enters a question's lines, and no question region changed.
  for (const question of raster.questions) for (const b of question.sourceRegions.filter(b => b.page === 21 && b.column === 1)) assert.ok(b.y1 <= right.y + 1, `Q${question.number}`)
  assert.deepEqual([Math.round(q121.y0), Math.round(q121.y1)], [541, 611])
  // The left-column part ends at the foot of the column with no room for a figure below it: unchanged.
  assert.deepEqual([Math.round(left.y), Math.round(left.h)], [45, 178])
  // A material whose text already meets its question is unchanged (Q134 on page 22).
  const next = raster.materials.find(m => m.covers.join(',') === '134')
  assert.deepEqual(next.sourceRegions.map(r => [r.page, r.column, Math.round(r.y), Math.round(r.h)]), [[22, 0, 46, 85], [22, 1, 698, 118]])
  for (const n of [121, 122, 123, 124, 125]) assert.equal(rq(n).sharedMaterialIndex, material.index)
})

test('shared material regions: down to the first question, to the foot of a column that continues, never into other lines', () => {
  const line = (page, column, y, text) => ({ page, column, y, x: column ? 305 : 28, right: column ? 560 : 280, text, items: [{ str: text, x: column ? 305 : 28, y, width: 250, height: 10, fontName: 'latin' }] })
  const pages = [{ page: 1, widthPt: 595, heightPt: 842, items: [], images: [] }]
  const heading = line(1, 0, 700, 'Directions (1-2 Q. No.s): Study the diagram.')
  const q1 = line(1, 0, 500, '1. First question'), q2 = line(1, 0, 400, '2. Second question')
  const segments = [{ number: 1, lines: [q1] }, { number: 2, lines: [q2] }]
  const region = (materials, column = 0) => materials[0].sourceRegions.find(r => r.column === column)
  // A diagram-sized gap between the directions and Q1 becomes part of the material; its top stays put.
  const gap = region(extractMaterials([heading, line(1, 0, 686, 'Answer the questions.'), q1, q2], segments, new Map(), pages))
  assert.equal(gap.y, 512); assert.ok(Math.abs(gap.y + gap.h - 710.5) < 0.01)
  // Without page sizes (older callers) the first question still limits it.
  assert.equal(region(extractMaterials([heading, q1, q2], segments, new Map())).y, 512)
  // The material ends a column and continues in the next: the first part runs to the foot of its column
  // when there is room for a figure there, the second part runs down to the first question.
  const flow = { number: 1, lines: [line(1, 1, 600, '1. First question')] }, flowNext = { number: 2, lines: [line(1, 1, 500, '2. Second question')] }
  const flowing = extractMaterials([line(1, 0, 300, 'Directions (1-2 Q. No.s): Study the diagram.'), line(1, 1, 800, 'Answer the questions.'), ...flow.lines, ...flowNext.lines], [flow, flowNext], new Map(), pages)
  assert.ok(Math.abs(region(flowing, 0).y - 842 * 0.035) < 0.01); assert.equal(region(flowing, 1).y, 612)
  // Only a line or two of space at the foot of the column: nothing to include, so the part is left as it is.
  const tight = extractMaterials([line(1, 0, 50, 'Directions (1-2 Q. No.s): Study the diagram.'), line(1, 1, 800, 'Answer the questions.'), ...flow.lines, ...flowNext.lines], [flow, flowNext], new Map(), pages)
  assert.equal(region(tight, 0).y, 45)
  // The material has no text in the next column, only its figure above the first question: that space is a part too.
  const low = { number: 1, lines: [line(1, 1, 600, '1. First question')] }
  const figureOnly = extractMaterials([line(1, 0, 300, 'Directions (1-2 Q. No.s): Study the graph.'), ...low.lines, ...flowNext.lines], [low, flowNext], new Map(), pages)
  assert.deepEqual(figureOnly[0].sourceRegions.map(r => r.column), [0, 1])
  assert.equal(region(figureOnly, 1).y, 612); assert.ok(Math.abs(region(figureOnly, 1).y + region(figureOnly, 1).h - 842 * 0.965) < 0.01)
  // No such part when the first question starts at the head of the column.
  const high = { number: 1, lines: [line(1, 1, 800, '1. First question')] }
  assert.deepEqual(extractMaterials([line(1, 0, 300, 'Directions (1-2 Q. No.s): Study the graph.'), ...high.lines, ...flowNext.lines], [high, flowNext], new Map(), pages)[0].sourceRegions.map(r => r.column), [0])
  // A part the material continues into reaches up to the head of its column (a chart above its first label).
  const labelled = extractMaterials([line(1, 0, 300, 'Directions (1-2 Q. No.s): Study the chart.'), line(1, 1, 650, 'Total students = 2500'), ...low.lines, ...flowNext.lines], [low, flowNext], new Map(), pages)
  assert.equal(region(labelled, 1).y, 612); assert.ok(Math.abs(region(labelled, 1).y + region(labelled, 1).h - 842 * 0.965) < 0.01)
  // Another material's lines stop it, exactly like a question's.
  const other = { number: 3, lines: [line(1, 1, 300, '3. Third question')] }
  const two = extractMaterials([heading, q1, q2, line(1, 1, 800, 'Directions (3 Q. No.): Read the note.'), line(1, 1, 500, 'Directions (4 Q. No.): Read the second note.'), ...other.lines], [...segments, other], new Map(), pages)
  assert.equal(two[1].sourceRegions[0].y, 512); assert.equal(two[2].sourceRegions[0].y, 312)
})

test('Test-2: page 21 is a raster page; its strips are not figure candidates and each of its questions carries one note', () => {
  assert.deepEqual(raster.stats.rasterPages, [21])
  assert.deepEqual(findRasterPages(rasterPages, new Set()), [21])
  for (const n of [117, 118, 119, 120, 121, 122, 123, 124, 125, 126, 127, 128]) {
    const reasons = rq(n).reviewReasons
    assert.equal(reasons.filter(r => r === 'RASTER_PAGE').length, 1, `Q${n}`)
    assert.ok(!reasons.includes('VISUAL_PARTIALLY_CONTAINED'), `Q${n}`)
    assert.ok(!rq(n).visuals.rejected.some(r => r.reason === 'PARTIAL_CONTAINMENT' && r.page === 21), `Q${n}`)
    assert.ok(rq(n).visuals.rejected.some(r => r.reason === 'RASTER_PAGE_STRIP'), `Q${n}`)
    assert.equal(rq(n).status, 'NEEDS_REVIEW')
  }
  // Questions on the ordinary pages are untouched, and real pictures there are still attached.
  for (const n of [115, 116, 129, 130]) assert.ok(!rq(n).reviewReasons.includes('RASTER_PAGE'), `Q${n}`)
  assert.equal(raster.stats.visualsAttached, 3)
  // A figure gap inside a question on a raster page is still found and still asks for confirmation.
  assert.ok(raster.questions.filter(x => x.pages.includes(21)).every(x => Array.isArray(x.visuals.figureGaps)))
  const gapQuestion = { number: 1, englishStem: 'How many triangles are in the figure?', options: [0, 1, 2, 3].map(i => ({ text: 'x' + i })), optionDuplicates: 0, teluguRegions: [{}], rasterPage: true,
    visuals: { attached: [], rejected: [], figureGaps: [{ page: 21, column: 0, x: 0, y: 100, w: 290, h: 90 }] } }
  assert.deepEqual(scoreQuestion(gapQuestion, { expectedNumber: 1, keyEntry: { letter: 'A' }, columnConfident: true }).reviewReasons, ['VISUAL_FROM_LAYOUT_GAP_NEEDS_CONFIRMATION', 'RASTER_PAGE'])
})

test('raster pages: full-width strips over most of the page only; backgrounds repeated on every page stay decoration', () => {
  const page = (n, images) => ({ page: n, widthPt: 595, heightPt: 842, items: [], images })
  const strips = [0, 1, 2, 3, 4, 5].map(i => ({ x: 22, y: 20 + i * 135, w: 551, h: 135 }))
  assert.deepEqual(findRasterPages([page(1, strips), page(2, strips.slice(0, 3)), page(3, [{ x: 100, y: 300, w: 200, h: 200 }]), page(4, [])], new Set()), [1])
  // Narrow pictures side by side do not make a raster page, however much of the page they cover.
  assert.deepEqual(findRasterPages([page(1, [0, 1, 2, 3].flatMap(i => [{ x: 20, y: 20 + i * 200, w: 270, h: 200 }, { x: 300, y: 20 + i * 200, w: 270, h: 200 }]))], new Set()), [])
  // The golden paper prints the same background on every page: decoration, not a raster page.
  assert.deepEqual(result.stats.rasterPages, []); assert.deepEqual(police.stats.rasterPages, [])
})

test('Grand Test-8: a graph printed at the head of the next column, above the first question, becomes part of the material', () => {
  // Frozen page models of pages 17, 19 and 21. The directions for Q115-119 end at the foot of the left column of
  // page 21; the line graph is printed at the head of the right column, above Q115, and has no text of its own.
  const pages = JSON.parse(fs.readFileSync('scripts/fixtures/grand-test8-graph-next-column.json', 'utf8')).pages
  const model = analysePaper(pages)
  const material = model.materials.find(m => m.covers.join(',') === '115,116,117,118,119')
  assert.deepEqual(material.sourceRegions.map(r => [r.page, r.column]), [[21, 0], [21, 1]])
  const graph = material.sourceRegions[1], q115 = model.questions.find(x => x.number === 115).sourceRegions[0]
  assert.ok(Math.abs(graph.y - q115.y1) <= 1); assert.ok(Math.abs(graph.y + graph.h - pages.find(p => p.page === 21).heightPt * 0.965) < 0.01); assert.ok(graph.h > 150)
  assert.deepEqual([q115.page, q115.column, Math.round(q115.y0), Math.round(q115.y1)], [21, 1, 565, 648])
  assert.deepEqual(model.stats.rasterPages, [])
})

// SI & Constable Test-2 (samples/si-constable-test2.pdf): FROZEN page models of pages 5, 11, 12, 13 and the
// answer-key page 32. Q40, Q80, Q85 and Q90 each follow a single-question "Directions:" block and are printed
// as an English part and then, under the SAME number again, the Telugu part.
const twins = analysePaper(JSON.parse(fs.readFileSync('scripts/fixtures/si-constable-test2-repeated-numbers.json', 'utf8')).pages)
const twin = n => twins.questions.filter(x => x.number === n)

test('Test-2: a question whose Telugu half is printed under the same number again is one question', () => {
  assert.deepEqual(twins.questions.map(x => x.number), [35, 36, 37, 38, 39, 40, 41, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94])
  assert.deepEqual(twins.stats.duplicateNumbers, []); assert.deepEqual(twins.stats.teluguHalvesMerged, [40, 80, 85, 90])
  for (const n of [40, 80, 85, 90]) {
    const [question, ...extra] = twin(n)
    assert.equal(extra.length, 0, `Q${n} once`); assert.equal(question.teluguHalfMerged, true)
    assert.equal(question.options.length, 4, `Q${n} options`); assert.equal(question.optionDuplicates, 0); assert.ok(question.options.every(o => o.text), `Q${n} option text`)
    assert.ok(question.englishStem.length > 30, `Q${n} English part`); assert.ok(question.teluguRegions.length >= 1 && question.teluguLineCount >= 10, `Q${n} Telugu part`)
    assert.doesNotMatch(question.reviewReasons.join(' '), /NUMBER_SEQUENCE_GAP|ENGLISH_STEM_MISSING|DUPLICATE_OPTION|EMPTY_OPTION_TEXT/, `Q${n}`)
    assert.ok(question.proposedAnswer, `Q${n} answer`); assert.equal(question.status, 'READY', `Q${n} ${question.reviewReasons}`)
    // The question after it is no longer out of sequence.
    assert.doesNotMatch(twin(n + 1)[0].reviewReasons.join(' '), /NUMBER_SEQUENCE_GAP/)
  }
  // English then Telugu, in reading order: Q85 runs down the left column and continues at the head of the right one.
  const q85 = twin(85)[0], q90 = twin(90)[0]
  assert.match(q85.englishStem, /^Cocoas and chocolate products have been used as medicine/); assert.match(q85.options[0].text, /^Dark chocolate contains/)
  assert.deepEqual(q85.sourceRegions.map(r => [r.page, r.column]), [[12, 0], [12, 1]]); assert.deepEqual(q85.pages, [12])
  assert.deepEqual(q90.options.map(o => o.text), ['Both I and II', 'Both II and III', 'Only II', 'Only III'])
  assert.deepEqual(q90.sourceRegions.map(r => [r.page, r.column]), [[13, 0], [13, 1]])
  assert.deepEqual(twin(40)[0].sourceRegions.map(r => [r.page, r.column]), [[5, 1]])
  // The key has 200 answers and every question on these pages takes its own.
  assert.equal(twins.answerKey.entries.length, 200); assert.ok(twins.questions.every(x => x.proposedAnswer?.source === 'ANSWER_KEY_PAGE'))
  assert.deepEqual(twins.questions.map(x => x.proposedAnswer.letter), twins.questions.map(x => twins.answerKey.entries.find(e => e.number === x.number).letter))
})

test('Test-2: "Directions:" with no range before such a question belongs to that one question', () => {
  const linked = n => twins.materials.find(m => m.covers.join(',') === String(n))
  for (const n of [40, 80, 85, 90]) { assert.ok(linked(n), `Q${n} directions`); assert.equal(linked(n).rangeSource, 'SINGULAR_NEXT_QUESTION'); assert.equal(twin(n)[0].sharedMaterialIndex, linked(n).index) }
  assert.match(linked(85).englishText, /^Directions: Read the following statements carefully and answer the given questions:$/)
  assert.ok(!linked(85).reviewReasons.includes('MATERIAL_RANGE_UNKNOWN'))
  assert.equal(twins.materials.filter(m => m.rangeSource === 'UNLINKED').length, 0)
  // Ranged directions are untouched.
  for (const covers of ['37,38,39', '82,83,84', '87,88,89', '92,93,94']) assert.equal(twins.materials.find(m => m.covers.join(',') === covers).rangeSource, 'HEADING_RANGE')
})

test('a repeated number is merged only when an all-Telugu copy directly follows an English question; every other repeat stays', () => {
  const fonts = new Map([['latin', 'LATIN'], ['te', 'TELUGU_LEGACY']])
  let y = 800
  const line = (text, font = 'latin', number = null) => { y -= 14; const items = [...(number ? [{ str: `${number}.`, x: 28, y, width: 12, fontName: 'latin' }] : []), { str: text, x: 54, y, width: 200, fontName: font }]; return { page: 1, column: 0, y, x: items[0].x, right: 254, items, text: items.map(i => i.str).join(' ') } }
  const segment = (number, lines) => ({ number, lines, pages: [1], columns: ['1:0'], startLine: lines[0] })
  const english = n => segment(n, [line('Which river is the longest?', 'latin', n), line('A) Ganga B) Godavari'), line('C) Krishna D) Kaveri')])
  const telugu = n => segment(n, [line('glyphs', 'te', n), line('glyphs', 'te'), line('glyphs', 'te')])
  const run = (segments, extra = []) => { const ordered = [...segments.flatMap(s => s.lines), ...extra].sort((a, b) => b.y - a.y); return mergeTeluguRepeats(segments, ordered, fonts) }
  // English then, under the same number, Telugu: one question holding both parts in order.
  const pair = [english(7), telugu(7), english(8)], merged = run(pair)
  assert.deepEqual(merged.map(s => s.number), [7, 8]); assert.equal(merged[0].teluguHalfMerged, true); assert.equal(merged[0].lines.length, 6)
  assert.deepEqual(merged[0].lines, [...pair[0].lines, ...pair[1].lines]); assert.equal(merged[0].startLine, pair[0].lines[0]); assert.equal(merged[1].teluguHalfMerged, undefined)
  // Two English questions with the same number are two questions: the repeat stays for the teacher.
  assert.deepEqual(run([english(7), english(7), english(8)]).map(s => [s.number, !!s.teluguHalfMerged]), [[7, false], [7, false], [8, false]])
  // A Telugu copy that does not directly follow its number is not merged; nor is a Telugu-only question followed by another.
  assert.deepEqual(run([english(7), english(8), telugu(7)]).map(s => s.number), [7, 8, 7])
  assert.deepEqual(run([telugu(7), telugu(7)]).map(s => s.number), [7, 7])
  // Telugu directions between the two parts go with the question; English text between them means two questions.
  const first = english(7), between = line('telugu directions', 'te'), second = telugu(7)
  const withDirections = run([first, second], [between])
  assert.deepEqual(withDirections.map(s => s.number), [7]); assert.deepEqual(withDirections[0].lines, [...first.lines, between, ...second.lines])
  const a = english(9), note = line('Directions: read the next question'), b = telugu(9)
  assert.deepEqual(run([a, b], [note]).map(s => s.number), [9, 9])
  // A copy that carries English lines of its own is a different question.
  const mixed = segment(7, [line('glyphs', 'te', 7), line('A) Red B) Blue'), line('C) Green D) White')])
  assert.deepEqual(run([english(7), mixed]).map(s => s.number), [7, 7])
})
