import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import { classifyText, fontLooksLegacyTelugu } from './probe-telugu-text-layer.mjs'

// Proves the diagnostic's judgments before it is used on the real PDF, and records what
// the current TELUGU_EXTRACTION_UNRELIABLE check actually does. No PDF, DB or network.

test('genuine Telugu Unicode is recognised', () => {
  const r = classifyText('తెలుగు ప్రశ్న')
  assert.equal(r.verdict, 'TELUGU_UNICODE')
  assert.ok(r.counts.telugu > 0)
})

test('digits-only options are script-neutral (no translation needed)', () => {
  assert.equal(classifyText('15').verdict, 'SCRIPT_NEUTRAL')
  assert.equal(classifyText(' 24 ').verdict, 'SCRIPT_NEUTRAL')
  assert.equal(classifyText('22.5 %').verdict, 'SCRIPT_NEUTRAL')
  // An option marker like "(A)" contains a Latin letter, so it is reported as LATIN.
  assert.equal(classifyText('(A)').verdict, 'LATIN')
})

test('plain English is LATIN, not Telugu', () => {
  assert.equal(classifyText('Count the number of triangles').verdict, 'LATIN')
})

test('private-use and replacement characters are reported as garbled', () => {
  assert.equal(classifyText('').verdict, 'GARBLED_PRIVATE_USE')
  assert.equal(classifyText('abc�def').verdict, 'GARBLED_REPLACEMENT_CHARS')
})

test('legacy-font Telugu typed as Latin looks LATIN — the font name is the evidence', () => {
  // Legacy encodings map Telugu glyphs onto Latin/symbol code points, so the TEXT alone
  // can never prove it: such items surface as LATIN or OTHER_NON_ASCII, never as Telugu.
  assert.equal(classifyText('˚£¤¥ÅÆ').verdict, 'OTHER_NON_ASCII')
  assert.equal(classifyText('kxTeR ¹rP').verdict, 'OTHER_NON_ASCII')
  assert.equal(classifyText('kxTeR rP').verdict, 'LATIN', 'pure-ASCII legacy text is indistinguishable from English by text alone')
  assert.equal(fontLooksLegacyTelugu('Anu Script Manager', 'g_d0_f3'), true)
  assert.equal(fontLooksLegacyTelugu('Shree-Telugu-0800', 'g_d0_f4'), true)
  assert.equal(fontLooksLegacyTelugu('NotoSansTelugu', 'g_d0_f1'), false, 'Unicode Telugu fonts are not flagged')
  assert.equal(fontLooksLegacyTelugu('Times New Roman', 'g_d0_f2'), false)
})

test('empty and mixed strings', () => {
  assert.equal(classifyText('').verdict, 'EMPTY')
  const mixed = classifyText('Assertion (A): తెలుగు')
  assert.equal(mixed.verdict, 'TELUGU_UNICODE')
  assert.ok(mixed.counts.latin > 0 && mixed.counts.telugu > 0, 'mixed content is visible in the counts')
})

test('the old always-true TELUGU_EXTRACTION_UNRELIABLE check is gone (P0-B3 fix)', () => {
  const src = fs.readFileSync('src/services/pdfAnalyzer.js', 'utf8')
  // The old condition was `allText.includes('')` — an empty string, hence always true, so it
  // fired on any non-ASCII text (e.g. "45°C") and missed pure-ASCII legacy Telugu.
  assert.ok(!/includes\(''\)/.test(src), 'the always-true condition is removed')
  assert.match(src, /classifyExtractedText\(/, 'detection now uses the code-point classifier')
  const reducedOld = t => /[^\x00-\x7F]/.test(t)
  assert.equal(reducedOld('45°C'), true, 'the old rule would have fired here (false positive)')
})
