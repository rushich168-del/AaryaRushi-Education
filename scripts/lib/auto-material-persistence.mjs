// B4.2R — AUTO_REGION media owned by shared materials (migration 0026).
//
// Two kinds of crop, both from the B4.3 run:
//   * accepted material figures (manifest.accepted rows whose owner is a MATERIAL) -> FIGURE;
//   * the material's Telugu source region (manifest.materialSources)             -> TEXT_REGION
//     (geometry/crop only; Telugu material text is not OCR'd, so it stays for review).
// Same guarantees as the question writers: crops uploaded first to new private paths, one atomic
// RPC, uploads removed on any failure, replaced objects removed only after success.

import { draftMediaPath, isUsableRegion } from '../../src/services/draftPaperMapping.js'
import { B43_DETECTOR, B43_DETECTOR_VERSION, AUTO_VISUAL_KIND } from './visual-detection.mjs'

const uuid = () => globalThis.crypto.randomUUID()

export class AutoMaterialPersistError extends Error {
  constructor(stage, cause, detail = {}) {
    super(`Automatic material media not saved (${stage}): ${cause?.message || cause}`)
    this.stage = stage
    this.cause = cause
    Object.assign(this, detail)
  }
}

export function buildAutoMaterialRecords({ manifest, materialIdByIndex, teacherId, draftPaperId, runId, newId = uuid }) {
  const out = [], skipped = []
  const add = (entry, materialIndex, mediaKind, detail, confidence) => {
    const materialId = materialIdByIndex.get(materialIndex)
    if (!materialId) { skipped.push({ id: entry.id ?? entry.file, reason: 'MATERIAL_NOT_IN_DRAFT' }); return }
    if (!isUsableRegion(entry.region)) { skipped.push({ id: entry.id ?? entry.file, reason: 'REGION_UNUSABLE' }); return }
    const id = newId()
    out.push({
      entry,
      record: {
        id, draft_material_id: materialId, position: out.filter(o => o.record.draft_material_id === materialId).length,
        media_kind: mediaKind, storage_path: draftMediaPath(teacherId, draftPaperId, id),
        width_px: entry.widthPx ?? entry.pixel?.sw, height_px: entry.heightPx ?? entry.pixel?.sh, source_page: entry.page,
        region_x: entry.region.x, region_y: entry.region.y, region_w: entry.region.w, region_h: entry.region.h,
        page_width_pt: entry.pageWidthPt, page_height_pt: entry.pageHeightPt, render_scale: entry.renderScale,
        detection_confidence: confidence, detection_detail: { detector: B43_DETECTOR, version: B43_DETECTOR_VERSION, runId, ...detail },
        warnings: [],
      },
    })
  }
  for (const r of manifest.accepted || []) {
    if (r.owner?.kind !== 'MATERIAL') continue
    add(r, r.owner.materialIndex, r.mediaKind || AUTO_VISUAL_KIND,
      { candidateId: r.id, tier: r.tier, inkBoxPt: r.inkBoxPt, figureBoxPt: r.figureBoxPt, cropPt: r.cropPt, absorbedLabels: r.absorbedLabels || [], sha256: r.sha256 ?? null }, r.confidence)
  }
  for (const s of manifest.materialSources || []) {
    // Region comes from the text layer (not a detector guess), so its detection confidence is 1.
    add(s, s.materialIndex, 'TEXT_REGION', { source: 'B4.1_MATERIAL_TELUGU_GEOMETRY', regionIndex: s.regionIndex, sha256: s.sha256 }, 1)
  }
  return { records: out, skipped }
}

export async function persistAutoMaterialMedia({ manifest, materialIdByIndex, teacherId, draftPaperId, runId, readCrop, storage, rpc, newId }) {
  const { records, skipped } = buildAutoMaterialRecords({ manifest, materialIdByIndex, teacherId, draftPaperId, runId, newId })
  const uploaded = []
  const cleanup = async () => {
    if (!uploaded.length) return []
    const { error } = await storage.remove(uploaded.slice())
    return error ? uploaded.slice() : []
  }
  for (const { entry, record } of records) {
    let bytes
    try {
      bytes = await readCrop(entry)
      if (!bytes || !bytes.length) throw new Error(`empty crop ${entry.file}`)
    } catch (e) { throw new AutoMaterialPersistError('crop', e, { orphaned: await cleanup() }) }
    const { error } = await storage.upload(record.storage_path, bytes, { contentType: 'image/png', upsert: false })
    if (error) throw new AutoMaterialPersistError('upload', error, { orphaned: await cleanup() })
    uploaded.push(record.storage_path)
  }
  const { data, error } = await rpc('ksc_replace_auto_material_media', { p_draft_paper_id: draftPaperId, p_run_id: runId, p_media: records.map(r => r.record) })
  if (error) throw new AutoMaterialPersistError('database', error, { orphaned: await cleanup() })
  const removed = data?.removed_paths || []
  if (removed.length) await storage.remove(removed)
  return { inserted: data?.inserted ?? 0, uploaded, replacedPaths: removed, skipped, records: records.map(r => r.record) }
}

// B4.8.4C — shared-passage Telugu OCR as a PROPOSAL (migration 0033, ksc_replace_auto_material_telugu).
// The OCR text is always kept in ocr_original_content with its provenance; it becomes the row's content only
// where a question unit's text would be stored (HIGH/MEDIUM, or LOW with decoder agreement) and even then stays
// unverified: the material's review item stays blocking until the teacher accepts or edits it once.
const PASSAGE_CONTENT_VERDICTS = new Set(['HIGH', 'MEDIUM'])
const storesPassage = p => PASSAGE_CONTENT_VERDICTS.has(p.verdict) || (p.verdict === 'LOW' && (p.flags || []).includes('OCR_DECODER_AGREE') && p.decoder?.agree === true)
export function buildAutoMaterialTeluguPayload({ passages, materialIdByIndex, materialRecords, ocrEngine, ocrVersion }) {
  const texts = [], skipped = []
  for (const p of passages || []) {
    const materialId = materialIdByIndex.get(p.materialIndex)
    if (!materialId) { skipped.push({ materialIndex: p.materialIndex, reason: 'MATERIAL_NOT_IN_DRAFT' }); continue }
    if (!p.text || !/[\u0C00-\u0C7F]/.test(p.text) || ['EMPTY', 'NOT_TELUGU'].includes(p.verdict)) { skipped.push({ materialIndex: p.materialIndex, reason: 'NO_TELUGU_OCR' }); continue }
    const crop = (materialRecords || []).filter(r => r.draft_material_id === materialId && r.media_kind === 'TEXT_REGION')
      .sort((a, b) => (a.detection_detail?.regionIndex ?? 0) - (b.detection_detail?.regionIndex ?? 0))[0]
    texts.push({
      draft_material_id: materialId, text_quality: storesPassage(p) ? 'OCR_EXTRACTED' : 'MISSING', ocr_original_content: p.text,
      ocr_engine: ocrEngine, ocr_version: ocrVersion, ocr_confidence: +(p.minConfidence / 100).toFixed(3), ocr_verdict: p.verdict,
      ocr_detail: { flags: p.flags || [], lines: p.lines ?? null, runs: p.runs ?? null, ocrRawText: p.ocrRawText ?? null, hybrid: p.hybrid ?? null,
        decoder: p.decoder ?? null },
      source_media_id: crop?.id ?? null,
    })
  }
  return { texts, skipped }
}
export async function persistAutoMaterialTelugu({ passages, materialIdByIndex, materialRecords, ocrEngine, ocrVersion, draftPaperId, runId, rpc }) {
  const { texts, skipped } = buildAutoMaterialTeluguPayload({ passages, materialIdByIndex, materialRecords, ocrEngine, ocrVersion })
  const { data, error } = await rpc('ksc_replace_auto_material_telugu', { p_draft_paper_id: draftPaperId, p_run_id: runId, p_texts: texts })
  if (error) {
    // Before migration 0033 is applied the writer does not exist: passages stay transcription items, exactly as
    // before (the app must keep working until the owner applies 0033). Any other error fails the preparation.
    const missing = error.code === 'PGRST202' || error.code === '42883' || /ksc_replace_auto_material_telugu/.test(String(error.message)) && /(Could not find|does not exist)/.test(String(error.message))
    if (missing) return { inserted: 0, skipped, unavailable: true }
    throw new AutoMaterialPersistError('database', error)
  }
  return { inserted: data?.material_texts ?? 0, skipped }
}
