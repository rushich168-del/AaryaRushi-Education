import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { unitSourceKey, unitSourceFingerprint, printedDigitTokens, printedDigitEvidence } from './lib/telugu-source-evidence.mjs'
import { assembleUnit } from './lib/telugu-ocr-core.mjs'
import { indexDraft, isOpen } from '../src/services/draftReviewModel.js'
import { buildTeluguReview, laneCounts, laneQuestions, issueOf, classifyDecision, teacherEvidence, activeUnitOf, nextQuestionAfter, UNIT_TYPES } from '../src/services/teluguReviewModel.js'
import { flatten, workload } from './b484c-workload.mjs'

// B4.8.4C — source evidence (pure) and the question-level Telugu Review model. Synthetic cases, plus
// invariants over the fresh Node golden dump (reports/b484c/node-dump.json from b484c-golden-prepare.mjs).

const G = h => String.fromCharCode(0xF000 + h)
const D = n => [...String(n)].map(c => G(0x30 + Number(c))).join('')      // legacy digit glyphs
const L = G(0xA1) + G(0xA2)                                                // two letter-component glyphs
const sha256 = async bytes => crypto.createHash('sha256').update(bytes).digest('hex')

// One page, one unit: a Telugu run (legacy glyphs) + a text-layer run.
function fixture({ teStream, text = null }) {
  const rect = { page: 1, x0: 10, x1: 200, y0: 90, y1: 110 }
  const items = [{ str: teStream, x: 12, width: 150, y: 100, height: 10, fontName: 'CIDFont+F3' }]
  const teRun = { type: 'TE', rect }
  const runs = [teRun, ...(text != null ? [{ type: 'TEXT', text }] : [])]
  return { unit: { kind: 'OPTION', marker: 'B', lineRuns: [{ li: 0, runs }] }, teRun, itemsByPage: new Map([[1, items]]) }
}

test('source fingerprint covers the whole printed unit (glyphs, fonts and text-layer digits); only a hash leaves', async () => {
  const a = fixture({ teStream: L, text: '500' }), b = fixture({ teStream: L, text: '500' }), c = fixture({ teStream: L, text: '600' })
  const fa = await unitSourceFingerprint(a.unit, a.itemsByPage, sha256)
  assert.match(fa, /^tg1:[0-9a-f]{24}$/)
  assert.equal(fa, await unitSourceFingerprint(b.unit, b.itemsByPage, sha256), 'identical print -> identical fingerprint')
  assert.notEqual(fa, await unitSourceFingerprint(c.unit, c.itemsByPage, sha256), '"రూ॥ 500" and "రూ॥ 600" are different prints')
  const other = fixture({ teStream: L, text: '500' }); other.itemsByPage.get(1)[0].fontName = 'CIDFont+F4'
  assert.notEqual(fa, await unitSourceFingerprint(other.unit, other.itemsByPage, sha256), 'another font prints other letters')
  assert.equal(unitSourceKey({ kind: 'STEM', lineRuns: [{ runs: [{ type: 'TEXT', text: '12' }] }] }, new Map()), null, 'no Telugu run -> no fingerprint')
  assert.doesNotMatch(fa, /[-]/)
})

test('printed digits: tokens from digit glyphs only; repair only when every run aligns token-for-token', () => {
  assert.deepEqual(printedDigitTokens(`${L}${G(0x20)}${D(2)}${G(0x2C)}${D(1)}${G(0x60)}${D(48)}`), ['2', '1', '48'])
  const f = fixture({ teStream: `${L}${G(0x20)}${D(2)}${G(0x20)}${D(1)}${G(0x20)}${D(4)}${G(0x20)}${D(3)}` })
  const assemble = (unit, results, opts) => assembleUnit(unit, results, opts)
  const ocr = new Map([[f.teRun, { text: 'జత 2 1 4 8', confidence: 70 }]])
  const current = assembleUnit(f.unit, ocr).text
  const r = printedDigitEvidence(f.unit, ocr, f.itemsByPage, { assembleUnit: assemble, englishDigits: ['2', '1', '4', '3'], currentText: current })
  assert.equal(r.status, 'REPAIRABLE')
  assert.equal(r.text, 'జత 2 1 4 3')
  assert.deepEqual([r.before, r.after], [['2', '1', '4', '8'], ['2', '1', '4', '3']])
  // Same digits as printed -> MATCH (nothing to offer).
  const same = new Map([[f.teRun, { text: 'జత 2 1 4 3', confidence: 70 }]])
  assert.equal(printedDigitEvidence(f.unit, same, f.itemsByPage, { assembleUnit: assemble, currentText: 'జత 2 1 4 3' }).status, 'MATCH')
  // A digit read as a letter: token counts differ -> no alignment, nothing offered.
  const lost = new Map([[f.teRun, { text: 'జత 2 1 శ 8', confidence: 70 }]])
  assert.equal(printedDigitEvidence(f.unit, lost, f.itemsByPage, { assembleUnit: assemble, currentText: 'జత 2 1 శ 8' }).status, 'UNAVAILABLE')
  // The PDF's digits still disagree with the English -> CONFLICT (never offered; English is only a refusal check).
  assert.equal(printedDigitEvidence(f.unit, ocr, f.itemsByPage, { assembleUnit: assemble, englishDigits: ['9', '9', '9', '9'], currentText: current }).status, 'CONFLICT')
  const none = fixture({ teStream: L })
  assert.equal(printedDigitEvidence(none.unit, new Map([[none.teRun, { text: 'జత', confidence: 70 }]]), none.itemsByPage, { assembleUnit: assemble, currentText: 'జత' }).status, 'NO_DIGITS')
})

test('machine reasons -> teacher issues; confidence and agreement are never an issue', () => {
  for (const r of ['HIGH', 'MEDIUM', 'LOW', 'OCR_DECODER_AGREE', 'OCR_CONFIDENCE_LOW', 'OCR_HIGH_CONFIDENCE_UNVERIFIED', 'BLOCK_LOW', 'STEM_MEDIUM']) assert.equal(issueOf(r), null, r)
  const cases = { OCR_DECODER_DISAGREE: 'DISAGREEMENT', DIGIT_MISMATCH: 'DIGITS', GLYPH_ALIGNMENT_AMBIGUOUS: 'DIGITS_UNCONFIRMED', INVALID_TELUGU_SEQUENCE: 'INVALID',
    OCR_SUSPECT_CHARACTERS: 'ODD_CHARACTERS', UNBALANCED_BRACKET: 'ODD_CHARACTERS', EMPTY: 'MISSING_TEXT', OPTIONB_EMPTY: 'MISSING_TEXT', NOTATION_NOT_IN_OCR: 'MISSING_MATH',
    STRUCTURE_AMBIGUOUS: 'STRUCTURE', 'TELUGU_MARKERS_MISMATCH(ABC vs ABCD)': 'STRUCTURE', SOMETHING_NEW: 'OTHER' }
  for (const [r, want] of Object.entries(cases)) assert.equal(issueOf(r), want, r)
})

// ---- synthetic Draft --------------------------------------------------------------------------------------
function synthetic() {
  const q = (n, extra = {}) => ({ id: `q${n}`, position: n, source_question_number: String(n), content: `Stem ${n}`, source_page: 1, ...extra })
  const opt = (qid, m, content) => ({ id: `${qid}${m}`, draft_question_id: qid, position: 'ABCD'.indexOf(m), marker: m, content, is_proposed_correct: false, is_confirmed_correct: false })
  const crop = (id, qid, dd) => ({ id, draft_question_id: qid, media_kind: 'TEXT_REGION', capture_method: 'AUTO_REGION', storage_path: `p/${id}.png`, source_page: 1,
    detection_detail: { unit: 'OPTION', runId: 'r1', regionIndex: 0, ...dd } })
  const tx = (id, oid, extra) => ({ id, draft_option_id: oid, language: 'te', verification_state: null, ...extra })
  const it = (id, type, oid, tid, reasons, extra = {}) => ({ id, item_key: id, item_type: type, route: type === 'TELUGU_VERIFY' ? 'ADVISORY' : 'QUICK_CHECK', blocking: type !== 'TELUGU_VERIFY',
    status: 'OPEN', draft_option_id: oid, draft_question_id: null, draft_material_id: null, target_option_text_id: tid, source_media_id: `c_${tid}`, machine_reasons: reasons, detail: {}, ...extra })
  const questions = [q(1), q(2), q(3)]
  const options = [opt('q1', 'A', 'None'), opt('q1', 'B', '2143'), opt('q2', 'A', 'x'), opt('q3', 'A', 'y'), opt('q3', 'B', 'z')]
  const media = [
    crop('c_t1A', 'q1', { marker: 'A', ocrText: 'విదికాదు', sourceFp: 'tg1:aaa', decoder: { name: 'dec', version: '1', status: 'DECODED', agree: false, suggestion: 'ఏదికాదు' } }),
    crop('c_t1B', 'q1', { marker: 'B', ocrText: 'జత 2 1 4 8', printedDigits: { status: 'REPAIRABLE', name: 'ksc-printed-digits', version: '1.0.0', text: 'జత 2 1 4 3', before: ['2', '1', '4', '8'], after: ['2', '1', '4', '3'] } }),
    crop('c_t2A', 'q2', { marker: 'A', ocrText: 'ఒకటి', sourceFp: 'tg1:aaa' }),
    crop('c_t3A', 'q3', { marker: 'A', ocrText: 'రెండు' }), crop('c_t3B', 'q3', { marker: 'B', ocrText: 'మూడు' }),
  ]
  const optionTexts = [
    tx('t1A', 'q1A', { text_quality: 'OCR_EXTRACTED', content: 'విదికాదు', ocr_verdict: 'MEDIUM', source_media_id: 'c_t1A' }),
    tx('t1B', 'q1B', { text_quality: 'MISSING', content: null, ocr_verdict: 'DIGIT_MISMATCH', source_media_id: 'c_t1B' }),
    tx('t2A', 'q2A', { text_quality: 'OCR_EXTRACTED', content: 'ఒకటి', ocr_verdict: 'LOW', source_media_id: 'c_t2A' }),
    tx('t3A', 'q3A', { text_quality: 'OCR_EXTRACTED', content: 'రెండు', ocr_verdict: 'HIGH', source_media_id: 'c_t3A' }),
    tx('t3B', 'q3B', { text_quality: 'OCR_EXTRACTED', content: 'మూడు', ocr_verdict: 'MEDIUM', source_media_id: 'c_t3B' }),
  ]
  const items = [
    it('i1A', 'TELUGU_OPTION', 'q1A', 't1A', ['MEDIUM', 'OCR_DECODER_DISAGREE']),
    it('i1B', 'TELUGU_OPTION', 'q1B', 't1B', ['DIGIT_MISMATCH']),
    it('i2A', 'TELUGU_OPTION', 'q2A', 't2A', ['LOW']),
    it('i3A', 'TELUGU_VERIFY', 'q3A', 't3A', ['OCR_HIGH_CONFIDENCE_UNVERIFIED']),
    it('i3B', 'TELUGU_VERIFY', 'q3B', 't3B', ['OCR_DECODER_AGREE', 'OCR_CONFIDENCE_MEDIUM']),
  ]
  return indexDraft({ questions, options, questionTexts: [], optionTexts, media, materials: [], materialTexts: [], items, readiness: [] })
}

test('lanes: substantive problem -> exception; confidence only -> quick; nothing blocking -> optional', () => {
  const r = buildTeluguReview(synthetic())
  const lane = n => r.questions.find(q => q.number === n)?.lane
  assert.equal(lane(1), 'exception'); assert.equal(lane(2), 'quick'); assert.equal(lane(3), 'optional')
  const q1 = r.questions.find(q => q.number === 1)
  const [a, b] = q1.openUnits
  assert.equal(a.suggestion, 'ఏదికాదు'); assert.equal(a.issues[0].code, 'DISAGREEMENT')
  assert.equal(b.issues[0].code, 'DIGITS'); assert.match(b.issues[0].detail, /Telugu reads 2 1 4 8; the English has 2143/)
  assert.equal(b.digitRepair.oneClick, true, 'wrong digits are the only problem -> one click')
  assert.match(b.issues[0].detail, /The PDF prints 2 1 4 3 here/)
  assert.equal(b.content.current, 'జత 2 1 4 8', 'the unstored OCR reading is what the teacher sees')
  assert.equal(a.repeat.count, 2); assert.deepEqual(a.repeat.differentReadings, ['ఒకటి'])
  assert.deepEqual(r.questions.find(q => q.number === 2).verifyUnits.map(u => u.id), ['i2A'])
  assert.deepEqual(r.questions.find(q => q.number === 1).verifyUnits.map(u => u.id), [], 'a disagreement or digit problem is never verified together')
  assert.deepEqual(r.questions.find(q => q.number === 3).verifyUnits.map(u => u.id).sort(), ['i3A', 'i3B'])
  assert.deepEqual(laneCounts(r), { quick: 1, exception: 1, optional: 1, passages: 0, repeated: 1 })
  assert.equal(r.sourceDecisions[0].fp, 'tg1:aaa'); assert.deepEqual(r.sourceDecisions[0].readings.sort(), ['ఒకటి', 'విదికాదు'].sort())
  assert.equal(activeUnitOf(q1).id, 'i1A')
})

test('digit repair: pre-fills the editor when other problems remain; stale once the text changed', () => {
  const ix = synthetic()
  ix.items.find(i => i.id === 'i1B').machine_reasons = ['DIGIT_MISMATCH', 'OCR_SUSPECT_CHARACTERS']
  let u = buildTeluguReview(ix).questions[0].openUnits.find(x => x.id === 'i1B')
  assert.equal(u.digitRepair.oneClick, false)
  ix.mediaById.get('c_t1B').detection_detail.ocrText = 'జత 9 1 4 8'
  u = buildTeluguReview(ix).questions[0].openUnits.find(x => x.id === 'i1B')
  assert.equal(u.digitRepair, null, 'evidence computed on other text is never offered')
})

test('navigation: stay while blocking work remains, else the next question in the previous order', () => {
  const prev = [{ id: 'a', openUnits: [], blockingOpen: 0 }, { id: 'b', openUnits: [], blockingOpen: 0 }, { id: 'c', openUnits: [], blockingOpen: 0 }]
  assert.equal(nextQuestionAfter(prev, [prev[0], prev[2]], 'b'), 'c')
  assert.equal(nextQuestionAfter(prev, [prev[0]], 'c'), 'a')
  const still = { id: 'b', blockingOpen: 1, openUnits: [{ blocking: true, item: { status: 'OPEN' } }] }
  assert.equal(nextQuestionAfter(prev, [prev[0], still, prev[2]], 'b'), 'b')
})

test('teacher evidence is classified from server-stored values only', () => {
  const base = { status: 'RESOLVED', detail: { decoder: { agree: false, suggestion: 'ఏదికాదు' }, printedDigits: { status: 'REPAIRABLE', text: 'జత 2 1 4 3' } } }
  assert.equal(classifyDecision({ ...base, resolution: 'ACCEPTED_OCR' }), 'OCR_ACCEPTED_UNCHANGED')
  assert.equal(classifyDecision({ ...base, resolution: 'EDITED_OCR', resolution_value: 'ఏదికాదు' }), 'SUGGESTION_ACCEPTED')
  assert.equal(classifyDecision({ ...base, resolution: 'EDITED_OCR', resolution_value: 'జత 2 1 4 3' }), 'PRINTED_DIGITS_USED')
  assert.equal(classifyDecision({ ...base, resolution: 'EDITED_OCR', resolution_value: 'వేరే' }), 'TEACHER_EDITED')
  assert.equal(classifyDecision({ ...base, resolution: 'MARKED_MISSING' }), 'MARKED_MISSING')
  assert.equal(classifyDecision({ ...base, resolution: 'RECONCILED' }), null)
  assert.equal(classifyDecision({ status: 'OPEN' }), null)
  const ix = synthetic()
  Object.assign(ix.items.find(i => i.id === 'i1A'), { status: 'RESOLVED', resolution: 'EDITED_OCR', resolution_value: 'ఏదికాదు', detail: { decoder: { agree: false, suggestion: 'ఏదికాదు' } } })
  const e = teacherEvidence(ix)
  assert.deepEqual(e.tally, { SUGGESTION_ACCEPTED: 1 })
  assert.equal(e.rows[0].sourceFp, 'tg1:aaa')
})

// ---- golden (fresh Node preparation with this build) --------------------------------------------------------
const DUMP = 'reports/b484c/node-dump.json'
test('golden: every open blocking Telugu item is in exactly one question of the Telugu Review; safety rules hold', { skip: !fs.existsSync(DUMP) }, () => {
  const d = JSON.parse(fs.readFileSync(DUMP, 'utf8'))
  const ix = indexDraft(flatten(d))
  const r = buildTeluguReview(ix)
  const seen = new Map()
  for (const q of r.questions) for (const u of q.openUnits) seen.set(u.id, (seen.get(u.id) || 0) + 1)
  const open = ix.items.filter(i => isOpen(i) && UNIT_TYPES.has(i.item_type))
  for (const i of open) assert.equal(seen.get(i.id), 1, `item ${i.item_key} appears once`)
  assert.equal(seen.size, open.length)
  const units = r.questions.flatMap(q => q.openUnits)
  // Every disagreement (incl. every HIGH one) stays blocking and is an exception; no quick unit has a suggestion.
  const disagree = units.filter(u => u.reasons.includes('OCR_DECODER_DISAGREE'))
  assert.ok(disagree.length > 0)
  for (const u of disagree) { assert.equal(u.blocking, true); assert.equal(u.lane, 'exception') }
  const high = disagree.filter(u => u.content.crop?.detection_detail?.decoder?.verdictBefore === 'HIGH')
  assert.ok(high.length >= 25, `HIGH disagreements blocking: ${high.length}`)
  for (const u of units.filter(x => x.lane === 'quick')) { assert.equal(u.suggestion, null); assert.equal(u.issues.length, 0); assert.equal(u.digitRepair, null) }
  // Stored content never differs from the OCR text (the evidence never became content).
  for (const t of [...ix.questionText.values(), ...ix.optionText.values()]) {
    if (t.text_quality !== 'OCR_EXTRACTED') continue
    const crop = ix.mediaById.get(t.source_media_id)
    assert.equal(t.content, crop.detection_detail.ocrText)
  }
  const w = workload(d)
  assert.equal(w.state.confirmedAnswers, 0)
  assert.equal(w.passages.open, 10)
  assert.equal(w.repeated.groupsInPaper, 28)
  assert.equal(w.digitRepairs.oneClick + w.digitRepairs.prefillEditor, 9)
  assert.equal(laneQuestions(r, 'quick').length + laneQuestions(r, 'exception').length + laneQuestions(r, 'optional').length, r.questions.length)
})
