import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import {
  FILTERS, allowedActions, buildQueue, filterCounts, indexDraft, itemLabel, nextAfter, provenanceText, reasonText, summarize, teluguContent, teluguState,
} from '../src/services/draftReviewModel.js'

// B4.6 — Review Center view model (pure). Synthetic cases, plus golden checks over the persisted
// B4.5R Draft (reports/b4-preview/draft-dump.json from scripts/b4-persist-local.mjs).

// dump (nested) -> the flat rows the service returns
export function flatten(d) {
  const questions = d.questions.map(q => q.row)
  return {
    paper: d.paper, questions,
    options: d.questions.flatMap(q => (q.options || []).map(o => o.row)),
    questionTexts: d.questions.flatMap(q => q.texts), optionTexts: d.questions.flatMap(q => (q.options || []).flatMap(o => o.texts)),
    media: [...d.questions.flatMap(q => q.media), ...d.materials.flatMap(m => m.media)],
    materials: d.materials.map(m => m.row), materialTexts: d.materialTexts || [], items: d.reviewItems, readiness: d.readiness,
  }
}

const item = (o) => ({ id: o.id, item_key: o.id, status: 'OPEN', blocking: o.route !== 'ADVISORY', machine_reasons: [], detail: {}, draft_question_id: null, draft_option_id: null, draft_material_id: null, ...o })
function synthetic() {
  const q1 = { id: 'q1', position: 0, source_question_number: '1', content: 'Stem', source_page: 1 }
  const q2 = { id: 'q2', position: 1, source_question_number: '2', content: 'Stem 2', source_page: 1, shared_material_id: 'm1' }
  const q3 = { id: 'q3', position: 2, source_question_number: '3', content: 'Stem 3', source_page: 1, shared_material_id: 'm1' }
  const oA = { id: 'oA', draft_question_id: 'q1', position: 0, marker: 'A', content: 'None', is_proposed_correct: true, is_confirmed_correct: false }
  const oB = { id: 'oB', draft_question_id: 'q1', position: 1, marker: 'B', content: null, is_proposed_correct: false, is_confirmed_correct: false }
  const crop = { id: 'c1', draft_question_id: 'q1', media_kind: 'TEXT_REGION', capture_method: 'AUTO_REGION', storage_path: 'p/c1.png', source_page: 1,
    detection_detail: { ocrText: 'విదికాదు', ocrRawText: 'విదికాదు', ocrEngine: 'tesseract.js', ocrVersion: '7.0.0+tessdata/tel.traineddata (integer)@7d092812889d+ksc-glyph-hybrid@1.0.0' } }
  const crop2 = { id: 'c2', draft_question_id: 'q1', media_kind: 'TEXT_REGION', capture_method: 'AUTO_REGION', storage_path: 'p/c2.png', source_page: 1, detection_detail: { ocrText: 'ఒకటి' } }
  const tA = { id: 'tA', draft_option_id: 'oA', language: 'te', text_quality: 'OCR_EXTRACTED', content: 'విదికాదు', ocr_verdict: 'HIGH', ocr_confidence: 0.89, source_media_id: 'c1',
    ocr_engine: 'tesseract.js', ocr_version: crop.detection_detail.ocrVersion, verification_state: null }
  const tB = { id: 'tB', draft_option_id: 'oB', language: 'te', text_quality: 'MISSING', content: null, ocr_verdict: 'LOW', ocr_confidence: 0.4, source_media_id: 'c2', verification_state: null }
  const items = [
    item({ id: 'i1', item_type: 'TELUGU_VERIFY', route: 'ADVISORY', draft_option_id: 'oA', target_option_text_id: 'tA', source_media_id: 'c1', machine_reasons: ['OCR_HIGH_CONFIDENCE_UNVERIFIED'] }),
    item({ id: 'i2', item_type: 'TELUGU_OPTION', route: 'QUICK_CHECK', draft_option_id: 'oB', target_option_text_id: 'tB', source_media_id: 'c2', machine_reasons: ['LOW'] }),
    item({ id: 'i3', item_type: 'OPTION_EMPTY', route: 'MANUAL_REVIEW', draft_option_id: 'oB' }),
    item({ id: 'i4', item_type: 'ANSWER_KEY', route: 'MANUAL_REVIEW', draft_question_id: 'q1', machine_reasons: ['KEY_POINTS_AT_EMPTY_OPTION'] }),
    item({ id: 'i5', item_type: 'MATERIAL_TELUGU', route: 'QUICK_CHECK', draft_material_id: 'm1' }),
    item({ id: 'i6', item_type: 'UNASSIGNED_TEXT', route: 'MANUAL_REVIEW', draft_question_id: 'q1' }),
    item({ id: 'i7', item_type: 'TELUGU_STEM', route: 'QUICK_CHECK', draft_question_id: 'q1', status: 'RESOLVED', resolution: 'ACCEPTED_OCR' }),
  ]
  const readiness = [
    { draft_question_id: 'q1', readiness: 'MANUAL_REVIEW', open_blocking: 4, open_advisory: 1 },
    { draft_question_id: 'q2', readiness: 'QUICK_CHECK', open_blocking: 1, open_advisory: 0 },
    { draft_question_id: 'q3', readiness: 'QUICK_CHECK', open_blocking: 1, open_advisory: 0 },
  ]
  return indexDraft({ questions: [q1, q2, q3], options: [oA, oB], questionTexts: [], optionTexts: [tA, tB], media: [crop, crop2], materials: [{ id: 'm1', position: 0 }], materialTexts: [], items, readiness })
}

test('only Telugu OCR items can be accepted; must-fix items can never be accepted as is', () => {
  const ix = synthetic()
  const by = id => ix.items.find(i => i.id === id)
  assert.equal(allowedActions(ix, by('i1')).accept, true, 'stored HIGH OCR can be accepted (and verified)')
  assert.equal(allowedActions(ix, by('i2')).accept, true, 'an unstored Telugu OCR attempt can be accepted from its crop')
  for (const id of ['i3', 'i4', 'i5', 'i6']) assert.equal(allowedActions(ix, by(id)).accept, false, id)
  assert.equal(allowedActions(ix, by('i3')).acceptAsIs, false)
  assert.equal(allowedActions(ix, by('i4')).acceptAsIs, false)
  assert.equal(allowedActions(ix, by('i6')).acceptAsIs, true, 'unowned text may be accepted as is with a note')
  assert.equal(allowedActions(ix, by('i3')).typeOption, true)
  assert.equal(allowedActions(ix, by('i7')).accept, false, 'resolved: no second acceptance')
  assert.equal(allowedActions(ix, by('i7')).edit, true, 'resolved Telugu can still be revised (0028)')
})

test('HIGH OCR is never described as verified; only a teacher decision is', () => {
  assert.match(teluguState({ text_quality: 'OCR_EXTRACTED', ocr_verdict: 'HIGH' }).label, /not yet verified/)
  assert.doesNotMatch(teluguState({ text_quality: 'OCR_EXTRACTED', ocr_verdict: 'HIGH' }).label, /^(OCR )?verified|correct/i)
  assert.equal(teluguState({ text_quality: 'OCR_EXTRACTED', verification_state: 'VERIFIED_OCR' }).label, 'OCR verified by teacher')
  assert.match(teluguState({ text_quality: 'TEACHER_ENTERED', verification_state: 'EDITED_FROM_OCR' }).label, /original OCR kept/)
  assert.match(reasonText('OCR_HIGH_CONFIDENCE_UNVERIFIED'), /confidence is not correctness/)
})

test('filters: blocking categories, optional separate, resolved separate; queue order and auto-advance', () => {
  const ix = synthetic()
  const c = filterCounts(ix)
  assert.deepEqual(c, { blocking: 5, quick: 2, manual: 3, telugu: 1, optionStructure: 2, answerKey: 1, visual: 0, sharedMaterial: 1, optional: 1, resolved: 1 })
  const q = buildQueue(ix, 'blocking').map(i => i.id)
  // Q1's items in stem -> option order; the shared material once, just before its first linked question (Q2).
  assert.deepEqual(q, ['i6', 'i4', 'i2', 'i3', 'i5'])
  assert.equal(nextAfter(buildQueue(ix, 'blocking'), buildQueue(ix, 'blocking').filter(i => i.id !== 'i4'), 'i4'), 'i2')
  assert.equal(nextAfter([{ id: 'x' }], [], 'x'), null)
  assert.equal(itemLabel(ix, ix.items.find(i => i.id === 'i5')), 'Shared material M1 · Q2, Q3')
  const s = summarize(ix)
  assert.deepEqual([s.blockingTotal, s.blockingResolved, s.blockingOpen, s.optionalOpen, s.draftReady], [6, 1, 5, 1, false])
})

test('Telugu content: stored text vs unstored attempt, provenance text', () => {
  const ix = synthetic()
  const a = teluguContent(ix, ix.items.find(i => i.id === 'i1'))
  assert.deepEqual([a.current, a.stored, a.provenance.confidence], ['విదికాదు', 'విదికాదు', 0.89])
  const b = teluguContent(ix, ix.items.find(i => i.id === 'i2'))
  assert.deepEqual([b.current, b.stored, b.attempt], ['ఒకటి', null, 'ఒకటి'])
  assert.equal(provenanceText(a.provenance), 'tesseract.js 7.0.0 · tessdata/tel.traineddata (integer) · glyph hybrid 1.0.0')
})

// ---- golden ---------------------------------------------------------------------------------------
const DUMP = 'reports/b4-preview/draft-dump.json'
const golden = fs.existsSync(DUMP) ? JSON.parse(fs.readFileSync(DUMP, 'utf8')) : null
const skip = !golden?.reviewItems?.length ? 'run scripts/b4-persist-local.mjs first' : false
const G = () => indexDraft(flatten(golden))

// B4.8.4B decoder routing (B4.8.3B: 58/123/19, 334, 407; B4.8.2: 57/124/19, 341, 408; B4.5R: 54/121/25, 358, 397):
// see reports/b484b/benchmark.json and docs/ksc/B4.8.4B-HYBRID-TELUGU-EXTRACTION.md.
test('golden: summary counts are the persisted B4.8.4B routing (67 / 114 / 19; 263 blocking; 478 optional)', { skip }, () => {
  const s = summarize(G())
  assert.deepEqual([s.totalQuestions, s.noBlocking, s.quickCheck, s.manualReview, s.blockingOpen, s.blockingTotal, s.optionalOpen], [200, 67, 114, 19, 263, 263, 478])
  assert.ok(s.readyWithOptionalOutstanding > 0 && s.readyWithOptionalOutstanding <= 67)
  const c = filterCounts(G())
  assert.deepEqual([c.blocking, c.telugu, c.sharedMaterial, c.visual, c.optionStructure, c.answerKey, c.optional, c.resolved], [263, 218, 10, 3, 28, 4, 478, 0])
  assert.equal(c.quick + c.manual, 263)
  assert.equal(c.telugu + c.sharedMaterial + c.visual + c.optionStructure + c.answerKey, 263, 'categories partition the blocking items')
})

test('golden: Q1-A (HIGH, wrong) now BLOCKS with the decoder suggestion (B4.8.4B); Q105 (HIGH, improved) stays optional', { skip }, () => {
  const ix = G()
  const q1 = ix.questions.find(q => q.source_question_number === '1')
  const a = ix.optionsByQuestion.get(q1.id).find(o => o.marker === 'A')
  const it = ix.items.find(i => i.target_option_text_id === ix.optionText.get(a.id).id)
  assert.deepEqual([it.item_type, it.blocking], ['TELUGU_OPTION', true])
  assert.ok(it.machine_reasons.includes('OCR_DECODER_DISAGREE'))
  const c = teluguContent(ix, it)
  assert.deepEqual([c.current, c.suggestion], ['విదికాదు', 'ఏదికాదు'], 'OCR text kept; the independent reading is only a suggestion')
  assert.match(teluguState(ix.optionText.get(a.id)).label, /not yet verified/)
  assert.deepEqual([allowedActions(ix, it).accept, allowedActions(ix, it).edit], [true, true])
  assert.ok(buildQueue(ix, 'blocking').some(i => i.id === it.id))
  const q105 = ix.questions.find(q => q.source_question_number === '105')
  const s = ix.items.find(i => i.target_question_text_id === ix.questionText.get(q105.id).id)
  assert.equal(s.item_type, 'TELUGU_VERIFY')
  assert.match(teluguContent(ix, s).current, /ఏ దేశంలో/)
})

test('golden: shared materials appear once each, never duplicated per linked question', { skip }, () => {
  const ix = G()
  const mat = ix.items.filter(i => i.draft_material_id)
  const keys = mat.map(i => `${i.item_type}:${i.draft_material_id}:${i.source_media_id || ''}`)
  assert.equal(new Set(keys).size, keys.length)
  for (const range of [['11', '12'], ['36', '37', '38', '39'], ['71', '72', '73', '74'], ['81', '82', '83', '84']]) {
    const qs = range.map(n => ix.questions.find(q => q.source_question_number === n))
    const m = qs[0].shared_material_id
    assert.ok(m && qs.every(q => q.shared_material_id === m), `Q${range.join(',')} share one material`)
    assert.ok(!ix.items.some(i => i.item_type === 'MATERIAL_TELUGU' && qs.some(q => i.draft_question_id === q.id)), 'no per-question material work')
  }
})

test('golden: never a generic accept on structural or answer items', { skip }, () => {
  const ix = G()
  for (const i of ix.items) {
    const a = allowedActions(ix, i)
    if (!['TELUGU_STEM', 'TELUGU_OPTION', 'TELUGU_VERIFY'].includes(i.item_type)) assert.equal(a.accept, false, i.item_type)
    if (['ANSWER_KEY', 'OPTION_EMPTY'].includes(i.item_type)) assert.equal(a.acceptAsIs, false)
  }
  assert.equal(FILTERS.length, 10)
})
