import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import { LEGACY_TELUGU_DECODER_ASSET as ASSET } from './lib/telugu-legacy-decoder-asset.mjs'
import { matchLegacyFont, identifyLegacyFonts, decodeLegacyRun, decodeUnit, decodeLegacyRuns, decodeGlyphStream, withDecoderReading, sameTeluguText,
  LEGACY_DECODER, LEGACY_DECODER_VERSION, OCR_DECODER_AGREE, OCR_DECODER_DISAGREE } from './lib/telugu-legacy-decoder.mjs'
import { withInvalidSequenceFlag, hasInvalidTeluguSequence, INVALID_TELUGU_SEQUENCE, withSuspectCharacterFlag } from './lib/telugu-ocr-core.mjs'
import { buildAutoTeluguPayload } from './lib/auto-telugu-persistence.mjs'
import { buildReviewItems, deriveReadiness } from './lib/review-items.mjs'
import { teluguContent, reasonText, itemTitle } from '../src/services/draftReviewModel.js'

// B4.8.4B — legacy-Telugu glyph decoder as a SECOND reading beside the OCR: versioned asset, font gate,
// refusals, agreement/disagreement routing, the invalid-vowel-sequence rule, persistence and review items.
// Golden checks (Q1 option A) run when the golden PDF is present.

const G = code => String.fromCharCode(0xF000 + code)
const regular = ASSET.fontVariants.find(v => v.id === 'regular'), bold = ASSET.fontVariants.find(v => v.id === 'bold')
const fontOf = (variant, n = variant.glyphs.length) => ({ name: 'ABCDEF+AnyName', glyphs: variant.glyphs.slice(0, n), program: 'sha256:x' })
// Codes of one asset entry (a single-code cluster), as private-use characters.
const oneCodeEntry = ASSET.entries.find(([block, ak]) => !block.includes('.') && ak === 'న')
const run = (x0 = 10, x1 = 200) => ({ type: 'TE', rect: { page: 1, x0, x1, y0: 90, y1: 110 } })
const item = (str, fontName, x = 20) => ({ str, fontName, x, y: 100, width: 30, height: 10 })
const unitWith = runs => ({ kind: 'OPTION', marker: 'A', lineRuns: [{ runs }] })

test('asset: versioned, bound to one encoding, one syllable per entry, no sentences or question values', () => {
  assert.equal(LEGACY_DECODER, 'ksc-legacy-telugu-decoder')
  assert.match(LEGACY_DECODER_VERSION, /^\d+\.\d+\.\d+$/)
  assert.equal(ASSET.encoding, 'legacy-telugu-pua-f0')
  assert.deepEqual(ASSET.fontVariants.map(v => v.id), ['regular', 'bold'])
  for (const v of ASSET.fontVariants) assert.ok(v.glyphs.every(([c]) => c >= 0xF020 && c <= 0xF0FF), `${v.id}: only U+F020–U+F0FF`)
  assert.ok(ASSET.entries.length > 400)
  const SYL = /^(?:[క-హౘ-ౚ](?:్[క-హౘ-ౚ])*(?:్)?[ా-ౌౕౖౢౣ]?|[అ-ఔౠౡ]|[ఀ-ః])$/u
  for (const [block, ak, count] of ASSET.entries) {
    assert.ok(block.split('.').length <= 5 && /^[0-9a-f]{2}(\.[0-9a-f]{2})*$/.test(block), block)
    assert.match(ak, SYL, `${block} -> ${ak} is one syllable`)
    assert.ok(Number.isInteger(count) && count >= 2)
  }
  // The file as a whole: every Telugu run in it is a single syllable (no word, sentence or phrase).
  const src = fs.readFileSync('scripts/lib/telugu-legacy-decoder-asset.mjs', 'utf8')
  for (const m of src.match(/[ఀ-౿]+/g) || []) assert.match(m, SYL, `asset text "${m}"`)
  assert.ok(!/\d{2,}/.test(ASSET.entries.map(e => e[1]).join('')), 'no numbers in entries')
  assert.ok(!src.includes('ఏదికాదు') && !src.includes('విదికాదు'))
})

test('font gate: the supported regular/bold faces (or subsets) pass; anything else is refused', () => {
  assert.deepEqual([matchLegacyFont(fontOf(regular)).supported, matchLegacyFont(fontOf(regular)).variant], [true, 'regular'])
  assert.deepEqual([matchLegacyFont(fontOf(bold)).supported, matchLegacyFont(fontOf(bold)).variant], [true, 'bold'])
  assert.equal(matchLegacyFont(fontOf(regular, 60)).supported, true, 'a subset of the same face (another paper) passes')
  // Unknown Telugu font: same codes, one width different -> not the supported face.
  const tweaked = fontOf(regular); tweaked.glyphs = tweaked.glyphs.map(([c, w], i) => [c, i === 7 ? w + 1 : w])
  assert.deepEqual(matchLegacyFont(tweaked), { supported: false, reason: 'FONT_NOT_RECOGNISED' })
  // A mixture of the two faces' metrics is neither face.
  const mixed = { glyphs: [...regular.glyphs.slice(0, 50), ...bold.glyphs.filter(([c]) => !regular.glyphs.slice(0, 50).some(g => g[0] === c)).slice(0, 50)] }
  assert.equal(matchLegacyFont(mixed).supported, false)
  assert.deepEqual(matchLegacyFont(fontOf(regular, 39)), { supported: false, reason: 'TOO_FEW_GLYPHS' })
  assert.deepEqual(matchLegacyFont({ name: 'X', glyphs: [] }), { supported: false, reason: 'NO_FONT_METRICS' })
  assert.deepEqual(matchLegacyFont(null), { supported: false, reason: 'NO_FONT_METRICS' })
})

test('runs: supported font decodes; unknown font refuses; Unicode Telugu and scanned pages are NOT_APPLICABLE', () => {
  const support = identifyLegacyFonts({ good: fontOf(regular), other: { glyphs: regular.glyphs.map(([c, w]) => [c, w + 3]) } })
  const code = parseInt(oneCodeEntry[0], 16) + 0xF000
  const legacyStr = String.fromCharCode(code)
  const r = run()
  assert.deepEqual(decodeLegacyRun([item(legacyStr, 'good')], r, support), { status: 'DECODED', text: 'న', variants: ['regular'] })
  assert.deepEqual(decodeLegacyRun([item(legacyStr, 'other')], r, support), { status: 'REFUSED', reason: 'UNSUPPORTED_FONT' })
  assert.deepEqual(decodeLegacyRun([item(legacyStr, 'never-seen')], r, support), { status: 'REFUSED', reason: 'UNSUPPORTED_FONT' })
  // A code the supported face does not define.
  const undefinedCode = [...Array(0xE0).keys()].map(i => 0xF020 + i).find(c => !regular.glyphs.some(g => g[0] === c))
  assert.deepEqual(decodeLegacyRun([item(String.fromCharCode(undefinedCode), 'good')], r, support), { status: 'REFUSED', reason: 'UNKNOWN_GLYPH_CODE' })
  // Unicode Telugu text layer: no private-use glyphs -> the decoder is not needed and does nothing.
  assert.deepEqual(decodeLegacyRun([item('ఏ దేశంలో', 'unicodeTelugu')], r, support), { status: 'NOT_APPLICABLE' })
  // Scanned / image-only page: no text items at all.
  assert.deepEqual(decodeLegacyRun([], r, support), { status: 'NOT_APPLICABLE' })
  const u = unitWith([r])
  assert.deepEqual(decodeUnit(u, new Map([[r, { status: 'NOT_APPLICABLE' }]])), { status: 'NOT_APPLICABLE' })
  assert.deepEqual(decodeUnit(u, new Map()), { status: 'NOT_APPLICABLE' })
  // Part legacy, part not: nothing comparable.
  const r2 = run(300, 400), u2 = unitWith([r, r2])
  assert.deepEqual(decodeUnit(u2, new Map([[r, { status: 'DECODED', text: 'న' }], [r2, { status: 'NOT_APPLICABLE' }]])), { status: 'REFUSED', reason: 'PARTIAL_LEGACY' })
  // No font identity at all (a paper that merely contains Telugu): refused, never decoded.
  const { runs, fonts } = decodeLegacyRuns([{ units: [u] }], [{ page: 1, items: [item(legacyStr, 'f1')] }], {})
  assert.deepEqual(runs.get(r), { status: 'REFUSED', reason: 'UNSUPPORTED_FONT' })
  assert.deepEqual(fonts, {})
})

test('segments: unknown clusters and invalid output refuse; digits come only from the deterministic glyph classes', () => {
  assert.deepEqual(decodeGlyphStream(G(0x31) + G(0x39) + G(0x32) + G(0x31)), { text: '1921' })
  const unknown = [...Array(0xE0).keys()].map(i => 0x20 + i).find(c => !ASSET.entries.some(([b]) => b === c.toString(16)) && ![0x20, 0x28, 0x29, 0x2c, 0x2d, 0x2e, 0x2f, 0x3a, 0x3f, 0x25, 0x60, 0xbb, 0xb5, 0xf6].includes(c) && !(c >= 0x30 && c <= 0x39))
  const lone = decodeGlyphStream(G(unknown))
  assert.ok(lone.refused === 'UNKNOWN_CLUSTER' || lone.refused === 'AMBIGUOUS', JSON.stringify(lone))
})

test('validity rule: an independent vowel followed by a vowel sign is flagged, never corrected', () => {
  for (const bad of ['అా', 'ఏి', 'ఒక ఉూరు', 'ఇె']) assert.equal(hasInvalidTeluguSequence(bad), true, bad)
  for (const good of ['ఏదికాదు', 'అను అక్షరాలలోని', 'కాలం', 'ఐదు', '1921']) assert.equal(hasInvalidTeluguSequence(good), false, good)
  const u = { text: 'ఏా దేశం', verdict: 'HIGH', flags: [] }
  const f = withInvalidSequenceFlag(u)
  assert.deepEqual([f.text, f.verdict, f.flags], ['ఏా దేశం', 'MEDIUM', [INVALID_TELUGU_SEQUENCE]])
  assert.equal(withInvalidSequenceFlag(f), f, 'idempotent')
  assert.equal(withInvalidSequenceFlag({ text: 'దేశం', verdict: 'HIGH', flags: [] }).verdict, 'HIGH')
  // The existing suspect check does not see it (both characters are Telugu) — the reason this rule exists.
  assert.deepEqual(withSuspectCharacterFlag({ text: 'ఏా', verdict: 'HIGH', flags: [] }).flags, [])
  assert.equal(reasonText(INVALID_TELUGU_SEQUENCE).includes('vowel'), true)
})

test('routing: agreement only lifts confidence-only units; disagreement blocks (HIGH too); refusals change nothing', () => {
  const dec = text => ({ status: 'DECODED', text })
  const base = (verdict, flags = [], extra = {}) => ({ kind: 'OPTION', marker: 'A', text: 'ఏదికాదు', verdict, flags, digitCheck: 'NONE', ...extra })
  const m = withDecoderReading(base('MEDIUM'), dec('ఏదికాదు'))
  assert.deepEqual([m.text, m.verdict, m.flags, m.decoder.agree, m.decoder.routed], ['ఏదికాదు', 'MEDIUM', [OCR_DECODER_AGREE], true, true])
  assert.deepEqual(withDecoderReading(base('LOW'), dec('ఏది కాదు'.replace(' ', ''))).flags, [OCR_DECODER_AGREE])
  assert.equal(sameTeluguText('ఏది  కాదు\n', 'ఏది కాదు'), true)
  assert.equal(sameTeluguText('ఏది‌కాదు', 'ఏదికాదు'), true, 'joiners are not visible text')
  // Anything else wrong -> agreement is recorded but routes nothing.
  for (const u of [base('MEDIUM', ['GLYPH_ALIGNMENT_AMBIGUOUS']), base('MEDIUM', ['NOTATION_NOT_IN_OCR']), base('MEDIUM', [INVALID_TELUGU_SEQUENCE]),
    base('MEDIUM', ['EMPTY_RUN']), base('DIGIT_MISMATCH', [], { digitCheck: 'MISMATCH' }), base('MEDIUM', [], { digitCheck: 'MISMATCH' }), base('NOT_TELUGU'), base('EMPTY', [], { text: '' })]) {
    const r = withDecoderReading(u, dec(u.text || 'ఏదికాదు'))
    assert.ok(!r.flags.includes(OCR_DECODER_AGREE), JSON.stringify(u))
    assert.equal(r.verdict, u.verdict)
  }
  // HIGH + agreement: already optional; stays HIGH with no new flag.
  const h = withDecoderReading(base('HIGH'), dec('ఏదికాదు'))
  assert.deepEqual([h.verdict, h.flags, h.decoder.agree], ['HIGH', [], true])
  // Disagreement: OCR text kept; HIGH becomes MEDIUM; the decoder text is only a suggestion.
  const d = withDecoderReading({ ...base('HIGH'), text: 'విదికాదు' }, dec('ఏదికాదు'))
  assert.deepEqual([d.text, d.verdict, d.flags, d.decoder.suggestion], ['విదికాదు', 'MEDIUM', [OCR_DECODER_DISAGREE], 'ఏదికాదు'])
  assert.equal(withDecoderReading({ ...base('LOW'), text: 'x' }, dec('ఏదికాదు')).verdict, 'LOW')
  // Refused / not applicable: routing exactly as before.
  for (const reading of [{ status: 'REFUSED', reason: 'UNKNOWN_CLUSTER' }, { status: 'NOT_APPLICABLE' }]) {
    const r = withDecoderReading(base('HIGH'), reading)
    assert.deepEqual([r.verdict, r.flags, r.decoder.status], ['HIGH', [], reading.status])
    assert.equal(withDecoderReading(base('MEDIUM'), reading).flags.length, 0)
  }
})

// ---- persistence + review items -----------------------------------------------------------------------
let seq = 0
const uid = p => `${p}-${++seq}`
function benchmarkOf(units) {
  return { meta: { engine: 'tesseract.js', engineVersion: '7', model: 'int', ocrVersion: 'v' }, questions: [{ number: 1, structure: 'STEM_AND_OPTIONS', reasons: [],
    units: units.map(u => ({ minConfidence: 70, regions: [{ page: 2, file: 'f.png', sha256: 's', widthPx: 10, heightPx: 10, renderScale: 2, pageWidthPt: 595, pageHeightPt: 842,
      region: { x: 0.1, y: 0.1, w: 0.2, h: 0.05 } }], ...u })) }] }
}
function persistAndReview(units) {
  const optionsByKey = new Map(['A', 'B', 'C', 'D'].map(m => [`1|${m}`, { id: `opt-${m}`, content: `English ${m}` }]))
  const p = buildAutoTeluguPayload({ benchmark: benchmarkOf(units), questionIdByNumber: new Map([['1', 'q1']]), optionsByKey, teacherId: 't', draftPaperId: 'd', runId: 'r', newId: () => uid('m') })
  const media = p.media.map(m => ({ ...m.record, media_kind: 'TEXT_REGION' }))
  const snapshot = { questions: [{ row: { id: 'q1', source_question_number: '1', source_page: 2, content: 'English stem?', review_reasons: [], warnings: [], answer_key_source: 'KEY' },
    media, texts: p.questionTexts.map(t => ({ id: uid('t'), language: 'te', ...t })),
    options: ['A', 'B', 'C', 'D'].map((m, i) => ({ row: { id: `opt-${m}`, draft_question_id: 'q1', marker: m, position: i + 1, content: `English ${m}`, is_proposed_correct: m === 'A', is_confirmed_correct: false },
      texts: p.optionTexts.filter(t => t.draft_option_id === `opt-${m}`).map(t => ({ id: uid('t'), language: 'te', ...t })) })) }] }
  const items = buildReviewItems(snapshot)
  return { p, snapshot, items, readiness: deriveReadiness(snapshot, items)[0] }
}
const unit = (marker, text, verdict, flags, decoder) => ({ kind: marker ? 'OPTION' : 'STEM', marker: marker || null, text, verdict, flags, digitCheck: 'NONE', decoder })
const agreeDec = { name: LEGACY_DECODER, version: LEGACY_DECODER_VERSION, status: 'DECODED', agree: true, routed: true }

test('persistence + review items: agreement is optional; HIGH disagreement blocks with a suggestion; nothing confirmed', () => {
  const units = [
    unit(null, 'ఏ దేశంలో', 'HIGH', [], { ...agreeDec, routed: false }),
    unit('A', 'విదికాదు', 'MEDIUM', [OCR_DECODER_DISAGREE], { name: LEGACY_DECODER, version: LEGACY_DECODER_VERSION, status: 'DECODED', agree: false, suggestion: 'ఏదికాదు' }),
    unit('B', 'రెండు', 'MEDIUM', [OCR_DECODER_AGREE], agreeDec),
    unit('C', 'మూడు', 'LOW', [OCR_DECODER_AGREE], agreeDec),
    unit('D', 'నాలుగు', 'LOW', [], { name: LEGACY_DECODER, version: LEGACY_DECODER_VERSION, status: 'REFUSED', reason: 'UNKNOWN_CLUSTER' }),
  ]
  const { p, items, readiness } = persistAndReview(units)
  const opt = m => p.optionTexts.find(t => t.draft_option_id === `opt-${m}`)
  // Stored text is always the OCR text; LOW is stored only with agreement; the suggestion is never content.
  assert.deepEqual([opt('A').text_quality, opt('A').content, opt('A').ocr_review_reasons], ['OCR_EXTRACTED', 'విదికాదు', ['MEDIUM', OCR_DECODER_DISAGREE]])
  assert.deepEqual([opt('C').text_quality, opt('C').content], ['OCR_EXTRACTED', 'మూడు'])
  assert.deepEqual([opt('D').text_quality, opt('D').content], ['MISSING', null])
  assert.ok(!JSON.stringify([...p.questionTexts, ...p.optionTexts]).includes('ఏదికాదు'))
  assert.equal(p.media[1].record.detection_detail.decoder.suggestion, 'ఏదికాదు', 'the suggestion is kept beside the crop')
  assert.equal(p.media[1].record.detection_detail.ocrText, 'విదికాదు')
  const byOpt = m => items.find(i => i.draft_option_id === `opt-${m}`)
  assert.deepEqual([byOpt('A').item_type, byOpt('A').blocking, byOpt('A').detail.decoder.suggestion, byOpt('A').extracted_value], ['TELUGU_OPTION', true, 'ఏదికాదు', 'విదికాదు'])
  for (const m of ['B', 'C']) {
    assert.deepEqual([byOpt(m).item_type, byOpt(m).blocking, byOpt(m).route], ['TELUGU_VERIFY', false, 'ADVISORY'], m)
    assert.equal(byOpt(m).machine_reasons[0], OCR_DECODER_AGREE)
  }
  assert.deepEqual(byOpt('C').machine_reasons, [OCR_DECODER_AGREE, 'OCR_CONFIDENCE_LOW'])
  assert.deepEqual([byOpt('D').item_type, byOpt('D').blocking], ['TELUGU_OPTION', true])
  assert.equal(items.find(i => i.target_question_text_id).item_type, 'TELUGU_VERIFY')
  assert.notEqual(readiness.readiness, 'READY', 'the HIGH disagreement keeps the question from READY')
  assert.ok(!items.some(i => i.item_type === 'ANSWER_KEY' && i.detail?.confirmed))
})

test('review items: an agreement reason without the recorded agreement, or with any other reason, stays blocking', () => {
  const { items } = persistAndReview([
    unit('A', 'ఒకటి', 'MEDIUM', [OCR_DECODER_AGREE], null),                                   // no decoder detail beside the crop
    unit('B', 'రెండు', 'MEDIUM', ['UNBALANCED_BRACKET', OCR_DECODER_AGREE], agreeDec),          // another reason
  ])
  for (const m of ['A', 'B']) assert.equal(items.find(i => i.draft_option_id === `opt-${m}`).blocking, true, m)
})

test('Review Center model: suggestion only on open, undecided items; texts for the new reasons', () => {
  const crop = { id: 'c1', storage_path: 'p', source_page: 2, detection_detail: { ocrText: 'విదికాదు', decoder: { name: LEGACY_DECODER, version: LEGACY_DECODER_VERSION, status: 'DECODED', agree: false, suggestion: 'ఏదికాదు' } } }
  const row = { id: 't1', text_quality: 'OCR_EXTRACTED', content: 'విదికాదు', ocr_verdict: 'MEDIUM', verification_state: null }
  const ix = { mediaById: new Map([['c1', crop]]), questionTextById: new Map(), optionTextById: new Map([['t1', row]]) }
  const item = { id: 'i1', item_type: 'TELUGU_OPTION', status: 'OPEN', draft_option_id: 'o1', target_option_text_id: 't1', source_media_id: 'c1', machine_reasons: ['MEDIUM', OCR_DECODER_DISAGREE] }
  const c = teluguContent(ix, item)
  assert.equal(c.suggestion, 'ఏదికాదు')
  assert.equal(c.current, 'విదికాదు')
  assert.deepEqual([c.decoder.name, c.decoder.agree], [LEGACY_DECODER, false])
  assert.equal(teluguContent(ix, { ...item, status: 'RESOLVED' }).suggestion, null)
  ix.optionTextById.set('t1', { ...row, verification_state: 'EDITED_FROM_OCR' })
  assert.equal(teluguContent(ix, item).suggestion, null, 'a teacher decision is never second-guessed')
  // Agreement or no decoder: no suggestion.
  ix.optionTextById.set('t1', row)
  crop.detection_detail.decoder = { ...crop.detection_detail.decoder, agree: true }
  assert.equal(teluguContent(ix, item).suggestion, null)
  delete crop.detection_detail.decoder
  assert.equal(teluguContent(ix, item).suggestion, null)
  assert.match(reasonText(OCR_DECODER_AGREE), /agreement is not proof/)
  assert.match(reasonText(OCR_DECODER_DISAGREE), /suggestion/)
  assert.match(itemTitle({ item_type: 'TELUGU_VERIFY', machine_reasons: [OCR_DECODER_AGREE, 'OCR_CONFIDENCE_MEDIUM'] }), /agree/)
  assert.match(itemTitle({ item_type: 'TELUGU_VERIFY', machine_reasons: ['OCR_HIGH_CONFIDENCE_UNVERIFIED'] }), /high-confidence/)
})

// ---- golden paper ------------------------------------------------------------------------------------
const GOLDEN = process.env.KSC_GOLDEN_PDF || (await import('./lib/local-draft-db.mjs')).GOLDEN_PDF
test('golden: both legacy faces identified; Q1 option A read by the decoder surfaces the విదికాదు misread without hardcoding', { skip: !fs.existsSync(GOLDEN) && 'golden PDF not present' }, async () => {
  const { buildPageModels } = await import('./lib/pdf-page-model.mjs')
  const { analysePaper } = await import('./lib/paper-layout.mjs')
  const { buildTeluguStructures } = await import('./lib/telugu-structure.mjs')
  const { pages, fonts } = await buildPageModels(GOLDEN)
  const structures = buildTeluguStructures(pages, analysePaper(pages))
  const legacy = decodeLegacyRuns(structures, pages, fonts)
  const variants = Object.values(legacy.fonts).filter(f => f.supported).map(f => f.variant).sort()
  assert.deepEqual(variants, ['bold', 'regular'])
  assert.ok(Object.values(legacy.fonts).some(f => !f.supported), 'the equation-stub font is not accepted')
  const q1 = structures.find(s => s.number === 1)
  const optA = q1.units.find(u => u.kind === 'OPTION' && u.marker === 'A')
  const reading = decodeUnit(optA, legacy.runs)
  assert.equal(reading.status, 'DECODED')
  // The OCR's known HIGH-confidence reading of this option (B4.8.4A2 evidence) vs the independent reading.
  const routed = withDecoderReading({ kind: 'OPTION', marker: 'A', text: 'విదికాదు', verdict: 'HIGH', flags: [], digitCheck: 'NONE' }, reading)
  assert.deepEqual([routed.verdict, routed.flags, routed.text], ['MEDIUM', [OCR_DECODER_DISAGREE], 'విదికాదు'])
  assert.equal(routed.decoder.suggestion, 'ఏదికాదు')
})
