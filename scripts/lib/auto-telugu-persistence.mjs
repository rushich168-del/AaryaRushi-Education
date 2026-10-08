// B4.4 — persistence of OCR'd Telugu as LANGUAGE VERSIONS (migration 0025).
//
// Pure mapping + orchestration over injected adapters (same shape as B4.3):
//   storage: { upload(path, bytes, opts) -> { error }, remove(paths) -> { error } }
//   rpc(name, args) -> { data, error }
//   readCrop(region) -> bytes of the unit's untouched 2x source crop
//
// Mapping rules (never guesses, never creates options, never touches answers):
//   * HIGH / MEDIUM units      -> OCR_EXTRACTED text (MEDIUM carries review reasons);
//   * LOW, DIGIT_MISMATCH,
//     EMPTY, NOT_TELUGU units   -> MISSING + review reasons; the OCR attempt stays only in the
//                                 crop's provenance, so misread numbers never become content;
//   * AMBIGUOUS_BLOCK          -> stem MISSING + STRUCTURE_AMBIGUOUS, whole-block crop and OCR kept
//                                 for review; no option rows (no guessed mapping);
//   * script-neutral options   -> SCRIPT_NEUTRAL (no OCR, no crop);
//   * options with no Telugu in the source -> MISSING + TELUGU_OPTIONS_NOT_IN_SOURCE;
//   * B4.8.4B: a LOW unit the legacy decoder reads identically (OCR_DECODER_AGREE, nothing else wrong)
//     stores its OCR text like MEDIUM; the decoder reading (status, agreement, suggestion) is kept beside
//     the crop. A decoder suggestion is NEVER stored as content.
// Every OCR row points at its AUTO_REGION TEXT_REGION crop.

import { draftMediaPath, isUsableRegion, isScriptNeutralText } from '../../src/services/draftPaperMapping.js'

export const B44_STRUCTURE_ENGINE = 'ksc-b44-telugu-structure'
export const B44_STRUCTURE_VERSION = '1.0.0'
const CONTENT_VERDICTS = new Set(['HIGH', 'MEDIUM'])
const storesContent = u => CONTENT_VERDICTS.has(u.verdict) || (u.verdict === 'LOW' && (u.flags || []).includes('OCR_DECODER_AGREE') && u.decoder?.agree === true)
const uuid = () => globalThis.crypto.randomUUID()

export class AutoTeluguPersistError extends Error {
  constructor(stage, cause, detail = {}) {
    super(`Automatic Telugu not saved (${stage}): ${cause?.message || cause}`)
    this.stage = stage
    this.cause = cause
    Object.assign(this, detail)
  }
}

// Stored OCR version: engine version + model + hybrid (B4.5R benchmarks carry meta.ocrVersion; older
// ones fall back to the B4.4 form).
export const ocrVersionOf = benchmark => benchmark.meta?.ocrVersion || `${benchmark.meta.engineVersion}+${benchmark.meta.model}`

const reviewReasons = u => (u.verdict === 'HIGH' ? [] : [u.verdict, ...(u.flags || [])])

// benchmark: the b44-benchmark.json object. options: Map("<questionNumber>|<marker>" -> { id, content }).
export function buildAutoTeluguPayload({ benchmark, questionIdByNumber, optionsByKey, teacherId, draftPaperId, runId, newId = uuid }) {
  if (!teacherId || !draftPaperId || !runId) throw new Error('teacherId, draftPaperId and runId are required')
  const media = [], questionTexts = [], optionTexts = [], skipped = []

  const cropsFor = (q, unit) => (unit.regions || []).map((r, k) => {
    if (!isUsableRegion(r.region)) { skipped.push({ q: q.number, unit: unit.kind, reason: 'REGION_UNUSABLE' }); return null }
    const id = newId()
    const record = {
      id, draft_question_id: questionIdByNumber.get(String(q.number)), position: media.length,
      storage_path: draftMediaPath(teacherId, draftPaperId, id),
      width_px: r.widthPx, height_px: r.heightPx, source_page: r.page,
      region_x: r.region.x, region_y: r.region.y, region_w: r.region.w, region_h: r.region.h,
      page_width_pt: r.pageWidthPt, page_height_pt: r.pageHeightPt, render_scale: r.renderScale,
      detection_confidence: 1,   // geometry comes from the text layer, not from a detector guess
      detection_detail: {
        detector: B44_STRUCTURE_ENGINE, version: B44_STRUCTURE_VERSION, runId, structure: q.structure,
        unit: unit.kind, marker: unit.marker ?? null, regionIndex: k, sha256: r.sha256,
        // The OCR attempt is always kept beside its crop, including text NOT promoted to content.
        ocrText: unit.text || '', ocrVerdict: unit.verdict, ocrConfidence: +(unit.minConfidence / 100).toFixed(3),
        // B4.5R provenance: the engine/model/hybrid that produced ocrText, the pure-OCR text before the
        // glyph layer, and per-run alignment status (refused runs kept their OCR).
        ocrEngine: benchmark.meta?.engine ?? null, ocrVersion: ocrVersionOf(benchmark), ocrModel: benchmark.meta?.model ?? null,
        ...(unit.hybrid ? { ocrRawText: unit.ocrRawText ?? null, hybrid: unit.hybrid } : {}),
        // B4.8.4B: the legacy decoder's reading (Unicode Telugu only; the glyph stream is never kept).
        ...(unit.decoder ? { decoder: unit.decoder } : {}),
        // B4.8.4C: hash of the printed unit (identical source = identical printed text) and the PDF's own
        // digit evidence. The candidate text of a REPAIRABLE unit is an offer to the teacher, never content.
        ...(unit.sourceFp ? { sourceFp: unit.sourceFp } : {}),
        ...(unit.printedDigits && unit.printedDigits.status !== 'NO_DIGITS' ? { printedDigits: unit.printedDigits } : {}),
      },
    }
    media.push({ record, region: r })
    return record
  }).filter(Boolean)

  const textRow = (unit, crops, extraReasons = []) => {
    const content = storesContent(unit) ? unit.text : null
    return {
      text_quality: content ? 'OCR_EXTRACTED' : 'MISSING',
      content,
      ocr_confidence: +(unit.minConfidence / 100).toFixed(3),
      ocr_verdict: unit.verdict,
      ocr_review_reasons: [...extraReasons, ...reviewReasons(unit)],
      source_media_id: crops[0]?.id ?? null,
    }
  }

  for (const q of benchmark.questions) {
    const questionId = questionIdByNumber.get(String(q.number))
    if (!questionId) { skipped.push({ q: q.number, reason: 'QUESTION_NOT_IN_DRAFT' }); continue }
    if (q.structure === 'NO_TELUGU') continue

    if (q.structure === 'AMBIGUOUS_BLOCK') {
      const crops = cropsFor(q, q.units[0])
      questionTexts.push({ draft_question_id: questionId, text_quality: 'MISSING', content: null, ocr_confidence: null, ocr_verdict: null,
        ocr_review_reasons: ['STRUCTURE_AMBIGUOUS', ...q.reasons.filter(r => r !== 'STRUCTURE_AMBIGUOUS')], source_media_id: crops[0]?.id ?? null })
      continue
    }

    const stem = q.units.find(u => u.kind === 'STEM')
    if (stem) {
      const crops = cropsFor(q, stem)
      questionTexts.push({ draft_question_id: questionId, ...textRow(stem, crops) })
    }
    const teluguMarkers = new Set(q.units.filter(u => u.kind === 'OPTION').map(u => u.marker))
    for (const u of q.units.filter(u => u.kind === 'OPTION')) {
      const opt = optionsByKey.get(`${q.number}|${u.marker}`)
      if (!opt) { skipped.push({ q: q.number, unit: `OPTION${u.marker}`, reason: 'OPTION_NOT_IN_DRAFT' }); continue }
      const crops = cropsFor(q, u)
      optionTexts.push({ draft_option_id: opt.id, ...textRow(u, crops) })
    }
    // Options without a Telugu unit: script-neutral ones reuse their content; others were not
    // printed in Telugu at all.
    for (const [key, opt] of optionsByKey) {
      const [n, marker] = key.split('|')
      if (Number(n) !== q.number || teluguMarkers.has(marker)) continue
      if (isScriptNeutralText(opt.content ?? '')) {
        optionTexts.push({ draft_option_id: opt.id, text_quality: 'SCRIPT_NEUTRAL', content: null, ocr_confidence: null, ocr_verdict: null, ocr_review_reasons: [], source_media_id: null })
      } else if (q.structure === 'STEM_ONLY') {
        optionTexts.push({ draft_option_id: opt.id, text_quality: 'MISSING', content: null, ocr_confidence: null, ocr_verdict: null, ocr_review_reasons: ['TELUGU_OPTIONS_NOT_IN_SOURCE'], source_media_id: null })
      }
    }
  }
  return { media, questionTexts, optionTexts, skipped }
}

export async function persistAutoTelugu({ benchmark, questionIdByNumber, optionsByKey, teacherId, draftPaperId, runId, readCrop, storage, rpc, newId }) {
  const payload = buildAutoTeluguPayload({ benchmark, questionIdByNumber, optionsByKey, teacherId, draftPaperId, runId, newId })
  const uploaded = []
  const cleanup = async () => {
    if (!uploaded.length) return []
    const { error } = await storage.remove(uploaded.slice())
    return error ? uploaded.slice() : []
  }
  for (const { record, region } of payload.media) {
    let bytes
    try {
      bytes = await readCrop(region)
      if (!bytes || !bytes.length) throw new Error(`empty crop ${region.file}`)
    } catch (e) { throw new AutoTeluguPersistError('crop', e, { orphaned: await cleanup() }) }
    const { error } = await storage.upload(record.storage_path, bytes, { contentType: 'image/png', upsert: false })
    if (error) throw new AutoTeluguPersistError('upload', error, { orphaned: await cleanup() })
    uploaded.push(record.storage_path)
  }
  const { data, error } = await rpc('ksc_replace_auto_telugu', {
    p_draft_paper_id: draftPaperId, p_run_id: runId,
    p_ocr_engine: benchmark.meta.engine, p_ocr_version: ocrVersionOf(benchmark),
    p_media: payload.media.map(m => m.record), p_question_texts: payload.questionTexts, p_option_texts: payload.optionTexts,
  })
  if (error) throw new AutoTeluguPersistError('database', error, { orphaned: await cleanup() })
  const removed = data?.removed_paths || []
  let staleObjects = []
  if (removed.length) { const { error: e } = await storage.remove(removed); if (e) staleObjects = removed }
  return { ...data, uploaded, staleObjects, skipped: payload.skipped, counts: { media: payload.media.length, questionTexts: payload.questionTexts.length, optionTexts: payload.optionTexts.length } }
}
