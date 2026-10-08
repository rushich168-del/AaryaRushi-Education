import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { questionTeluguStructure } from './lib/telugu-structure.mjs'
import {
  assembleUnit, questionOutcome, classifyOcr, normaliseOcrText, teluguRatio, digitCheck, stemDigits, bracketsBalanced,
  characterErrorRate, MODEL_DIRS, MODEL_SHA256,
} from './lib/telugu-ocr.mjs'
import { buildAutoTeluguPayload } from './lib/auto-telugu-persistence.mjs'

// B4.4 — pure tests: Telugu structure from geometry, OCR assembly/verdicts, and the mapping to
// language rows. No PDF, no OCR engine, no database. The golden checks at the end read the
// benchmark output when it exists.

const LEGACY = s => String.fromCharCode(...[...s].map(c => 0xF000 + c.charCodeAt(0)))   // U+F0xx-style glyph run
const FSM = new Map([['te', 'TELUGU_LEGACY'], ['en', 'LATIN']])
const it_ = (str, x, fontName = 'en', width = 30) => ({ str, x, width, height: 10, fontName })
const line = (y, items) => ({ page: 2, column: 0, y, items })
const opts = (...texts) => texts.map((text, i) => ({ position: i, marker: 'ABCD'[i], text }))

test('English "D) Three" does not swallow a Telugu stem that opens with a Latin word', () => {
  const seg = { lines: [
    line(800, [it_('1.', 27), it_('How many words', 54, 'en', 200)]),
    line(760, [it_('A) None', 54), it_('B) One', 150)]),
    line(745, [it_('C) Two', 54), it_('D) Three', 150)]),
    line(727, [it_('LEGU', 54, 'en', 30), it_(LEGACY('anu aksharalu'), 91, 'te', 180)]),
    line(670, [it_('A)', 54, 'en', 10), it_(LEGACY('edikadu'), 68, 'te'), it_('B)', 150, 'en', 10), it_(LEGACY('okati'), 164, 'te')]),
    line(651, [it_('C)', 54, 'en', 10), it_(LEGACY('rendu'), 68, 'te'), it_('D)', 150, 'en', 10), it_(LEGACY('mudu'), 165, 'te')]),
  ] }
  const s = questionTeluguStructure(seg, { options: opts('None', 'One', 'Two', 'Three') }, FSM, 27)
  assert.equal(s.structure, 'STEM_AND_OPTIONS')
  assert.deepEqual(s.units.map(u => `${u.kind}${u.marker ?? ''}`), ['STEM', 'OPTIONA', 'OPTIONB', 'OPTIONC', 'OPTIOND'])
  // "LEGU" is kept as genuine text-layer text, and the Telugu run is pixels only.
  const stemRuns = s.units[0].lineRuns[0].runs
  assert.deepEqual(stemRuns.map(r => r.type), ['TEXT', 'TE'])
  assert.equal(stemRuns[0].text, 'LEGU')
  // Option A's crop stops before option B's marker on the shared line.
  assert.ok(s.units[1].rects[0].x1 <= 150)
})

test('OCR input is pixels only: no Telugu run carries any text-layer string', () => {
  const seg = { lines: [line(700, [it_('1.', 27), it_(LEGACY('prashna'), 54, 'te', 200)])] }
  const s = questionTeluguStructure(seg, { options: opts('15', '19', '22', '24') }, FSM, 27)
  for (const u of s.units) for (const l of u.lineRuns) for (const r of l.runs.filter(r => r.type === 'TE')) {
    assert.deepEqual(Object.keys(r).sort(), ['itemCount', 'rect', 'skipLeadingParen', 'type'])
  }
})

test('numeric options make STEM_WITH_NEUTRAL_OPTIONS (no Telugu option units)', () => {
  const seg = { lines: [line(700, [it_('6.', 27), it_(LEGACY('trikonalu'), 54, 'te', 200)]),
    line(680, [it_('A) 15', 54), it_('B) 19', 120), it_('C) 22', 180), it_('D) 24', 240)])] }
  const s = questionTeluguStructure(seg, { options: opts('15', '19', '22', '24') }, FSM, 27)
  assert.equal(s.structure, 'STEM_WITH_NEUTRAL_OPTIONS')
  assert.deepEqual(s.units.map(u => u.kind), ['STEM'])
})

test('bare "A" + the legacy ")" glyph (U+F029) is a marker; its run skips the paren', () => {
  const paren = String.fromCharCode(0xF029, 0xF020)
  const seg = { lines: [
    line(700, [it_('105.', 27), it_(LEGACY('parvatam'), 54, 'te', 200)]),
    line(680, [it_('A', 54, 'en', 8), it_(paren + LEGACY('uttara'), 63, 'te'), it_('B', 150, 'en', 8), it_(paren + LEGACY('thai'), 159, 'te')]),
    line(660, [it_('C', 54, 'en', 8), it_(paren + LEGACY('dakshina'), 63, 'te'), it_('D', 150, 'en', 8), it_(paren + LEGACY('hong'), 159, 'te')]),
  ] }
  const s = questionTeluguStructure(seg, { options: opts('North Korea', 'Thailand', 'South Korea', 'Hongkong') }, FSM, 27)
  assert.equal(s.structure, 'STEM_AND_OPTIONS')
  const a = s.units.find(u => u.marker === 'A').lineRuns[0].runs[0]
  assert.equal(a.skipLeadingParen, true)
  assert.ok(a.rect.x0 >= 62, 'crop starts after the Latin marker letter')
})

test('Telugu markers that do not match the English options are AMBIGUOUS (no guessed mapping)', () => {
  const seg = { lines: [line(700, [it_('115.', 27), it_(LEGACY('prashna'), 54, 'te', 200)]),
    line(680, [it_('A)', 54, 'en', 10), it_(LEGACY('a'), 68, 'te'), it_('B)', 150, 'en', 10), it_(LEGACY('b'), 164, 'te')]),
    line(660, [it_('C)', 54, 'en', 10), it_(LEGACY('c'), 68, 'te'), it_('D)', 150, 'en', 10), it_(LEGACY('d'), 164, 'te')])] }
  const s = questionTeluguStructure(seg, { options: opts('x', 'y', 'z') }, FSM, 27)
  assert.equal(s.structure, 'AMBIGUOUS_BLOCK')
  assert.deepEqual(s.units.map(u => u.kind), ['BLOCK'])
})

test('a Telugu option subset is valid only when the missing options are script-neutral', () => {
  const seg = { lines: [line(700, [it_('14.', 27), it_(LEGACY('chihnalu'), 54, 'te', 200)]),
    line(680, [it_('A) $, #', 54), it_('B) #, *', 150)]),
    line(660, [it_('C) $, *', 54), it_('D) 1', 150, 'en', 12), it_(LEGACY('leda'), 165, 'te')])] }
  const ok = questionTeluguStructure(seg, { options: opts('$, #', '#, *', '$, *', '1 or 2') }, FSM, 27)
  assert.equal(ok.structure, 'STEM_AND_OPTIONS')
  assert.deepEqual(ok.units.map(u => u.marker ?? u.kind), ['STEM', 'D'])
  assert.equal(ok.units[1].lineRuns[0].runs[0].text, '1', 'the marker item\'s inline "1" opens the option')
  const bad = questionTeluguStructure(seg, { options: opts('Alpha', 'Beta', 'Gamma', '1 or 2') }, FSM, 27)
  assert.equal(bad.structure, 'AMBIGUOUS_BLOCK')
})

test('OCR text normalisation, Telugu ratio and verdicts', () => {
  assert.equal(normaliseOcrText('  అ  ' + String.fromCharCode(0xF041) + ' ఆ\n\n ఇ '), 'అ ఆ\nఇ')
  assert.equal(normaliseOcrText(') ఉత్తర కొరియా', { kind: 'OPTION' }), 'ఉత్తర కొరియా')
  assert.equal(teluguRatio('1వ, 8వ, 15వ'), 1, 'digits/punctuation are script-neutral')
  assert.equal(teluguRatio('A2 FL'), 0)
  assert.equal(classifyOcr({ text: 'రెండు', confidence: 91 }), 'HIGH')
  assert.equal(classifyOcr({ text: 'రెండు', confidence: 70 }), 'MEDIUM')
  assert.equal(classifyOcr({ text: 'రెండు', confidence: 30 }), 'LOW')
  assert.equal(classifyOcr({ text: 'Three', confidence: 99 }), 'NOT_TELUGU')
  assert.equal(classifyOcr({ text: 'రె' + String.fromCharCode(0xF041), confidence: 99 }), 'NOT_TELUGU')
  assert.equal(classifyOcr({ text: '', confidence: 99 }), 'EMPTY')
})

test('digit evidence: options need equal numbers, stems may not invent or misread any', () => {
  assert.equal(digitCheck('2వ, 9వ, 16వ, 28వ, 80వ', ['2', '9', '16', '23', '30']), 'MISMATCH')
  assert.equal(digitCheck('2వ, 9వ, 16వ, 23వ, 30వ', ['2', '9', '16', '23', '30']), 'MATCH')
  assert.equal(digitCheck('శవ, 11వ', ['4', '11']), 'MISMATCH', 'a lost option digit is a mismatch')
  assert.equal(digitCheck('6 వ 80 సమయం', ['6', '30'], { mode: 'subset' }), 'MISMATCH', 'a misread stem digit is caught')
  assert.equal(digitCheck('శ్రేణి', ['132', '129'], { mode: 'subset' }), 'NONE', 'a stem need not restate a number series')
  assert.deepEqual(stemDigits('is 6 : 30 in the clock A) 6 : 30 B) 5 : 30', ['6 : 30', '5 : 30']), ['6', '30'])
  assert.equal(bracketsBalanced('భావ (ప్రకటన'), false)
  assert.equal(bracketsBalanced('(FL కుటుంబ)'), true)
})

test('unit assembly: text-layer runs verbatim, weakest run decides, flags and digits downgrade', () => {
  const r1 = { type: 'TE' }, r2 = { type: 'TE' }
  const unit = { kind: 'STEM', lineRuns: [{ runs: [{ type: 'TEXT', text: 'LEGU' }, r1] }, { runs: [r2] }] }
  const good = assembleUnit(unit, new Map([[r1, { text: 'అను అక్షరాలలోని', confidence: 95 }], [r2, { text: 'మాత్రమే', confidence: 88 }]]), { englishDigits: [] })
  assert.equal(good.text, 'LEGU అను అక్షరాలలోని\nమాత్రమే')
  assert.equal(good.minConfidence, 88)
  assert.equal(good.verdict, 'HIGH')
  const weak = assembleUnit(unit, new Map([[r1, { text: 'అను', confidence: 95 }], [r2, { text: 'మా', confidence: 41 }]]))
  assert.equal(weak.verdict, 'LOW', 'one weak run makes the unit reviewable')
  const empty = assembleUnit(unit, new Map([[r1, { text: 'అను', confidence: 95 }], [r2, { text: '', confidence: 0 }]]))
  assert.equal(empty.verdict, 'MEDIUM')
  assert.deepEqual(empty.flags, ['EMPTY_RUN'])
  const opt = { kind: 'OPTION', marker: 'B', lineRuns: [{ runs: [r1] }] }
  assert.equal(assembleUnit(opt, new Map([[r1, { text: '28వ', confidence: 95 }]]), { englishDigits: ['23'] }).verdict, 'DIGIT_MISMATCH')
})

test('question outcome: clean + all HIGH is automatic; anything else is review with reasons', () => {
  assert.deepEqual(questionOutcome({ structure: 'STEM_AND_OPTIONS', reasons: [] }, [{ kind: 'STEM', verdict: 'HIGH' }]), { outcome: 'AUTO_OCR', reasons: [] })
  assert.deepEqual(questionOutcome({ structure: 'STEM_AND_OPTIONS', reasons: [] }, [{ kind: 'OPTION', marker: 'C', verdict: 'MEDIUM' }]).reasons, ['OPTIONC_MEDIUM'])
  assert.equal(questionOutcome({ structure: 'AMBIGUOUS_BLOCK', reasons: ['X'] }, [{ kind: 'BLOCK', verdict: 'HIGH' }]).outcome, 'REVIEW')
})

test('payload mapping: HIGH/MEDIUM become OCR_EXTRACTED, weak OCR becomes MISSING, neutral options SCRIPT_NEUTRAL, no options created', () => {
  const region = { page: 2, file: 'x.png', sha256: 'h', widthPx: 100, heightPx: 20, renderScale: 2, pageWidthPt: 595.32, pageHeightPt: 841.92, region: { x: 0.5, y: 0.3, w: 0.3, h: 0.03 } }
  const u = (kind, marker, verdict, text, conf = 90) => ({ kind, marker, verdict, text, minConfidence: conf, flags: [], regions: [region] })
  const benchmark = { meta: { engine: 'tesseract.js', engineVersion: '7.0.0', model: 'tessdata_fast/tel.traineddata' }, questions: [
    { number: 1, structure: 'STEM_AND_OPTIONS', reasons: [], units: [u('STEM', null, 'HIGH', 'ప్రశ్న'), u('OPTION', 'A', 'HIGH', 'ఒకటి'),
      u('OPTION', 'B', 'MEDIUM', 'రెండు', 70), u('OPTION', 'C', 'DIGIT_MISMATCH', '28వ'), u('OPTION', 'D', 'LOW', 'మూ', 30)] },
    { number: 6, structure: 'STEM_WITH_NEUTRAL_OPTIONS', reasons: [], units: [u('STEM', null, 'HIGH', 'త్రిభుజాలు')] },
    { number: 9, structure: 'AMBIGUOUS_BLOCK', reasons: ['TELUGU_MARKERS_MISMATCH(A vs ABCD)'], units: [u('BLOCK', null, 'HIGH', 'అంతా')] },
  ] }
  const qIds = new Map([['1', 'q1'], ['6', 'q6'], ['9', 'q9']])
  const optionsByKey = new Map([['1|A', { id: 'o1a', content: 'One' }], ['1|B', { id: 'o1b', content: 'Two' }], ['1|C', { id: 'o1c', content: '23rd' }], ['1|D', { id: 'o1d', content: 'Four' }],
    ['6|A', { id: 'o6a', content: '15' }], ['6|B', { id: 'o6b', content: '19' }], ['6|C', { id: 'o6c', content: '22' }], ['6|D', { id: 'o6d', content: '24' }],
    ['9|A', { id: 'o9a', content: 'x' }], ['9|B', { id: 'o9b', content: 'y' }], ['9|C', { id: 'o9c', content: 'z' }], ['9|D', { id: 'o9d', content: 'w' }]])
  let n = 0
  const p = buildAutoTeluguPayload({ benchmark, questionIdByNumber: qIds, optionsByKey, teacherId: '00000000-0000-4000-8000-000000000001',
    draftPaperId: '00000000-0000-4000-8000-000000000002', runId: 'run', newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` })
  const byOpt = Object.fromEntries(p.optionTexts.map(t => [t.draft_option_id, t]))
  assert.equal(byOpt.o1a.text_quality, 'OCR_EXTRACTED'); assert.equal(byOpt.o1a.content, 'ఒకటి'); assert.deepEqual(byOpt.o1a.ocr_review_reasons, [])
  assert.equal(byOpt.o1b.text_quality, 'OCR_EXTRACTED'); assert.deepEqual(byOpt.o1b.ocr_review_reasons, ['MEDIUM'])
  assert.equal(byOpt.o1c.text_quality, 'MISSING'); assert.equal(byOpt.o1c.content, null, 'misread numbers never become content')
  assert.equal(byOpt.o1d.text_quality, 'MISSING')
  for (const id of ['o6a', 'o6b', 'o6c', 'o6d']) assert.equal(byOpt[id].text_quality, 'SCRIPT_NEUTRAL')
  assert.ok(!['o9a', 'o9b', 'o9c', 'o9d'].some(id => byOpt[id]), 'ambiguous block: no option mapping')
  const q9 = p.questionTexts.find(t => t.draft_question_id === 'q9')
  assert.equal(q9.text_quality, 'MISSING'); assert.equal(q9.ocr_review_reasons[0], 'STRUCTURE_AMBIGUOUS')
  const blockCrop = p.media.find(m => m.record.id === q9.source_media_id).record
  assert.equal(blockCrop.detection_detail.ocrText, 'అంతా', 'the whole-block OCR is preserved beside its crop')
  assert.ok(p.media.every(m => m.record.storage_path.startsWith('imports/00000000-0000-4000-8000-000000000001/draft-media/')))
  assert.ok(!('options' in p), 'the payload has no way to create options')
})

test('CER helper treats joiner variants as the same visible text', () => {
  assert.equal(characterErrorRate('వాక్‌', 'వాక్').errors, 0)
  assert.equal(characterErrorRate('గుర్దరులు', 'గుర్జరులు').errors, 1)
})

test('the OCR model is self-hosted, checksummed and read from a local path', () => {
  for (const [name, dir] of Object.entries(MODEL_DIRS)) {
    assert.ok(path.isAbsolute(dir) && !/^https?:/.test(dir))
    const file = path.join(dir, 'tel.traineddata')
    if (!fs.existsSync(file)) continue
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), MODEL_SHA256[name], `${name} checksum`)
  }
})

// ---------- golden benchmark output (opt-in: needs reports/b44 from the benchmark CLI) -----------
const BENCH = 'reports/b44/b44-benchmark.json'
test('golden: Q6 Telugu stem is real Unicode, its options are script-neutral, answer untouched', { skip: !fs.existsSync(BENCH) && 'run scripts/b44-ocr-benchmark.mjs first' }, () => {
  const b = JSON.parse(fs.readFileSync(BENCH, 'utf8'))
  const q6 = b.questions.find(q => q.number === 6)
  assert.equal(q6.structure, 'STEM_WITH_NEUTRAL_OPTIONS')
  assert.deepEqual(q6.units.map(u => u.kind), ['STEM'])
  assert.equal(q6.units[0].text, 'దిగువనివ్వబడిన చిత్రంలో ఇమిడి ఉన్న త్రిభుజాలు ఎన్ని?')
  assert.equal(q6.units[0].verdict, 'HIGH')
  assert.deepEqual(q6.englishOptions, ['A) 15', 'B) 19', 'C) 22', 'D) 24'])
  assert.equal(q6.proposedAnswer, 'D')
  const all = b.questions.flatMap(q => q.units)
  assert.ok(all.every(u => !/[-�]/.test(u.text)), 'no legacy glyph in any OCR output')
  assert.ok(b.questions.every(q => q.units.filter(u => u.kind === 'OPTION').length <= 4))
  assert.equal(b.metrics.questionsWithTelugu, 177)
})
