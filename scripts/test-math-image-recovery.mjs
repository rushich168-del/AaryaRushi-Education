// B4.8.3C — deduplicated math-image recovery: pure tests (no database, no network, no PDF).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { imageFingerprint } from './lib/pdf-page-model-core.mjs'
import { imageAnchor } from './lib/paper-layout.mjs'
import { groupMathImages, validateMathLatex, friendlyToLatex, placeAtAnchor, linearOf } from './lib/math-image-recovery.mjs'

const rgb = (w, h, f) => { const d = new Uint8Array(w * h * 3); for (let i = 0; i < w * h; i++) d.set(f(i), i * 3); return d }

test('fingerprint = exact pixels: the same image in any pdf.js encoding matches; one changed pixel does not', async () => {
  const w = 8, h = 4, px = i => (i % 3 === 0 ? [0, 0, 0] : [255, 255, 255])
  const asRgb = await imageFingerprint({ width: w, height: h, kind: 2, data: rgb(w, h, px) })
  const rgba = new Uint8Array(w * h * 4); for (let i = 0; i < w * h; i++) rgba.set([...px(i), 255], i * 4)
  const asRgba = await imageFingerprint({ width: w, height: h, kind: 3, data: rgba })
  const bits = new Uint8Array(h * 1); for (let y = 0; y < h; y++) { let b = 0; for (let x = 0; x < 8; x++) if (px(y * w + x)[0] === 255) b |= 1 << (7 - x); bits[y] = b }
  const as1bpp = await imageFingerprint({ width: w, height: h, kind: 1, data: bits })
  assert.equal(asRgb.fp, asRgba.fp); assert.equal(asRgb.fp, as1bpp.fp)
  assert.deepEqual(asRgb.px, [8, 4]); assert.match(asRgb.fp, /^px:[0-9a-f]{24}$/)
  const changed = rgb(w, h, px); changed[5] = 7
  assert.notEqual((await imageFingerprint({ width: w, height: h, kind: 2, data: changed })).fp, asRgb.fp)
  // Same bytes, different shape: different image.
  assert.notEqual((await imageFingerprint({ width: 4, height: 8, kind: 2, data: rgb(w, h, px) })).fp, asRgb.fp)
  assert.equal(await imageFingerprint(null), null)
  assert.equal(await imageFingerprint({ width: 2, height: 2, kind: 9, data: new Uint8Array(4) }), null)
})

test('grouping: by fingerprint only; unreadable placements are never merged; Draft rows and model questions alike', () => {
  const img = (fp, owner, x) => ({ kind: 'IMAGE', fp, px: [8, 42], side: 'en', owner, page: 10, box: { x, y: 100, w: 6, h: 31 }, anchor: { before: '', after: '' } })
  const groups = groupMathImages([
    { number: 60, notation: [img('px:a', 'A', 10), img('px:b', 'B', 20), { kind: 'STUB', side: 'en', owner: 'C' }] },
    { source_question_number: '74', id: 'q74', analysis_regions: { notation: [img('px:b', 'B', 30), img(null, 'C', 40), img(null, 'D', 50)] } },
  ])
  assert.deepEqual(groups.map(g => [g.fp, g.occurrences.length]), [['px:b', 2], ['px:a', 1], [null, 1], [null, 1]])
  assert.deepEqual(groups[0].occurrences.map(o => `${o.question}${o.owner}`), ['60B', '74B'])
  assert.equal(groups[0].occurrences[1].questionId, 'q74')
})

test('restricted representation: MathText-safe maths only', () => {
  for (const ok of ['\\(\\frac{8}{11}\\)', '\\(\\frac{70\\sqrt{3}}{3}\\)', '\\(10^{21}\\)', '\\(12\\frac{1}{2}\\)', '\\(60^{\\circ}\\)', '\\(35\\sqrt{3}\\)', '\\(a^{3} + b^{3}\\)', '\\(2 \\times 3\\)'])
    assert.equal(validateMathLatex(ok), null, ok)
  const bad = {
    '\\frac{1}{2}': 'NOT_ONE_MATH_SPAN', '\\(\\text{x}\\)': 'COMMAND_NOT_ALLOWED(text)', '\\(\\href{http://x}{y}\\)': 'COMMAND_NOT_ALLOWED(href)',
    '\\(<b>1</b>\\)': 'CHARACTER_NOT_ALLOWED(<)', '\\(\\frac{1}{2}\\) and \\(3\\)': 'NESTED_SPAN', '\\(\\frac{1}{\\)': 'UNBALANCED_BRACES',
    '\\(\\frac12\\)': 'ARGUMENT_NEEDS_BRACES', '\\(days\\)': 'WORDS_NOT_ALLOWED', '\\(\\frac{}{2}\\)': 'EMPTY_ARGUMENT', '\\( \\)': 'EMPTY',
  }
  for (const [v, why] of Object.entries(bad)) assert.equal(validateMathLatex(v), why, v)
})

test('friendly input: teachers type ordinary maths, the stored form is the restricted LaTeX', () => {
  const cases = {
    '8/11': '\\(\\frac{8}{11}\\)', '10/13': '\\(\\frac{10}{13}\\)', '9/13': '\\(\\frac{9}{13}\\)', '10/11': '\\(\\frac{10}{11}\\)',
    '70√3/3': '\\(\\frac{70\\sqrt{3}}{3}\\)', '(70√3)/3': '\\(\\frac{70\\sqrt{3}}{3}\\)', '70 sqrt(3) / 3': '\\(70 \\frac{\\sqrt{3}}{3}\\)',   // spaced: a product (same value), shown in the preview
    '√3': '\\(\\sqrt{3}\\)', 'sqrt3': '\\(\\sqrt{3}\\)', 'sqrt(3)': '\\(\\sqrt{3}\\)', '70sqrt(3)/3': '\\(\\frac{70\\sqrt{3}}{3}\\)', '10^11': '\\(10^{11}\\)', '3 1/2': '\\(3\\frac{1}{2}\\)', '½': '\\(\\frac{1}{2}\\)', '12½': '\\(12\\frac{1}{2}\\)',
    '10^21': '\\(10^{21}\\)', 'x^2': '\\(x^{2}\\)', '60°': '\\(60^{\\circ}\\)', '\\frac{2}{455}': '\\(\\frac{2}{455}\\)', '\\(\\frac{4}{15}\\)': '\\(\\frac{4}{15}\\)',
  }
  for (const [input, want] of Object.entries(cases)) assert.deepEqual(friendlyToLatex(input), { ok: true, latex: want }, input)
  for (const input of ['', 'two thirds', '\\text{x}', '<img src=x>']) assert.equal(friendlyToLatex(input).ok, false, input)
  assert.equal(linearOf('\\(\\frac{70\\sqrt{3}}{3}\\)'), '(70√3)/(3)')
})

test('placement: exact anchor or refusal — never a guessed position', () => {
  const half = '\\(\\frac{1}{2}\\)'
  assert.deepEqual(placeAtAnchor(null, { before: '', after: '' }, '\\(\\frac{8}{11}\\)'), { ok: true, content: '\\(\\frac{8}{11}\\)' })
  assert.deepEqual(placeAtAnchor('18', { before: '18', after: '' }, half), { ok: true, content: `18${half}` })
  assert.deepEqual(placeAtAnchor('2 km', { before: '2', after: 'km' }, half), { ok: true, content: `2${half} km` })
  assert.deepEqual(placeAtAnchor('km', { before: '', after: 'km' }, half), { ok: true, content: `${half} km` })
  assert.deepEqual(placeAtAnchor('An agent … at the rate of 12 % is?', { before: 'at the rate of 12', after: '%' }, half),
    { ok: true, content: `An agent … at the rate of 12${half}% is?` })
  assert.deepEqual(placeAtAnchor('35', { before: '35', after: '' }, '\\(\\sqrt{3}\\)'), { ok: true, content: '35\\(\\sqrt{3}\\)' })
  assert.equal(placeAtAnchor('2 km or 2 km', { before: '2', after: 'km' }, half).why, 'ANCHOR_AMBIGUOUS')
  assert.equal(placeAtAnchor('3 km', { before: '2', after: 'km' }, half).why, 'ANCHOR_NOT_FOUND')
  assert.equal(placeAtAnchor('', { before: '15', after: '' }, half).why, 'OWNER_TEXT_MISSING')
  assert.equal(placeAtAnchor('15', null, half).why, 'NO_ANCHOR')
  assert.equal(placeAtAnchor('15', { before: '15', after: '' }, '\\(\\text{1/2}\\)').why, 'INVALID_VALUE')
})

test('anchor: the owner\'s own text around the bitmap, bounded by the option markers on that line', () => {
  const it = (str, x) => ({ str, x, y: 300, width: str.length * 5, height: 12, fontName: 'f1' })
  const line = { page: 10, column: 0, y: 300, items: [it('A)', 40), it('15', 55), it('B)', 120), it('18', 135), it('C)', 200), it('16', 215)] }
  const options = ['A', 'B', 'C'].map((m, i) => ({ marker: m, at: { page: 10, column: 0, y: 300, x: [40, 120, 200][i] } }))
  assert.deepEqual(imageAnchor(line, { x: 146, box: { w: 6 } }, 'B', options), { before: '18', after: '' })
  const stem = { page: 11, column: 0, y: 500, items: [it('at the rate of 12', 60), it('% is?', 160)] }
  assert.deepEqual(imageAnchor(stem, { x: 146, box: { w: 8 } }, 'stem', []), { before: 'at the rate of 12', after: '% is?' })
  // Legacy-glyph runs (never stored as text) are not part of the anchor.
  const q75 = { page: 12, column: 0, y: 200, items: [it('A)', 40), it('35', 55), it('\uF06E\uF021', 90)] }
  assert.deepEqual(imageAnchor(q75, { x: 66, box: { w: 18 } }, 'A', [{ marker: 'A', at: { page: 12, column: 0, y: 200, x: 40 } }]), { before: '35', after: '' })
  // The owner's marker is not on this line although other markers are: refuse rather than guess.
  assert.equal(imageAnchor(line, { x: 146, box: { w: 6 } }, 'D', options), null)
})

test('the simulated teacher fixture is test data only: no pipeline module reads it', () => {
  const lib = path.resolve('scripts/lib')
  for (const f of fs.readdirSync(lib).filter(f => f.endsWith('.mjs')))
    assert.ok(!fs.readFileSync(path.join(lib, f), 'utf8').includes('b483c-simulated-teacher-math'), f)
  for (const f of fs.readdirSync('src', { recursive: true }).filter(f => /\.(js|jsx)$/.test(f)))
    assert.ok(!fs.readFileSync(path.join('src', f), 'utf8').includes('b483c-simulated-teacher-math'), f)
  const fixture = JSON.parse(fs.readFileSync('scripts/fixtures/b483c-simulated-teacher-math.json', 'utf8'))
  for (const [fp, r] of Object.entries(fixture.resolutions)) assert.equal(friendlyToLatex(r.input).ok, true, fp)
})
