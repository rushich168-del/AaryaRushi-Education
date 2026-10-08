import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import { buildReviewItems, deriveReadiness, actionCounts, ITEM_TYPES } from './lib/review-items.mjs'

// B4.5 — exception review model (pure). Synthetic persisted-Draft snapshots, plus golden checks
// over reports/b4-preview/draft-dump.json (written by scripts/b4-persist-local.mjs) when present.

let seq = 0
const id = p => `${p}-${++seq}`
const te = (quality, extra = {}) => ({ id: id('t'), language: 'te', text_quality: quality, content: null, ocr_verdict: null, ocr_review_reasons: [],
  ocr_confidence: null, source_media_id: null, ...extra })
const crop = (ocrText = null) => ({ id: id('m'), media_kind: 'TEXT_REGION', source_page: 3, region_x: 0.1, region_y: 0.2, region_w: 0.3, region_h: 0.04,
  detection_detail: ocrText ? { ocrText } : {} })
function question(number, { stem = 'Stem?', reasons = [], te: stemTe = null, options = null, key = 'KEY', proposed = 'A', material = null, media = [] } = {}) {
  const qid = id('q')
  const opts = (options || ['1', '2', '3', '4']).map((content, i) => ({ row: { id: id('o'), draft_question_id: qid, marker: 'ABCD'[i], position: i + 1,
    content, is_proposed_correct: 'ABCD'[i] === proposed, is_confirmed_correct: false }, texts: [] }))
  return { row: { id: qid, source_question_number: String(number), source_page: 3, content: stem, review_reasons: reasons, warnings: [],
    answer_key_source: key, shared_material_id: material }, media, texts: stemTe ? [stemTe] : [], options: opts }
}
const itemsOf = (items, type) => items.filter(i => i.item_type === type)

test('HIGH OCR is an advisory verification item — never blocking, never silently verified', () => {
  const c = crop()
  const q = question(1, { te: te('OCR_EXTRACTED', { content: 'ఏ దేశంలో', ocr_verdict: 'HIGH', ocr_confidence: 0.93, source_media_id: c.id }), media: [c] })
  const items = buildReviewItems({ questions: [q] })
  assert.equal(items.length, 1)
  assert.deepEqual([items[0].item_type, items[0].route, items[0].blocking, items[0].effort], ['TELUGU_VERIFY', 'ADVISORY', false, 'ONE_CLICK_ACCEPT'])
  assert.deepEqual(items[0].machine_reasons, ['OCR_HIGH_CONFIDENCE_UNVERIFIED'])
  assert.equal(items[0].source_media_id, c.id)
  assert.equal(items[0].source_region.page, 3)
  const [r] = deriveReadiness({ questions: [q] }, items)
  assert.deepEqual([r.readiness, r.openAdvisory], ['READY', 1], 'READY means no blocking item, not "OCR proven correct"')
})

test('Telugu routing: MEDIUM → one click; stored/attempted text → short correction; nothing → transcription; neutral rows → no item', () => {
  const withAttempt = crop('ఒక సంచి'), empty = crop()
  const q = question(2, { te: te('OCR_EXTRACTED', { content: 'ఒక', ocr_verdict: 'MEDIUM', ocr_confidence: 0.7, source_media_id: crop().id }) })
  q.options[0].texts = [te('MISSING', { ocr_verdict: 'LOW', ocr_review_reasons: ['LOW'], source_media_id: withAttempt.id })]
  q.options[1].texts = [te('MISSING', { ocr_verdict: 'EMPTY', ocr_review_reasons: ['EMPTY'], source_media_id: empty.id })]
  q.options[2].texts = [te('SCRIPT_NEUTRAL', { content: '15' })]
  q.options[3].texts = [te('MISSING', { ocr_review_reasons: ['TELUGU_OPTIONS_NOT_IN_SOURCE'] })]
  q.media = [withAttempt, empty]
  const items = buildReviewItems({ questions: [q] })
  assert.deepEqual(items.map(i => `${i.item_type}:${i.effort}`), ['TELUGU_STEM:ONE_CLICK_ACCEPT', 'TELUGU_OPTION:SHORT_CORRECTION', 'TELUGU_OPTION:TRANSCRIPTION'])
  assert.equal(items[1].extracted_value, 'ఒక సంచి', 'the unstored OCR attempt is shown for review')
  assert.equal(items[1].detail.stored, false)
  assert.equal(items[1].draft_option_id, q.options[0].row.id)
  assert.equal(items[1].target_option_text_id, q.options[0].texts[0].id)
  assert.equal(items[1].draft_question_id, null, 'exactly one owner')
  assert.equal(deriveReadiness({ questions: [q] }, items)[0].readiness, 'QUICK_CHECK')
})

test('an ambiguous Telugu block is a manual structure item', () => {
  const q = question(3, { te: te('MISSING', { ocr_review_reasons: ['STRUCTURE_AMBIGUOUS'] }) })
  const [i] = buildReviewItems({ questions: [q] })
  assert.deepEqual([i.item_type, i.route, i.effort], ['TELUGU_STRUCTURE_AMBIGUOUS', 'MANUAL_REVIEW', 'MANUAL_INVESTIGATION'])
  assert.equal(deriveReadiness({ questions: [q] }, [i])[0].readiness, 'MANUAL_REVIEW')
})

test('answer-key problems are explicit manual items; nothing is invented, created or confirmed', () => {
  const blank = question(4, { options: ['1/7', '2/7', '3/7', ''], proposed: 'D' })
  const noKey = question(5, { key: null, proposed: null })
  const noOption = question(6, { options: ['a', 'b', 'c'], proposed: 'D' })
  const snap = { questions: [blank, noKey, noOption] }
  const before = JSON.stringify(snap)
  const items = buildReviewItems(snap)
  assert.equal(JSON.stringify(snap), before, 'the snapshot is not mutated (no option text, no answer flag)')
  assert.deepEqual(itemsOf(items, 'ANSWER_KEY').map(i => `${i.detail.number}:${i.machine_reasons[0]}`),
    ['4:KEY_POINTS_AT_EMPTY_OPTION', '5:NO_ANSWER_KEY_ENTRY', '6:KEY_LETTER_HAS_NO_OPTION'])
  const empty = itemsOf(items, 'OPTION_EMPTY')
  assert.equal(empty.length, 1)
  assert.equal(empty[0].draft_option_id, blank.options[3].row.id)
  assert.equal(empty[0].extracted_value, null)
  assert.deepEqual(itemsOf(items, 'OPTION_SET_ABNORMAL').map(i => i.detail.number), [6])
  assert.ok(items.every(i => !('is_confirmed_correct' in i) && !('is_proposed_correct' in i)))
  assert.ok(deriveReadiness(snap, items).every(r => r.readiness === 'MANUAL_REVIEW'))
})

test('a shared material is reviewed once; resolving it clears every linked question', () => {
  const mat = { row: { id: 'mat-1', position: 3, applies_to_questions: [71, 72, 73, 74], review_reasons: ['TELUGU_MATERIAL_TEXT_NOT_EXTRACTED'], source_page_start: 9 },
    media: [crop(), { ...crop(), media_kind: 'FIGURE', detection_confidence: 0.9 }] }
  const qs = [71, 72, 73, 74].map(n => question(n, { material: 'mat-1' }))
  const snap = { questions: qs, materials: [mat] }
  const items = buildReviewItems(snap)
  assert.deepEqual(items.map(i => i.item_type), ['MATERIAL_TELUGU', 'MATERIAL_VISUAL_VERIFY'])
  assert.ok(items.every(i => i.draft_material_id === 'mat-1' && !i.draft_question_id))
  assert.deepEqual(items[0].detail.appliesTo, [71, 72, 73, 74])
  assert.ok(deriveReadiness(snap, items).every(r => r.readiness === 'QUICK_CHECK' && r.openBlocking === 1))
  assert.deepEqual(actionCounts(snap, items), { actual: 1, independent: 4, savedBySharing: 3 })
  const resolved = items.map(i => i.item_type === 'MATERIAL_TELUGU' ? { ...i, status: 'RESOLVED' } : i)
  assert.ok(deriveReadiness(snap, resolved).every(r => r.readiness === 'READY'), 'one resolution, four questions ready')
})

test('visuals: expected-but-missing is manual unless a material figure covers it; auto figures are advisory', () => {
  const fig = { ...crop(), media_kind: 'FIGURE', detection_confidence: 0.8 }
  const withFig = question(6, { reasons: ['VISUAL_EXPECTED_BUT_NONE_FOUND'], media: [fig] })
  const missing = question(7, { reasons: ['VISUAL_EXPECTED_BUT_NONE_FOUND'] })
  const mat = { row: { id: 'mat-2', position: 1, applies_to_questions: [8], review_reasons: [] }, media: [{ ...crop(), media_kind: 'FIGURE' }] }
  const covered = question(8, { reasons: ['VISUAL_EXPECTED_BUT_NONE_FOUND'], material: 'mat-2' })
  const rejected = question(9)
  const items = buildReviewItems({ questions: [withFig, missing, covered, rejected], materials: [mat] },
    { visualCandidates: { rejected: [{ id: 'p5-001', page: 5, questionNumber: 9, reasons: ['TOO_SMALL'], inkBoxPt: {} }, { id: 'p5-002', questionNumber: 9, reasons: ['WHITESPACE_NO_INK'] }] } })
  assert.deepEqual(itemsOf(items, 'QUESTION_VISUAL_MISSING').map(i => `${i.detail.number}:${i.detail.candidate}`), ['7:null', '9:p5-001'])
  assert.deepEqual(itemsOf(items, 'QUESTION_VISUAL_VERIFY').map(i => [i.detail.number, i.blocking]), [[6, false]])
})

test('structure: unowned text, missing English stem and unknown reasons are manual items', () => {
  const q = question(10, { stem: null, reasons: ['UNASSIGNED_TEXT_AFTER_OPTIONS', 'SOMETHING_NEW'] })
  q.row.warnings = ['UNASSIGNED_TEXT_AFTER_OPTIONS: Ramesh is taller']
  const items = buildReviewItems({ questions: [q] })
  assert.deepEqual(items.map(i => i.item_type), ['UNASSIGNED_TEXT', 'ENGLISH_STEM_MISSING', 'STRUCTURE'])
  assert.equal(items[0].extracted_value, 'Ramesh is taller')
  assert.deepEqual(items[2].machine_reasons, ['SOMETHING_NEW'])
})

test('every item: known type, consistent route/blocking, exactly one owner, unique key', () => {
  const q = question(11, { options: ['a', ''], key: null, te: te('MISSING', { ocr_review_reasons: ['EMPTY'] }) })
  const items = buildReviewItems({ questions: [q] })
  assert.equal(new Set(items.map(i => i.item_key)).size, items.length)
  for (const i of items) {
    assert.ok(ITEM_TYPES[i.item_type])
    assert.equal(i.route, ITEM_TYPES[i.item_type].route)
    assert.equal(i.blocking, i.route !== 'ADVISORY')
    assert.equal([i.draft_question_id, i.draft_option_id, i.draft_material_id].filter(Boolean).length, 1)
  }
})

// ---- golden paper -------------------------------------------------------------------------
const DUMP = 'reports/b4-preview/draft-dump.json'
const golden = fs.existsSync(DUMP) ? JSON.parse(fs.readFileSync(DUMP, 'utf8')) : null
const B43 = 'reports/b43/b43-manifest.json'
const skip = !golden?.reviewItems?.length ? 'run scripts/b4-persist-local.mjs first' : false

test('golden: regenerating items from the persisted Draft reproduces the stored items exactly', { skip }, () => {
  const b43 = fs.existsSync(B43) ? JSON.parse(fs.readFileSync(B43, 'utf8')) : null
  const again = buildReviewItems(golden, { visualCandidates: b43 })
  assert.deepEqual(again.map(i => i.item_key).sort(), golden.reviewItems.map(i => i.item_key).sort())
})

test('golden: routing metrics and readiness (view = pure derivation)', { skip }, () => {
  const items = golden.reviewItems
  assert.equal(items.length, 741)   // B4.8.4B: same items, re-routed (B4.8.3B 741/334/58-123-19/334-344-10; B4.8.2 749/341; B4.5R 755/358)
  // B4.8.4B pins (integer model + glyph hybrid + legacy decoder routing): reports/b484b/benchmark.json.
  assert.equal(items.filter(i => i.blocking).length, 263)
  const view = Object.fromEntries(golden.readiness.map(r => [r.draft_question_id, r.readiness]))
  const pure = deriveReadiness(golden, items)
  assert.ok(pure.every(r => view[r.draft_question_id] === r.readiness))
  const tally = pure.reduce((o, r) => (o[r.readiness] = (o[r.readiness] || 0) + 1, o), {})
  assert.deepEqual(tally, { READY: 67, QUICK_CHECK: 114, MANUAL_REVIEW: 19 })
  assert.deepEqual(actionCounts(golden, items), { actual: 263, independent: 273, savedBySharing: 10 })
  assert.equal(golden.questions.flatMap(q => q.options).filter(o => o.row.is_confirmed_correct).length, 0, 'no answer confirmed')
})

test('golden: HIGH OCR is never accepted automatically — right (Q105) stays optional; wrong (Q1-A) is caught by the decoder and blocks', { skip }, () => {
  // Q105's stem is read correctly by integer + glyph ("ఏ దేశంలో"); Q1-A is HIGH and WRONG with the
  // integer model ("విదికాదు" for "ఏదికాదు"). B4.8.4B: the independent glyph reading disagrees, so
  // Q1-A becomes a BLOCKING check carrying the suggestion; the stored text is still the OCR's.
  const q105 = golden.questions.find(q => q.row.source_question_number === '105')
  const stem = golden.reviewItems.find(i => i.target_question_text_id === q105.texts.find(t => t.language === 'te').id)
  assert.equal(stem.item_type, 'TELUGU_VERIFY')
  assert.equal(stem.status, 'OPEN')
  assert.ok(stem.confidence >= 0.8)
  const q1a = golden.questions.find(q => q.row.source_question_number === '1').options.find(o => o.row.marker === 'A').texts.find(t => t.language === 'te')
  assert.equal(q1a.verification_state, null)
  const a = golden.reviewItems.find(i => i.target_option_text_id === q1a.id)
  assert.deepEqual([a.item_type, a.status, a.blocking], ['TELUGU_OPTION', 'OPEN', true])
  assert.deepEqual(a.machine_reasons, ['MEDIUM', 'OCR_DECODER_DISAGREE'])
  assert.equal(a.detail.decoder.suggestion, 'ఏదికాదు')
  assert.equal(a.extracted_value, 'విదికాదు')
  assert.match(a.detail.ocr.version, /ksc-glyph-hybrid@1.0.0$/)
})
