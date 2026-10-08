import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import {
  classifyExtractedText, isLegacyUnreliableText, isScriptNeutralText, groupLanguageTexts,
  detectOptionConflicts, optionRowsBySlot, DRAFT_LANGUAGES, TEXT_QUALITIES,
} from '../src/services/draftPaperMapping.js'

// P0-B3 pure checks: one logical question / one set of options / one answer, and a
// classifier grounded in the real probe evidence. No DB, no network.

// Real strings from the SI paper probe (page 1 ANSI-mapped header, page 2/3 private-use body).
const ANSI_HEADER = '≈£î{Ïº düº&û dü]ÿ˝Ÿ,'
const PUA_BODY = ''

test('legacy Telugu from this PDF is classified unreliable (private-use and ANSI-mapped)', () => {
  assert.equal(classifyExtractedText(PUA_BODY).reason, 'PRIVATE_USE_GLYPHS')
  assert.equal(isLegacyUnreliableText(PUA_BODY), true)
  assert.equal(classifyExtractedText(ANSI_HEADER).reason, 'ANSI_MAPPED_GLYPHS')
  assert.equal(isLegacyUnreliableText(ANSI_HEADER), true)
})

test('English, digits and genuine Telugu Unicode are never called legacy', () => {
  assert.equal(isLegacyUnreliableText('Count the number of triangles in the figure given below.'), false)
  assert.equal(isLegacyUnreliableText('A) None  B) One  C) Two  D) Three'), false)
  assert.equal(isLegacyUnreliableText('15 19 22 24'), false)
  assert.equal(isLegacyUnreliableText('45°C at 90° angle'), false, 'a few symbols are not evidence')
  assert.equal(classifyExtractedText('తెలుగు ప్రశ్న').reason, 'TELUGU_UNICODE')
  assert.equal(isLegacyUnreliableText('తెలుగు ప్రశ్న'), false)
})

test('the analyzer warns from code points only — never from font names', () => {
  const src = fs.readFileSync('src/services/pdfAnalyzer.js', 'utf8')
  const block = src.slice(src.indexOf('const legacy = classifyExtractedText'), src.indexOf('VISUAL_CONTENT_REQUIRES_REVIEW'))
  assert.match(block, /legacy\.legacyUnreliable/)
  assert.ok(!/includes\(''\)/.test(src), 'the always-true check is gone')
  assert.ok(!/fontName|fontFamily/.test(src), 'no font-name dependency in extraction')
  // Garbled text is never stored as Telugu content: extraction writes no language rows.
  assert.ok(!/draft_question_texts|draft_option_texts/.test(src), 'extraction writes no language rows')
})

test('script-neutral detection covers Q6 numerals only', () => {
  for (const v of ['15', '19', '22', '24', '22.5', '1 : 2']) assert.equal(isScriptNeutralText(v), true, v)
  for (const v of ['None', 'One', 'Two', 'Three', '15 marks', '']) assert.equal(isScriptNeutralText(v), false, v)
})

test('two language versions remain ONE logical question and ONE set of options', () => {
  const q = {
    id: 'q1', content: 'How many meaning ful English words…',
    draft_question_texts: [
      { language: 'en', content: 'How many…', text_quality: 'VALID_UNICODE' },
      { language: 'te', content: 'తెలుగు…', text_quality: 'TEACHER_ENTERED' },
    ],
    draft_options: ['None', 'One', 'Two', 'Three'].map((c, i) => ({
      id: `o${i}`, position: i, content: c,
      draft_option_texts: [{ language: 'te', content: `తెలుగు ${i}`, text_quality: 'TEACHER_ENTERED' }],
    })),
  }
  const { questionTexts, optionTexts } = groupLanguageTexts(q)
  assert.deepEqual(Object.keys(questionTexts).sort(), ['en', 'te'])
  assert.equal(q.draft_options.length, 4, 'four bilingual options are still four options')
  assert.equal(optionRowsBySlot(q.draft_options).filter(Boolean).length, 4)
  assert.deepEqual(detectOptionConflicts(q.draft_options), [], 'language versions create no slot conflicts')
  for (const o of q.draft_options) assert.equal(Object.keys(optionTexts[o.id]).length, 1, 'one Telugu version per option')
})

test('a Telugu option version is a child of the same option, never a fifth option', () => {
  const options = ['15', '19', '22', '24'].map((c, i) => ({
    id: `o${i}`, position: i, content: c,
    draft_option_texts: [{ language: 'te', content: null, text_quality: 'SCRIPT_NEUTRAL' }],
  }))
  const { optionTexts } = groupLanguageTexts({ draft_options: options })
  assert.equal(options.length, 4)
  assert.deepEqual(options.map(o => o.position), [0, 1, 2, 3], 'positions unchanged: no 0..7 spread')
  for (const o of options) assert.equal(optionTexts[o.id].te.text_quality, 'SCRIPT_NEUTRAL')
})

test('language vocabulary is fixed for V1 but extensible', () => {
  assert.deepEqual(DRAFT_LANGUAGES, ['en', 'te'])
  assert.deepEqual(TEXT_QUALITIES, ['VALID_UNICODE', 'UNRELIABLE', 'TEACHER_ENTERED', 'SCRIPT_NEUTRAL', 'MISSING'])
  const m = fs.readFileSync('supabase/migrations/202609220022_draft_language_texts.sql', 'utf8')
  assert.match(m, /language ~ '\^\[a-z\]\{2\}\(-\[A-Z\]\{2\}\)\?\$'/, 'any BCP-47-style code is allowed later')
})

test('Workspace: language edits never touch answers, and Telugu capture is TEXT_REGION only', () => {
  const src = fs.readFileSync('src/components/site/PdfImportWorkspace.jsx', 'utf8')
  const langBlock = src.slice(src.indexOf('---- P0-B3: language versions'), src.indexOf('const renderConflictPanel'))
  for (const forbidden of ['confirmSingleChoice', 'unconfirmSingleChoice', 'is_confirmed_correct', 'is_proposed_correct', 'insertDraftOption', 'removeDraftOption']) {
    assert.ok(!langBlock.includes(forbidden), `language handlers must not use ${forbidden}`)
  }
  assert.match(src, /allowedKinds: \['TEXT_REGION'\]/)
  assert.match(src, /textQuality: text \? 'TEACHER_ENTERED'/)
  assert.match(src, /textQuality: 'SCRIPT_NEUTRAL'/)
  // TEXT_REGION crops are shown in the language panel, not in the visuals list.
  assert.match(src, /questionVisuals: groupDraftMedia\(q\)\.questionMedia\.filter\(m => m\.media_kind !== 'TEXT_REGION'\)/)
  const capture = fs.readFileSync('src/components/site/SourceRegionCapture.jsx', 'utf8')
  assert.match(capture, /allowedKinds = DRAFT_MEDIA_KINDS/, 'TEXT_REGION is not offered by default')
})
