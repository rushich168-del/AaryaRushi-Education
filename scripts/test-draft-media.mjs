import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import {
  normalizeRegion, isUsableRegion, regionToPixels, draftMediaPath, buildDraftMediaRecord,
  groupDraftMedia, planDraftEdit, DRAFT_MEDIA_KINDS, MIN_REGION_FRACTION,
} from '../src/services/draftPaperMapping.js'

// P0-B2 pure + static checks. Real SQL behavior is in scripts/test-draft-media-db.mjs
// (throwaway local Postgres). No remote calls, no auth.signUp.

const M19 = fs.readFileSync('supabase/migrations/202609220019_draft_media.sql', 'utf8')
const canvas = { width: 1190, height: 1684 } // A4 at 2x (595 x 842 pt)
const T = '11111111-1111-4111-8111-111111111111'
const P = '22222222-2222-4222-8222-222222222222'
const M = '33333333-3333-4333-8333-333333333333'

test('1. normalized region conversion is correct and scale independent', () => {
  const r = normalizeRegion({ x0: 119, y0: 168.4, x1: 595, y1: 842 }, canvas)
  assert.deepEqual(r, { x: 0.1, y: 0.1, w: 0.4, h: 0.4 })
  // Same source region captured at 1x gives identical normalized coordinates.
  const r1 = normalizeRegion({ x0: 59.5, y0: 84.2, x1: 297.5, y1: 421 }, { width: 595, height: 842 })
  assert.deepEqual(r1, r)
  // Dragging in the reverse direction yields the same region.
  assert.deepEqual(normalizeRegion({ x0: 595, y0: 842, x1: 119, y1: 168.4 }, canvas), r)
  assert.deepEqual(regionToPixels(r, canvas), { sx: 119, sy: 168, sw: 476, sh: 674 })
})

test('2. coordinates outside the page are clamped to the page (contract)', () => {
  const r = normalizeRegion({ x0: -50, y0: -20, x1: 2000, y1: 900 }, canvas)
  assert.equal(r.x, 0); assert.equal(r.y, 0); assert.equal(r.w, 1)
  assert.ok(r.y + r.h <= 1)
  assert.equal(isUsableRegion({ x: 0.9, y: 0.1, w: 0.2, h: 0.2 }), false, 'region past the edge is rejected')
})

test('3. zero-area and too-small crops are rejected', () => {
  assert.equal(isUsableRegion(normalizeRegion({ x0: 100, y0: 100, x1: 100, y1: 100 }, canvas)), false)
  assert.equal(isUsableRegion(normalizeRegion({ x0: 100, y0: 100, x1: 400, y1: 100 }, canvas)), false, 'zero height')
  assert.equal(isUsableRegion({ x: 0.1, y: 0.1, w: MIN_REGION_FRACTION / 2, h: 0.2 }), false)
  assert.throws(() => buildDraftMediaRecord({ id: M, teacherId: T, draftPaperId: P, owner: { questionId: 'q' }, mediaKind: 'DIAGRAM', region: { x: 0, y: 0, w: 0, h: 0 }, sourcePage: 1, pageWidthPt: 595, pageHeightPt: 842 }))
})

test('4. storage path uses the teacher / paper / media namespace', () => {
  assert.equal(draftMediaPath(T, P, M), `imports/${T}/draft-media/${P}/${M}.png`)
  assert.match(M19, /storage_path LIKE 'imports\/' \|\| auth\.uid\(\)::text \|\| '\/draft-media\/' \|\| draft_media\.draft_paper_id::text/)
})

test('5 (payload). a visual needs exactly one owner', () => {
  const base = { id: M, teacherId: T, draftPaperId: P, mediaKind: 'DIAGRAM', region: { x: 0.1, y: 0.1, w: 0.3, h: 0.2 }, sourcePage: 2, pageWidthPt: 595, pageHeightPt: 842 }
  assert.equal(buildDraftMediaRecord({ ...base, owner: { questionId: 'q' } }).draft_question_id, 'q')
  assert.equal(buildDraftMediaRecord({ ...base, owner: { optionId: 'o' } }).draft_option_id, 'o')
  assert.equal(buildDraftMediaRecord({ ...base, owner: { materialId: 'm' } }).draft_material_id, 'm')
  assert.throws(() => buildDraftMediaRecord({ ...base, owner: {} }))
  assert.throws(() => buildDraftMediaRecord({ ...base, owner: { questionId: 'q', optionId: 'o' } }))
  assert.match(M19, /num_nonnulls\(draft_question_id, draft_option_id, draft_material_id\) = 1/)
})

test('11. TEXT_REGION is an allowed media kind (DB) but not offered in the B2 UI', () => {
  assert.match(M19, /'TEXT_REGION'/)
  assert.ok(!DRAFT_MEDIA_KINDS.includes('TEXT_REGION'))
})

test('12. question media maps independently of option media', () => {
  const q = {
    id: 'q1',
    draft_media: [{ id: 'm1', draft_question_id: 'q1', position: 0 }],
    draft_options: [
      { id: 'o1', draft_media: [{ id: 'm2', draft_option_id: 'o1', position: 0 }] },
      { id: 'o2', draft_media: [] },
    ],
  }
  const { questionMedia, optionMedia } = groupDraftMedia(q)
  assert.deepEqual(questionMedia.map(m => m.id), ['m1'])
  assert.deepEqual(optionMedia.o1.map(m => m.id), ['m2'])
  assert.deepEqual(optionMedia.o2, [])
})

test('13. option media does not alter answer correctness planning', () => {
  const rows = [
    { id: 'o0', position: 0, content: 'A', is_proposed_correct: true, is_confirmed_correct: false, draft_media: [{ id: 'm' }] },
    { id: 'o1', position: 1, content: 'B', is_proposed_correct: false, is_confirmed_correct: false, draft_media: [] },
  ]
  const p = planDraftEdit({ rows, formOptions: ['A', 'B'], selectedSlot: null, answerChosen: false })
  assert.equal(p.confirmSlot, null)
  assert.equal(p.updates.length, 0)
  const record = buildDraftMediaRecord({ id: M, teacherId: T, draftPaperId: P, owner: { optionId: 'o0' }, mediaKind: 'IMAGE', region: { x: 0.1, y: 0.1, w: 0.3, h: 0.2 }, sourcePage: 1, pageWidthPt: 595, pageHeightPt: 842 })
  assert.ok(!Object.keys(record).some(k => /correct/.test(k)), 'media payload never carries answer flags')
})

test('14. a signed URL is never persisted as canonical media data', () => {
  const record = buildDraftMediaRecord({ id: M, teacherId: T, draftPaperId: P, owner: { questionId: 'q' }, mediaKind: 'TABLE', region: { x: 0.1, y: 0.1, w: 0.3, h: 0.2 }, sourcePage: 1, pageWidthPt: 595, pageHeightPt: 842 })
  assert.ok(!Object.keys(record).some(k => /url/i.test(k)), 'no url field')
  assert.ok(!/^https?:/.test(record.storage_path))
  assert.match(M19, /storage_path ~ '\^imports\//, 'DB only accepts the private path shape')
  const svc = fs.readFileSync('src/services/draftMediaService.js', 'utf8')
  assert.ok(!/insert\([^)]*signed/i.test(svc), 'service inserts the record, not a signed URL')
})

test('15. migration touches no Question Bank / Exam Engine / legacy / storage-policy objects', () => {
  const code = M19.replace(/--.*$/gm, '')
  for (const forbidden of ['publish_test', 'test_attempts', 'attempt_answers', 'test_question_snapshots', 'test_option_snapshots',
    'public.questions', 'public.question_options', 'question_answer_keys', 'ksc_replace_test_import_analysis',
    'test_import_candidates', 'storage.objects', 'storage.buckets',
    // prerequisite existence checks are fine; redefining these B1 functions is not
    'FUNCTION public.ksc_replace_draft_analysis', 'FUNCTION public.ksc_insert_draft_question']) {
    assert.ok(!code.includes(forbidden), `must not touch ${forbidden}`)
  }
  assert.ok(!/TO anon/.test(code), 'nothing granted to anon')
  assert.ok(/^BEGIN;/m.test(M19) && /^COMMIT;/m.test(M19))
})
