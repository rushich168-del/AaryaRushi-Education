import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDraftPayload } from '../src/services/draftPaperMapping.js'

// P0-A: the Draft layer MUST accept incomplete / uncertain extraction and must
// never fabricate an answer or content. These are pure contract tests over the
// mapping that feeds the ksc_replace_draft_analysis RPC.

const importRecord = {
  id: 'imp-1', test_name: 'SI Model Paper', filename: 'si.pdf', exam_id: 'exam-1', level_id: 'lvl-1',
}

test('incomplete question with no options and no answer persists honestly', () => {
  const analysis = {
    source_page_count: 28,
    materials: [],
    candidates: [
      {
        question_number: '5',
        question_text: null, // damaged/missing content allowed
        options: [],          // no options extracted
        proposed_correct_index: null,
        source_page: 2,
        status: 'UNRESOLVED',
        warnings: ['MISSING_OPTION', 'ANSWER_NOT_FOUND'],
      },
    ],
  }
  const { draftQuestions, draftOptions } = buildDraftPayload(importRecord, analysis)
  assert.equal(draftQuestions.length, 1)
  assert.equal(draftOptions.length, 0, 'no options must be fabricated')
  const q = draftQuestions[0]
  assert.equal(q.content, null, 'missing content stays null, not invented')
  assert.equal(q.extraction_status, 'UNRESOLVED')
  assert.deepEqual(q.warnings, ['MISSING_OPTION', 'ANSWER_NOT_FOUND'], 'warnings are durable')
  assert.equal(q.response_type, 'SINGLE_CHOICE')
})

test('proposed answer is carried but never becomes a confirmed answer', () => {
  const analysis = {
    materials: [],
    candidates: [
      {
        question_number: '1', question_text: 'Capital of Telangana?',
        options: ['Hyderabad', 'Warangal', 'Nizamabad', 'Karimnagar'],
        proposed_correct_index: 0, source_page: 1, status: 'NEEDS_REVIEW', warnings: [],
      },
    ],
  }
  const { draftOptions } = buildDraftPayload(importRecord, analysis)
  assert.equal(draftOptions.length, 4)
  assert.equal(draftOptions[0].is_proposed_correct, true, 'proposed answer carried')
  assert.ok(!('is_confirmed_correct' in draftOptions[0]) || draftOptions[0].is_confirmed_correct !== true,
    'ingest never sets confirmed answer')
  assert.deepEqual(draftOptions.map(o => o.is_proposed_correct), [true, false, false, false])
})

test('answer with no proposed index leaves zero proposed-correct options', () => {
  const analysis = {
    materials: [],
    candidates: [{ question_number: '2', question_text: 'Q', options: ['a', 'b'], proposed_correct_index: null, status: 'NEEDS_REVIEW', warnings: [] }],
  }
  const { draftOptions } = buildDraftPayload(importRecord, analysis)
  assert.equal(draftOptions.filter(o => o.is_proposed_correct).length, 0)
})

test('more than four options are preserved (no 0..3 cap in the draft layer)', () => {
  const analysis = {
    materials: [],
    candidates: [{ question_number: '3', question_text: 'Q', options: ['a', 'b', 'c', 'd', 'e', 'f'], proposed_correct_index: 4, status: 'NEEDS_REVIEW', warnings: [] }],
  }
  const { draftOptions } = buildDraftPayload(importRecord, analysis)
  assert.equal(draftOptions.length, 6, 'all six options kept')
  assert.equal(draftOptions[4].is_proposed_correct, true, 'index 4 allowed (> legacy 0..3 cap)')
})

test('shared passage material links questions and preserves provenance', () => {
  const analysis = {
    materials: [{ id: 'm-legacy-1', material_type: 'PASSAGE', content_text: 'Read the passage...', source_page: 3 }],
    candidates: [
      { question_number: '10', question_text: 'Per passage, ...', options: ['a', 'b', 'c', 'd'], proposed_correct_index: 1, source_page: 3, status: 'NEEDS_REVIEW', warnings: ['PASSAGE_LINK_UNCERTAIN'], material_id: 'm-legacy-1' },
    ],
  }
  const { draftMaterials, draftQuestions } = buildDraftPayload(importRecord, analysis)
  assert.equal(draftMaterials.length, 1)
  assert.equal(draftMaterials[0].material_type, 'PASSAGE')
  assert.equal(draftMaterials[0].source_page_start, 3)
  assert.equal(draftQuestions[0].shared_material_id, draftMaterials[0].id, 'question links to remapped material id')
  assert.equal(draftQuestions[0].source_page, 3, 'provenance page preserved')
  assert.deepEqual(draftQuestions[0].warnings, ['PASSAGE_LINK_UNCERTAIN'])
})

test('paper metadata carries import provenance and PDF source type', () => {
  const { paperMeta } = buildDraftPayload(importRecord, { materials: [], candidates: [], source_page_count: 28 })
  assert.equal(paperMeta.source_type, 'PDF')
  assert.equal(paperMeta.source_filename, 'si.pdf')
  assert.equal(paperMeta.exam_id, 'exam-1')
  assert.equal(paperMeta.source_page_count, 28)
})
