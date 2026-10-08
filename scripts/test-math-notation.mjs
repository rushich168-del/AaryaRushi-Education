import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import { applyMathNotation, neutralSpanValue, linearMath, isBlank, MATH_FONT } from './lib/math-notation.mjs'
import { notationReasons, assignNotation, recoverNeutralNumericOptions } from './lib/paper-layout.mjs'
import { questionTeluguStructure } from './lib/telugu-structure.mjs'
import { withNotationFlag, NOTATION_NOT_IN_OCR } from './lib/telugu-ocr-core.mjs'
import { buildReviewItems } from './lib/review-items.mjs'

// B4.8.3B — deterministic math notation (pure). Synthetic page shapes taken from the golden paper's
// measured geometry, positive AND negative. No PDF, no OCR, no database, no hardcoded golden values.

const LEG = s => String.fromCharCode(...[...s].map(c => 0xF000 + c.charCodeAt(0)))   // legacy-font glyph run
const L = new Set(['te'])
const it = (str, x, y, width, height = 12, fontName = 'en') => ({ str, x, y, width, height, fontName })
const page = (items, extra = {}) => ({ page: 1, heightPt: 842, widthPt: 595, items, images: [], frames: [], ...extra })
const run = (p) => applyMathNotation([p], { legacyFonts: L, columnsOf: () => [{ from: 0, to: 600 }] })[0]
const texts = p => p.items.map(i => i.str)
const ev = (p, kind) => (p.notation || []).filter(n => n.kind === kind)

test('superscript on a number, a standalone letter and legacy digits; ordinals are typography', () => {
  const p = run(page([it('A) 80', 330.2, 621.7, 27.2), it('0', 357.5, 625.7, 3.5, 7), it('value of a', 50, 80, 49.6), it('3', 99.6, 84, 3.5, 7),
    it(LEG(') 10'), 62.4, 631, 20.3, 16, 'te'), it(LEG('21'), 82.7, 636.4, 7.4, 9.2, 'te'), it('A) 12', 330, 770, 26), it('th', 356, 774, 6, 7)]))
  assert.ok(texts(p).includes('A) \\(80^{0}\\)'))
  assert.ok(texts(p).includes('value of \\(a^{3}\\)'))
  assert.ok(texts(p).includes('\\(10^{21}\\)'), 'legacy digits become a maths item')
  assert.ok(p.items.some(i => i.fontName === 'te' && i.str === LEG(')') + String.fromCharCode(0xF020)), "the bare marker's legacy ')' is kept for structure")
  assert.ok(texts(p).includes('A) 12th'))
  assert.equal(p.items.filter(i => i.height === 7 || i.height === 9.2).length, 0, 'consumed raised items leave reading order')
  assert.equal(p.inkItems.length, 8, 'the original glyphs stay available for pixel masks')
  assert.deepEqual(ev(p, 'RECONSTRUCTED').map(e => e.latex).sort(), ['10^{21}', '80^{0}', 'a^{3}'])
})

test('superscripts that cannot be proven are left untouched and reported as UNRESOLVED', () => {
  const foot = run(page([it('Company', 50, 80, 40), it('1', 90, 84, 3, 7)]))
  assert.deepEqual(texts(foot), ['Company', '1'], 'the last letter of a word is never a base')
  assert.equal(ev(foot, 'UNRESOLVED')[0].why, 'HOST_NOT_NUMBER_OR_LETTER')
  const two = run(page([it('A) 80', 330, 621.7, 27), it('B) 9', 332, 620.5, 25), it('0', 357, 625.7, 3.5, 7)]))
  assert.equal(ev(two, 'UNRESOLVED')[0].why, 'AMBIGUOUS_HOST')
  const te = run(page([it(LEG('abc 45'), 53.8, 196.1, 233, 16, 'te'), it(LEG('0'), 286.9, 201.5, 3.6, 9.2, 'te')]))
  assert.equal(ev(te, 'UNRESOLVED')[0].why, 'TELUGU_TEXT_HOST', 'a raised digit after a Telugu word: the row comes from OCR')
  assert.equal(ev(te, 'UNRESOLVED')[0].te, true)
})

test('stacked fraction: needs its equation frame; mixed numbers merge; a frameless table column is refused', () => {
  const stack = [it('5', 58.2, 445.3, 5.9, 11.9), it('63.', 28.3, 436.1, 15), it('of a number', 69, 436.1, 60), it('9', 58.1, 428.5, 5.9, 11.9)]
  const ok = run(page(stack, { frames: [{ x: 55.7, y: 425.9, w: 11.3, h: 30.7 }] }))
  assert.ok(texts(ok).includes('\\(\\frac{5}{9}\\)'))
  assert.ok(!texts(ok).includes('5') && !texts(ok).includes('9'), 'the numerator can no longer leak into the previous question')
  const no = run(page(stack))
  assert.deepEqual(texts(no).sort(), ['5', '63.', '9', 'of a number'])
  assert.equal(ev(no, 'UNRESOLVED')[0].why, 'NO_EQUATION_FRAME')
  const mixed = run(page([it('B) 12', 448.7, 372, 26.3), it('4', 479.6, 381.1, 6, 11.9), it('11', 476.4, 364.3, 11.9, 11.9), it(LEG('nimi'), 492, 372, 69, 16, 'te')],
    { frames: [{ x: 475, y: 361.7, w: 15, h: 30.8 }] }))
  assert.ok(texts(mixed).includes('B) \\(12\\frac{4}{11}\\)'))
  const row = run(page([it('25', 58, 445, 10), it('Age', 80, 445, 20), it('Name', 28, 436, 25), it('30', 58, 428, 10)], { frames: [{ x: 50, y: 420, w: 20, h: 32 }] }))
  assert.equal(ev(row, 'RECONSTRUCTED').length, 0, 'a numerator sharing its row with text is not a fraction')
})

test('bitmaps and equation stubs are located, never read; legacy space-glyph stubs are blank', () => {
  const stub = it(LEG('   '), 357.7, 656.9, 15.4, 40, 'te')
  assert.ok(isBlank(stub))
  const p = run(page([it('A)', 330.2, 656.9, 12.7), stub, it('B)', 372.6, 656.9, 11.9), it(LEG('   '), 505, 656.9, 5, 40, 'te')],
    { images: [{ x: 345.7, y: 646.4, w: 12, h: 31.4, obj: 'img_1' }] }))
  assert.deepEqual(ev(p, 'IMAGE').map(e => [e.x, e.obj, e.te]), [[345.7, 'img_1', false]])
  assert.deepEqual(ev(p, 'STUB').map(e => e.covered), [true, false], 'a stub with no bitmap beside it is unresolved')
  assert.deepEqual(texts(p).filter(s => s.includes('\\(')), [], 'no value is ever written for a bitmap')
  const bg = run(page([it('Text', 50, 400, 100)], { images: [{ x: 73, y: 395, w: 480, h: 16 }] }))
  assert.equal(ev(bg, 'IMAGE').length, 0, 'page background strips are not notation')
})

test('reasons, owners and sides: English bitmaps block; Telugu-side evidence goes to the Telugu units', () => {
  const opts = [{ marker: 'A', text: '64', at: { page: 1, column: 0, x: 330, y: 700 } }, { marker: 'B', text: '', at: { page: 1, column: 0, x: 426, y: 700 } }]
  const seg = { lines: [{ page: 1, column: 0, y: 700, items: [] }, { page: 1, column: 0, y: 760, items: [] }, { page: 1, column: 0, y: 650, items: [] }] }
  const pages = [{ page: 1, notation: [
    { kind: 'IMAGE', x: 360, lineY: 700, te: true }, { kind: 'IMAGE', x: 440, lineY: 700, te: false },
    { kind: 'IMAGE', x: 360, lineY: 760, te: false }, { kind: 'UNRESOLVED', x: 400, lineY: 650, te: true },
    { kind: 'STUB', x: 470, lineY: 700, te: false, covered: false }, { kind: 'RECONSTRUCTED', x: 50, lineY: 760, te: false, latex: '\\frac{5}{9}' }] }]
  const n = assignNotation(seg, opts, { line: { page: 1, column: 0, y: 700 } }, pages, [{ index: 0, from: 0, to: 600 }])
  assert.deepEqual(n.map(e => `${e.kind}:${e.side}:${e.owner}`), ['IMAGE:en:A', 'IMAGE:en:B', 'IMAGE:en:stem', 'UNRESOLVED:te:null', 'STUB:en:B', 'RECONSTRUCTED:en:stem'])
  assert.deepEqual(notationReasons(n), ['NOTATION_IMAGE_IN_OPTIONS(A,B)', 'NOTATION_IMAGE_IN_STEM', 'NOTATION_PLACEHOLDER_UNRESOLVED(B)'])
  assert.deepEqual(notationReasons([{ kind: 'RECONSTRUCTED', side: 'en', owner: 'stem' }]), [], 'reconstructed maths is provenance, never a reason')
})

test('review items: a bitmap in an EMPTY option joins its empty-option item; in a partial option it is a manual set item', () => {
  const snap = (content, reasons) => ({ materials: [], questions: [{ row: { id: 'q', source_question_number: '74', content: 'x', review_reasons: reasons, answer_key_source: 'K', source_page: 12 },
    media: [], texts: [], options: content.map((c, i) => ({ row: { id: `o${i}`, marker: 'ABCD'[i], content: c, is_proposed_correct: i === 0 }, texts: [] })) }] })
  const partial = buildReviewItems(snap(['64', '54', '60', '56'], ['NOTATION_IMAGE_IN_OPTIONS(A,B,C,D)']))
  assert.deepEqual(partial.filter(i => i.blocking).map(i => `${i.item_type}:${i.machine_reasons.join('+')}`), ['OPTION_SET_ABNORMAL:NOTATION_IMAGE_IN_OPTIONS(A,B,C,D)'])
  const empty = buildReviewItems(snap([null, null, null, null], ['EMPTY_OPTION_TEXT', 'NOTATION_IMAGE_IN_OPTIONS(A,B,C,D)']))
  assert.deepEqual([...new Set(empty.filter(i => i.blocking).map(i => `${i.item_type}:${i.machine_reasons.join('+')}`))],
    ['OPTION_EMPTY:EMPTY_OPTION_TEXT+NOTATION_IMAGE', 'ANSWER_KEY:KEY_POINTS_AT_EMPTY_OPTION'], 'no extra set item when every bitmap option is empty')
  const stem = buildReviewItems(snap(['1875', '2000', '2125', '2700'], ['NOTATION_IMAGE_IN_STEM']))
  assert.deepEqual(stem.filter(i => i.blocking).map(i => `${i.item_type}:${i.route}`), ['STRUCTURE:MANUAL_REVIEW'], 'never silently READY')
})

test('options: digits + reconstructed maths make the English option and a script-neutral Telugu option; Telugu OCR units get flagged', () => {
  const math = { str: '\\(10^{21}\\)', x: 67.4, y: 631, width: 20, height: 12, fontName: MATH_FONT }
  const paren = it(LEG(')') + String.fromCharCode(0xF020), 62.4, 631, 5, 16, 'te')
  assert.equal(neutralSpanValue([paren, math], x => x.fontName === 'te'), '\\(10^{21}\\)')
  assert.equal(neutralSpanValue([it(LEG(') abc'), 62, 631, 20, 16, 'te'), math], x => x.fontName === 'te'), null, 'letters refuse the span')
  const FSM = new Map([['te', 'TELUGU_LEGACY'], ['en', 'LATIN']])
  const line = { page: 18, column: 0, y: 631, items: [it('A', 53.8, 631, 8.7), paren, math] }
  const o = [{ marker: 'A', text: '', at: { page: 18, column: 0, x: 53.8, y: 631 } }]
  assert.deepEqual(recoverNeutralNumericOptions(o, [line], FSM), ['A'])
  assert.equal(o[0].text, '\\(10^{21}\\)')
  const s = questionTeluguStructure({ lines: [{ page: 18, column: 0, y: 650, items: [it(LEG('prashna'), 54, 650, 200, 16, 'te')] }, line] },
    { options: [{ position: 0, marker: 'A', text: '\\(10^{21}\\)' }] }, FSM, 27)
  assert.equal(s.structure, 'STEM_WITH_NEUTRAL_OPTIONS', 'no OCR unit for maths-only options')
  const u = withNotationFlag({ verdict: 'HIGH', flags: [] }, [{ kind: 'IMAGE' }])
  assert.deepEqual([u.verdict, u.flags], ['MEDIUM', [NOTATION_NOT_IN_OCR]])
  assert.equal(withNotationFlag({ verdict: 'LOW', flags: [] }, [{ kind: 'IMAGE' }]).verdict, 'LOW')
})

test('linear form for digit checks, and no golden value is hardcoded in the module', () => {
  assert.equal(linearMath('equal to \\(\\frac{1}{3}\\) of'), 'equal to 1/3 of')
  assert.equal(linearMath('A) \\(12\\frac{4}{11}\\)'), 'A) 12 4/11')
  const src = fs.readFileSync('scripts/lib/math-notation.mjs', 'utf8').replace(/\/\/.*$/gm, '')
  for (const golden of ['10^{10}', '\\frac{5}{9}', '4/11', '80^{0}', 'a^{3}']) assert.ok(!src.includes(golden), `no golden literal ${golden} in the code`)
})
