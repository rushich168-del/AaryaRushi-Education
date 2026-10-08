import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitInlineMarker, recoverNeutralNumericOptions, scoreQuestion, FIGURE_WORDS, FIGURE_PHRASES } from './lib/paper-layout.mjs'
import { decodeNeutralNumeric } from './lib/telugu-glyph-hybrid.mjs'
import { questionTeluguStructure } from './lib/telugu-structure.mjs'
import { withSuspectCharacterFlag, hasSuspectCharacters, OCR_SUSPECT_CHARACTERS } from './lib/telugu-ocr-core.mjs'
import { buildReviewItems } from './lib/review-items.mjs'
import { mapPaperModelToDraft } from './lib/paper-model-to-draft.mjs'

// B4.8.2 — deterministic exception reduction (pure). Each rule is tested on the golden shapes it was
// built for AND on the neighbouring shapes it must refuse. No PDF, OCR engine or database.

const LEGACY = s => String.fromCharCode(...[...s].map(c => 0xF000 + c.charCodeAt(0)))   // legacy-font glyph run
const PAREN = String.fromCharCode(0xF029, 0xF020)                                       // the font's ")" + space
const FSM = new Map([['te', 'TELUGU_LEGACY'], ['en', 'LATIN']])
const it_ = (str, x, fontName = 'en', width = 30) => ({ str, x, width, height: 10, fontName })
const line = (y, items) => ({ page: 18, column: 0, y, items })
const opts = (...texts) => texts.map((text, i) => ({ position: i, marker: 'ABCD'[i], text }))
const parsed = (...pairs) => pairs.map(([marker, text]) => ({ marker, text, page: 1, column: 0, at: null }))

// ---------- 1. stuck option markers ------------------------------------------------------------
test('split: "C) Iron D)Aluminium" (Q126), "DevaB) Ganapathi" (Q135), "foreskin D) Scaly skin" (Q115)', () => {
  const q126 = splitInlineMarker(parsed(['A', 'Silver'], ['B', 'Copper'], ['C', 'Iron D)Aluminium']))
  assert.deepEqual(q126.options.map(o => `${o.marker}:${o.text}`), ['A:Silver', 'B:Copper', 'C:Iron', 'D:Aluminium'])
  assert.deepEqual(q126.record, { kind: 'SPLIT_AT_INLINE_MARKER', host: 'C', marker: 'D', source: 'Iron D)Aluminium' })
  const q135 = splitInlineMarker(parsed(['A', 'Prathaparudra DevaB) Ganapathi Deva'], ['C', 'Rudrama Devi'], ['D', 'Prathaparudra II']))
  assert.deepEqual(q135.options.map(o => o.text), ['Prathaparudra Deva', 'Ganapathi Deva', 'Rudrama Devi', 'Prathaparudra II'])
  const q115 = splitInlineMarker(parsed(['A', 'Airmen'], ['B', 'Blubbers'], ['C', 'Absence of foreskin D) Scaly skin']))
  assert.deepEqual(q115.options.map(o => o.text), ['Airmen', 'Blubbers', 'Absence of foreskin', 'Scaly skin'])
})

test('split refuses anything not provable (Q28 and neighbours stay with the teacher)', () => {
  // Q28: D already exists (empty, a separate marker) and markers were duplicated -> ambiguous.
  assert.equal(splitInlineMarker(parsed(['A', 'Immediate left'], ['B', 'Second to the left'], ['C', 'Third to the rightD) Second to the right'], ['D', '']), 1), null)
  assert.equal(splitInlineMarker(parsed(['A', 'x'], ['B', 'y'], ['C', 'z D) w']), 1), null, 'duplicate markers')
  assert.equal(splitInlineMarker(parsed(['A', 'x'], ['B', 'y D) w'], ['C', 'z'])), null, 'embedded D is not in the option before D')
  assert.equal(splitInlineMarker(parsed(['A', 'x'], ['B', 'y'], ['C', 'z B) w'])), null, 'embedded letter is not the missing one')
  assert.equal(splitInlineMarker(parsed(['A', 'x C) p'], ['B', 'y'], ['C', 'z D) w'])), null, 'two embedded markers')
  assert.equal(splitInlineMarker(parsed(['A', 'Both (A) and'], ['B', 'y'], ['C', 'z'])), null, '"(A)" is text, not a marker')
  assert.equal(splitInlineMarker(parsed(['B', 'y'], ['C', 'z'], ['D', 'w A) v'])), null, 'a missing A is never recovered')
  assert.equal(splitInlineMarker(parsed(['A', 'x'], ['B', 'y'], ['C', 'z D)'])), null, 'no text after the marker: never create an empty option')
  assert.equal(splitInlineMarker(parsed(['A', 'x'], ['B', 'y'], ['C', 'D) w'])), null, 'no text before the marker')
  assert.equal(splitInlineMarker(parsed(['A', 'x'], ['B', 'y'], ['C', 'z'], ['D', 'w'])), null, 'complete sets are untouched')
})

// ---------- 2. script-neutral numbers in the legacy Telugu font -------------------------------
test('decodeNeutralNumeric: digits and number punctuation only; anything else refuses the run', () => {
  assert.equal(decodeNeutralNumeric(PAREN + LEGACY('1921')), '1921')
  assert.equal(decodeNeutralNumeric(PAREN + LEGACY('50%')), '50%')
  assert.equal(decodeNeutralNumeric(PAREN + LEGACY('2,500')), '2,500')
  assert.equal(decodeNeutralNumeric(PAREN + LEGACY('15 km')), null, 'letter glyphs are never decoded')
  assert.equal(decodeNeutralNumeric(PAREN + LEGACY('(10)')), null, 'brackets are not neutral number punctuation here')
  assert.equal(decodeNeutralNumeric(PAREN + String.fromCharCode(0xF0F6, 0xF0F6)), null, '॥ is not a number')
  assert.equal(decodeNeutralNumeric(PAREN + LEGACY('.,')), null, 'no digit')
  assert.equal(decodeNeutralNumeric(''), null)
})

const q125Lines = (extra = []) => [
  line(560, [it_('125.', 27), it_('In which year was Albert Einstein awarded the Nobel Prize?', 54, 'en', 220)]),
  line(540, [it_(LEGACY('prashna'), 54, 'te', 220)]),
  line(520, [it_('A', 54, 'en', 8), it_(PAREN + LEGACY('1921'), 62, 'te', 36), it_('B', 103, 'en', 8), it_(PAREN + LEGACY('1922'), 111, 'te', 36),
    it_('C', 150, 'en', 8), it_(PAREN + LEGACY('1923'), 158, 'te', 36), it_('D', 207, 'en', 8), it_(PAREN + LEGACY('1924'), 215, 'te', 36)]),
  ...extra,
]
const bareOptions = ls => ['A', 'B', 'C', 'D'].map((m, i) => {
  const l = ls.find(x => x.items.some(it => it.str === m))
  const it = l.items.find(x => x.str === m)
  return { position: i, marker: m, text: '', page: l.page, column: l.column, at: { page: l.page, column: l.column, x: it.x, y: l.y } }
})

test('English option recovery: Q125 numbers drawn in the Telugu font become the English options, with provenance', () => {
  const ls = q125Lines()
  const o = bareOptions(ls)
  assert.deepEqual(recoverNeutralNumericOptions(o, ls, FSM), ['A', 'B', 'C', 'D'])
  assert.deepEqual(o.map(x => x.text), ['1921', '1922', '1923', '1924'])
  assert.ok(o.every(x => x.textSource === 'TEXT_FROM_LEGACY_GLYPH_DIGITS'))
})

test('English option recovery refuses stacked maths (Q124 exponents), duplicates, letters and existing text', () => {
  // Q124: "10" on the marker line, exponents on a raised line 5 pt above -> refused, options stay empty.
  const exps = line(525.5, [it_(LEGACY('10'), 82, 'te', 10), it_(LEGACY('11'), 133, 'te', 10), it_(LEGACY('15'), 179, 'te', 10), it_(LEGACY('21'), 232, 'te', 10)])
  const q124 = [line(520, [it_('A', 54, 'en', 8), it_(PAREN + LEGACY('10'), 62, 'te', 20), it_('B', 105, 'en', 8), it_(PAREN + LEGACY('10'), 113, 'te', 20),
    it_('C', 150, 'en', 8), it_(PAREN + LEGACY('10'), 158, 'te', 20), it_('D', 203, 'en', 8), it_(PAREN + LEGACY('10'), 212, 'te', 20)]), exps]
  const o124 = bareOptions(q124)
  assert.deepEqual(recoverNeutralNumericOptions(o124, q124, FSM), [])
  assert.ok(o124.every(x => x.text === ''))
  // Same values without the exponent line are still refused: an option set never repeats a value.
  const flat = [q124[0]]
  assert.deepEqual(recoverNeutralNumericOptions(bareOptions(flat), flat, FSM), [])
  // Telugu words are never copied into English.
  const words = [line(520, [it_('A', 54, 'en', 8), it_(PAREN + LEGACY('vidikadu'), 62, 'te', 40), it_('B', 150, 'en', 8), it_(PAREN + LEGACY('1922'), 158, 'te', 36)])]
  const ow = [{ marker: 'A', text: '', at: { page: 18, column: 0, x: 54, y: 520 } }, { marker: 'B', text: '', at: { page: 18, column: 0, x: 150, y: 520 } }]
  assert.deepEqual(recoverNeutralNumericOptions(ow, words, FSM), ['B'])
  assert.equal(ow[0].text, '')
  // An option that already has English text is untouched.
  const ls = q125Lines(); const o = bareOptions(ls); o[0].text = '1921 AD'
  recoverNeutralNumericOptions(o, ls, FSM)
  assert.equal(o[0].text, '1921 AD'); assert.equal(o[0].textSource, undefined)
})

test('Telugu structure: digits-only legacy runs are script-neutral options (no OCR unit, not in the stem)', () => {
  const ls = q125Lines()
  const s = questionTeluguStructure({ lines: ls }, { options: opts('1921', '1922', '1923', '1924') }, FSM, 27)
  assert.equal(s.structure, 'STEM_WITH_NEUTRAL_OPTIONS')
  assert.deepEqual(s.units.map(u => u.kind), ['STEM'])
  assert.equal(s.units[0].itemCount, 1, 'only the Telugu stem line is OCR input')
  // Q118 shape: English options exist and equal the glyph digits -> the same.
  const q118 = questionTeluguStructure({ lines: ls }, { options: opts('1921', '1922', '1923', '1924') }, FSM, 27)
  assert.equal(q118.structure, 'STEM_WITH_NEUTRAL_OPTIONS')
  // If the English differs from the glyph digits, nothing is assumed: the runs stay Telugu units.
  const differ = questionTeluguStructure({ lines: ls }, { options: opts('1921', '1922', '1923', '1925') }, FSM, 27)
  assert.deepEqual(differ.units.map(u => `${u.kind}${u.marker ?? ''}`), ['STEM', 'OPTIOND'])
  // Real Telugu option text is never treated as neutral.
  const te = [ls[0], ls[1], line(520, [it_('A', 54, 'en', 8), it_(PAREN + LEGACY('uttara'), 62, 'te'), it_('B', 150, 'en', 8), it_(PAREN + LEGACY('dakshina'), 158, 'te')]),
    line(505, [it_('C', 54, 'en', 8), it_(PAREN + LEGACY('turpu'), 62, 'te'), it_('D', 150, 'en', 8), it_(PAREN + LEGACY('padamara'), 158, 'te')])]
  const t = questionTeluguStructure({ lines: te }, { options: opts('North', 'South', 'East', 'West') }, FSM, 27)
  assert.equal(t.structure, 'STEM_AND_OPTIONS')
})

// ---------- 3. figure trigger -------------------------------------------------------------------
const baseQ = (stem, { gaps = 0, options = opts('a', 'b', 'c', 'd') } = {}) => ({
  number: 1, englishStem: stem, englishText: `${stem} ${options.map(o => o.text).join(' ')}`, options, optionDuplicates: 0, unassignedEnglish: '',
  teluguRegions: [{}], visuals: { attached: [], rejected: [], figureGaps: Array.from({ length: gaps }, () => ({})) },
})
const reasonsOf = (q) => scoreQuestion(q, { expectedNumber: 1, keyEntry: { letter: 'A' }, columnConfident: true }).reviewReasons

test('figure trigger: golden false positives no longer ask for a figure', () => {
  assert.ok(!reasonsOf(baseQ('Nagauri Paan Methi is registered under which act?', { options: opts('Seeds Act', 'PPVFR Act', 'Geographical Indications of Goods Act', 'APMC Act') })).includes('VISUAL_EXPECTED_BUT_NONE_FOUND'), 'Q193 "Geographical"')
  assert.ok(!reasonsOf(baseQ('What stories do Ajanta images convey?')).includes('VISUAL_EXPECTED_BUT_NONE_FOUND'), 'Q145 "images"')
  assert.ok(!reasonsOf(baseQ('Choose the opposite of the highlighted word in the sentence given below.')).includes('VISUAL_EXPECTED_BUT_NONE_FOUND'), 'Q92')
  assert.ok(!reasonsOf(baseQ('Select the answer by the codes given below?')).includes('VISUAL_EXPECTED_BUT_NONE_FOUND'), 'Q173')
  assert.ok(!reasonsOf(baseQ('In a military secret service map, South-East is shown as North. What will West become?')).includes('VISUAL_EXPECTED_BUT_NONE_FOUND'), 'Q23 "map"')
})

test('figure trigger: genuine figure wording still flags a missing figure; weak phrases count only with layout evidence', () => {
  for (const stem of ['Count the number of triangles in the figure given below.', 'Study the following diagram carefully.', 'Refer to the pie chart and answer.', 'The bar graph shows sales.', 'Use the Venn diagram.'])
    assert.ok(reasonsOf(baseQ(stem)).includes('VISUAL_EXPECTED_BUT_NONE_FOUND'), stem)
  const withGap = reasonsOf(baseQ('Which image comes next in the series shown below?', { gaps: 1 }))
  assert.ok(withGap.includes('VISUAL_FROM_LAYOUT_GAP_NEEDS_CONFIRMATION') && !withGap.includes('VISUAL_EXPECTED_BUT_NONE_FOUND'))
  const withoutGap = reasonsOf(baseQ('Which image comes next in the series shown below?'))
  assert.ok(!withoutGap.some(r => r.startsWith('VISUAL_')))
  assert.ok(FIGURE_WORDS.test('figures') && !FIGURE_WORDS.test('Geographical') && !FIGURE_WORDS.test('configured') && FIGURE_PHRASES.test('images'))
})

// ---------- 4. diagnostics that only ADD reasons ------------------------------------------------
test('duplicate extracted option text is an option-set defect (a manual item), never READY', () => {
  const r = reasonsOf(baseQ('The height of the tower is?', { options: opts('35', '70', '', '70') }))
  assert.ok(r.includes('DUPLICATE_OPTION_TEXT'))
  const snapshot = { materials: [], questions: [{ row: { id: 'q', source_question_number: '75', content: 'x', review_reasons: ['DUPLICATE_OPTION_TEXT'], answer_key_source: 'K', source_page: 12 },
    media: [], texts: [], options: ['35', '70', '35√3', '70'].map((c, i) => ({ row: { id: `o${i}`, marker: 'ABCD'[i], content: c, is_proposed_correct: i === 1 }, texts: [] })) }] }
  const items = buildReviewItems(snapshot)
  const set = items.find(i => i.item_type === 'OPTION_SET_ABNORMAL')
  assert.ok(set && set.blocking && set.route === 'MANUAL_REVIEW')
  assert.deepEqual(set.machine_reasons, ['DUPLICATE_OPTION_TEXT'])
})

test('suspect OCR characters add a reason and never raise a verdict', () => {
  for (const s of ['౨-2, బి-4, సి-3, డి-1', 'జాబితా-£2', 'ఎ-ా4, బి-3', 'హేతువు (౨): అధిక']) assert.ok(hasSuspectCharacters(s), s)
  for (const s of ['ఎ-1, బి-2, సి-3, డి-4', 'విశ్వంలోని మొత్తం నక్షత్రాల సంఖ్య', 'రూ॥ 450', '1921']) assert.ok(!hasSuspectCharacters(s), s)
  const high = withSuspectCharacterFlag({ text: '౨-2, బి-4', verdict: 'HIGH', flags: [] })
  assert.equal(high.verdict, 'MEDIUM'); assert.deepEqual(high.flags, [OCR_SUSPECT_CHARACTERS])
  assert.equal(withSuspectCharacterFlag({ text: 'జాబితా-£2', verdict: 'LOW', flags: [] }).verdict, 'LOW')
  assert.equal(withSuspectCharacterFlag({ text: 'జాబితా-£2', verdict: 'DIGIT_MISMATCH', flags: [] }).verdict, 'DIGIT_MISMATCH')
  const clean = { text: 'ఎ-1, బి-2', verdict: 'HIGH', flags: [] }
  assert.equal(withSuspectCharacterFlag(clean), clean)
})

// ---------- provenance in the Draft payload -----------------------------------------------------
test('repaired options carry their provenance; answers stay proposed only', () => {
  const model = { stats: {}, materials: [], questions: [
    { number: 125, pages: [18], englishStem: 'In which year?', reviewReasons: [], proposedAnswer: { letter: 'A', position: 0, source: 'ANSWER_KEY_PAGE' },
      options: ['1921', '1922', '1923', '1924'].map((text, position) => ({ position, marker: 'ABCD'[position], text, textSource: 'TEXT_FROM_LEGACY_GLYPH_DIGITS' })),
      optionRepairs: [{ kind: 'TEXT_FROM_LEGACY_GLYPH_DIGITS', markers: ['A', 'B', 'C', 'D'] }] },
    { number: 126, pages: [18], englishStem: 'Which is the most pure metal?', reviewReasons: [], proposedAnswer: { letter: 'D', position: 3, source: 'ANSWER_KEY_PAGE' },
      options: ['Silver', 'Copper', 'Iron', 'Aluminium'].map((text, position) => ({ position, marker: 'ABCD'[position], text })),
      optionRepairs: [{ kind: 'SPLIT_AT_INLINE_MARKER', host: 'C', marker: 'D', source: 'Iron D)Aluminium' }] },
  ] }
  const p = mapPaperModelToDraft(model, { importId: 'imp' })
  assert.ok(p.options.filter(o => o.draft_question_id === p.questions[0].id).every(o => o.warnings.includes('TEXT_FROM_LEGACY_GLYPH_DIGITS')))
  assert.deepEqual(p.questions[1].warnings, ['OPTION_SPLIT_AT_INLINE_MARKER(C|D): Iron D)Aluminium'])
  assert.deepEqual(p.options.filter(o => o.draft_question_id === p.questions[1].id).map(o => o.warnings.length), [0, 0, 1, 1])
  assert.equal(p.options.filter(o => o.is_proposed_correct).length, 2)
  assert.ok(p.options.every(o => !('is_confirmed_correct' in o)), 'the mapper never writes a confirmed answer')
})
