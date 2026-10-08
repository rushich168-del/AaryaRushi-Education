import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import {
  validateTeluguInput, containsUnreadableGlyphs, hasTeluguUnicode, canMarkScriptNeutral,
} from '../src/services/draftPaperMapping.js'

// B3 acceptance repairs: Telugu rendering/integrity, script-neutral semantics, reversibility.
// Pure/static; database behavior is in scripts/test-draft-language-texts-db.mjs.

const TELUGU = 'త్రిభుజాల సంఖ్యను లెక్కించండి'
const PDF_LEGACY = ''   // real private-use bytes from the probe

test('genuine Telugu is accepted and recognised as Telugu', () => {
  const v = validateTeluguInput(TELUGU)
  assert.equal(v.ok, true); assert.equal(v.warn, false); assert.equal(v.reason, 'TELUGU_UNICODE')
  assert.equal(hasTeluguUnicode(TELUGU), true)
  assert.equal(containsUnreadableGlyphs(TELUGU), false)
  assert.ok([...TELUGU].every(ch => {
    const cp = ch.codePointAt(0)
    return (cp >= 0x0C00 && cp <= 0x0C7F) || cp === 0x20
  }), 'all characters are Telugu code points or spaces')
})

test('text copied from this PDF (legacy glyphs) is refused, never stored', () => {
  assert.equal(containsUnreadableGlyphs(PDF_LEGACY), true)
  const v = validateTeluguInput(PDF_LEGACY)
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'UNREADABLE_GLYPHS')
  assert.match(v.message, /type the Telugu/i)
  assert.equal(containsUnreadableGlyphs('abc�def'), true, 'replacement characters too')
})

test('text with no Telugu characters is savable but warns', () => {
  const v = validateTeluguInput('None')
  assert.equal(v.ok, true); assert.equal(v.warn, true); assert.equal(v.reason, 'NO_TELUGU_CHARACTERS')
})

test('script-neutral qualifies for numerals only', () => {
  for (const v of ['15', '19', '22', '24', '22.5', '1 : 2', '%']) assert.equal(canMarkScriptNeutral(v), true, v)
  for (const v of ['None', 'One', 'Two', 'Three', 'ఒకటి', 'Oil - Lamp', '15 marks', '']) {
    assert.equal(canMarkScriptNeutral(v), false, v)
  }
})

test('the service enforces both rules so the UI cannot be bypassed', () => {
  const svc = fs.readFileSync('src/services/draftPaperService.js', 'utf8')
  assert.match(svc, /function assertLanguagePayload/)
  assert.match(svc, /textQuality === 'SCRIPT_NEUTRAL' && !canMarkScriptNeutral/)
  assert.match(svc, /containsUnreadableGlyphs\(content \?\? ''\)/)
  // both upserts validate before touching the database
  for (const fn of ['upsertQuestionText', 'upsertOptionText']) {
    const block = svc.slice(svc.indexOf(`async ${fn}`), svc.indexOf(`async ${fn}`) + 400)
    assert.match(block, /assertLanguagePayload\(\{ content, textQuality, primaryContent \}\)/, fn)
    assert.ok(block.indexOf('assertLanguagePayload') < block.indexOf('supabase'), `${fn} validates first`)
  }
  assert.match(svc, /KSC_NOT_SCRIPT_NEUTRAL/); assert.match(svc, /KSC_UNREADABLE_GLYPHS/)
})

test('Workspace: Same is gated, reversible, and Telugu fields use the Telugu font', () => {
  const src = fs.readFileSync('src/components/site/PdfImportWorkspace.jsx', 'utf8')
  // gated in the UI as well as the service
  assert.match(src, /disabled=\{busy \|\| !canMarkScriptNeutral\(row\.content \?\? ''\)\}/)
  assert.match(src, /if \(!canMarkScriptNeutral\(optionRow\.content \?\? ''\)\)/)
  // reversible
  assert.match(src, /Enter Telugu instead/)
  assert.match(src, /const handleEnterTeluguInstead/)
  const revert = src.slice(src.indexOf('const handleEnterTeluguInstead'), src.indexOf('const QUALITY_LABEL'))
  assert.match(revert, /textQuality: 'MISSING'/)
  assert.match(revert, /sourceMediaId:/, 'the captured source region is preserved')
  for (const forbidden of ['insertDraftOption', 'removeDraftOption', 'confirmSingleChoice', 'is_confirmed_correct']) {
    assert.ok(!revert.includes(forbidden), `reversal must not use ${forbidden}`)
  }
  // paste validation + font + source-reference wording
  assert.match(src, /const teluguInputAccepted/)
  assert.match(src, /primaryContent: optionRow\.content \?\? ''/)
  assert.equal((src.match(/ksc-telugu/g) || []).length >= 4, true, 'Telugu font class on fields and displays')
  assert.match(src, /Source reference — Telugu could not be extracted reliably/)
  assert.match(src, /reference for typing the Telugu\. It is not the Telugu text itself/)
})

test('a Telugu-capable font stack exists without fetching a web font', () => {
  const css = fs.readFileSync('src/styles.css', 'utf8')
  assert.match(css, /\.ksc-telugu/)
  assert.match(css, /'Nirmala UI'/)
  assert.match(css, /'Noto Sans Telugu'/)
  assert.ok(!/@import url\(|fonts\.googleapis|fonts\.gstatic/.test(css), 'no remote web font is fetched')
  const tw = fs.readFileSync('tailwind.config.js', 'utf8')
  assert.match(tw, /telugu: \['Nirmala UI'/)
  assert.match(tw, /sans: \['Inter'[\s\S]*'Nirmala UI'/, 'default stack also gains Telugu coverage')
})

test('no migration was added or changed for this repair', () => {
  const files = fs.readdirSync('supabase/migrations').filter(f => f.startsWith('2026092200'))
  assert.deepEqual(files.sort(), [
    '202609220016_paper_preparation_review.sql',
    '202609220017_draft_paper_foundation.sql',
    '202609220018_draft_manual_questions.sql',
    '202609220019_draft_media.sql',
    '202609220020_draft_option_conflict_resolution.sql',
    '202609220021_draft_option_uniqueness.sql',
    '202609220022_draft_language_texts.sql',
  ], 'no 0023 and nothing removed')
})
