// B4.3 — persistence of detector-accepted crops as AUTO_REGION draft_media.
//
// Pure orchestration over injected adapters, so the same code runs against throwaway
// PostgreSQL + an in-memory store in tests and against Supabase later:
//   storage: { upload(path, bytes, { contentType, upsert }) -> { error }, remove(paths) -> { error } }
//   rpc(name, args) -> { data, error }
//   readCrop(row) -> Uint8Array | Buffer       (the PNG produced by the detector)
//
// Ordering guarantees no falsely attached record:
//   1. build + validate every record (nothing touched yet);
//   2. upload every crop to a NEW private path (upsert:false); on any failure remove the
//      uploads made so far and stop — no database call happens;
//   3. one atomic RPC inserts all rows (and drops this paper's previous automatic crops);
//      on failure remove every upload — the database rolled back, so nothing points at them;
//   4. only after success remove the objects of the replaced automatic rows.

import { draftMediaPath, isUsableRegion } from '../../src/services/draftPaperMapping.js'
import { B43_DETECTOR, B43_DETECTOR_VERSION, AUTO_VISUAL_KIND } from './visual-detection.mjs'

const uuid = () => globalThis.crypto.randomUUID()

export class AutoVisualPersistError extends Error {
  constructor(stage, cause, detail = {}) {
    super(`Automatic visuals not saved (${stage}): ${cause?.message || cause}`)
    this.stage = stage
    this.cause = cause
    Object.assign(this, detail)
  }
}

// Manifest rows -> draft_media payloads. Only ACCEPTED, question-owned rows qualify.
export function buildAutoVisualRecords({ rows, questionIdByNumber, teacherId, draftPaperId, runId, newId = uuid }) {
  if (!teacherId || !draftPaperId || !runId) throw new Error('teacherId, draftPaperId and runId are required')
  const records = [], skipped = []
  const perQuestion = new Map()
  for (const row of rows || []) {
    if (row.status !== 'ACCEPTED') { skipped.push({ id: row.id, reason: 'NOT_ACCEPTED' }); continue }
    if (row.owner?.kind !== 'QUESTION') { skipped.push({ id: row.id, reason: 'OWNER_NOT_QUESTION' }); continue }
    if (row.mediaKind === 'TEXT_REGION') { skipped.push({ id: row.id, reason: 'TEXT_REGION_NEVER_A_VISUAL' }); continue }
    const questionId = questionIdByNumber.get(String(row.owner.questionNumber))
    if (!questionId) { skipped.push({ id: row.id, reason: 'QUESTION_NOT_IN_DRAFT' }); continue }
    if (!isUsableRegion(row.region)) { skipped.push({ id: row.id, reason: 'REGION_UNUSABLE' }); continue }
    if (!(row.confidence >= 0 && row.confidence <= 1)) { skipped.push({ id: row.id, reason: 'CONFIDENCE_INVALID' }); continue }
    perQuestion.set(questionId, (perQuestion.get(questionId) || 0) + 1)
    const id = newId()
    records.push({
      row,
      record: {
        id,
        draft_question_id: questionId,
        position: perQuestion.get(questionId) - 1,
        media_kind: row.mediaKind || AUTO_VISUAL_KIND,
        storage_path: draftMediaPath(teacherId, draftPaperId, id),
        width_px: row.widthPx ?? row.pixel?.sw,
        height_px: row.heightPx ?? row.pixel?.sh,
        source_page: row.page,
        region_x: row.region.x, region_y: row.region.y, region_w: row.region.w, region_h: row.region.h,
        page_width_pt: row.pageWidthPt,
        page_height_pt: row.pageHeightPt,
        render_scale: row.renderScale,
        detection_confidence: row.confidence,
        detection_detail: {
          detector: B43_DETECTOR, version: B43_DETECTOR_VERSION, runId, candidateId: row.id, tier: row.tier,
          inkBoxPt: row.inkBoxPt, cropPt: row.cropPt, signals: row.signals, absorbedLabels: row.absorbedLabels || [],
          sha256: row.sha256 ?? null,
        },
        warnings: [],
      },
    })
  }
  // Defence in depth: the detector already refuses >1 visual per question.
  const multi = [...perQuestion.entries()].filter(([, n]) => n > 1)
  if (multi.length) throw new Error(`More than one automatic visual for question(s): ${multi.map(([q]) => q).join(', ')}`)
  return { records, skipped }
}

export async function persistAutoVisuals({ rows, questionIdByNumber, teacherId, draftPaperId, runId, readCrop, storage, rpc, newId }) {
  const { records, skipped } = buildAutoVisualRecords({ rows, questionIdByNumber, teacherId, draftPaperId, runId, newId })
  const uploaded = []
  const cleanup = async () => {
    if (!uploaded.length) return []
    const { error } = await storage.remove(uploaded.slice())
    return error ? uploaded.slice() : []
  }

  for (const { row, record } of records) {
    let bytes
    try {
      bytes = await readCrop(row)
      if (!bytes || !bytes.length) throw new Error(`empty crop for ${row.id}`)
    } catch (e) {
      const orphaned = await cleanup()
      throw new AutoVisualPersistError('crop', e, { orphaned })
    }
    const { error } = await storage.upload(record.storage_path, bytes, { contentType: 'image/png', upsert: false })
    if (error) {
      const orphaned = await cleanup()
      throw new AutoVisualPersistError('upload', error, { orphaned })
    }
    uploaded.push(record.storage_path)
  }

  const { data, error } = await rpc('ksc_replace_auto_visuals', {
    p_draft_paper_id: draftPaperId,
    p_run_id: runId,
    p_media: records.map(r => r.record),
  })
  if (error) {
    const orphaned = await cleanup()
    throw new AutoVisualPersistError('database', error, { orphaned })
  }

  const removedPaths = data?.removed_paths || []
  let staleObjects = []
  if (removedPaths.length) {
    const { error: removeError } = await storage.remove(removedPaths)
    if (removeError) staleObjects = removedPaths          // private orphans only; no record points at them
  }
  return { inserted: data?.inserted ?? 0, uploaded, replacedPaths: removedPaths, staleObjects, skipped }
}
