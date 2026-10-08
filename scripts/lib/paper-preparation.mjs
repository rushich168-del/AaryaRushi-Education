// B4.7 — ONE production orchestration path for automatic paper preparation.
//
// Used by the teacher's browser ("Prepare Paper Automatically"; src/services/paperPreparationService.js)
// and by the Node tools/tests (scripts/lib/local-draft-db.mjs). Reuses the proven stages unchanged:
//   B4.1 layout (questions, options, stems, shared materials, answer key)  -> scripts/lib/paper-layout.mjs
//   B4.3 conservative visuals + material Telugu crops                      -> scripts/lib/visual-stage.mjs
//   B4.4 Integer + Glyph Telugu OCR                                        -> scripts/lib/telugu-stage.mjs
//   B4.2R mapping + writers 0023-0026, B4.4 Telugu writer 0025/0026        -> auto-*-persistence.mjs
//   B4.5 review items (0027) from the PERSISTED Draft                       -> scripts/lib/review-items.mjs
// Lifecycle (0029): start (one running run per import, refused on teacher work) -> stage progress
// with heartbeat -> complete (PREPARED only when this run wrote the Draft and its review items) or
// fail (teacher-safe stage/code/message; the technical cause stays in error_detail).
//
// platform: see preparation-platform-node.mjs. api: { rpc(name,args)->{data,error}, storage:{upload,remove},
// readDraftFlat(paperId)->flat rows }. Nothing here confirms an answer or invents content.

import { analysePaper } from './paper-layout.mjs'
import { buildPageModelsFromPdf } from './pdf-page-model-core.mjs'
import { runVisualStage } from './visual-stage.mjs'
import { runTeluguStage } from './telugu-stage.mjs'
import { MODEL_SHA256 } from './telugu-ocr-core.mjs'
import { mapPaperModelToDraft } from './paper-model-to-draft.mjs'
import { persistAutoVisuals } from './auto-visual-persistence.mjs'
import { persistAutoMaterialMedia, persistAutoMaterialTelugu } from './auto-material-persistence.mjs'
import { persistAutoTelugu } from './auto-telugu-persistence.mjs'
import { buildReviewItems, REVIEW_GENERATOR, REVIEW_GENERATOR_VERSION } from './review-items.mjs'

export const PREPARATION_ENGINE = 'ksc-b47-paper-preparation'
export const PREPARATION_VERSION = '1.0.0'
export const OCR_MODEL = 'int'
import { STAGES, stageLabel } from './preparation-stages.mjs'
export { STAGES, stageLabel }

const TEACHER_MESSAGES = {
  TEACHER_WORK: 'This Draft already contains teacher changes, so automatic preparation cannot replace it. Your work is preserved; continue in the Review Center or the Draft editor.',
  IN_PROGRESS: 'Preparation is already running for this paper (in this or another tab). Wait for it to finish.',
  SUPERSEDED: 'This preparation was stopped because another preparation of the same paper took over.',
  PDF_UNREADABLE: 'The source PDF could not be read. Check that the uploaded file is a valid PDF.',
  NO_QUESTIONS: 'No numbered questions were detected in this PDF, so nothing was prepared.',
  OCR_MODEL_UNAVAILABLE: 'The Telugu reading model could not be loaded. Check the connection and try again.',
  OCR_STALLED: 'Reading the Telugu text stopped responding. Nothing is shown as prepared; keep this tab open and try again.',
  CONNECTION_LOST: 'The connection was lost while saving. Nothing is shown as prepared; you can try again.',
  SAVE_FAILED: 'The prepared Draft could not be saved. Nothing is shown as prepared; you can try again.',
  REVIEW_FAILED: 'The review list could not be generated. Nothing is shown as prepared; you can try again.',
  UNEXPECTED: 'Preparation stopped unexpectedly. Nothing is shown as prepared; you can try again.',
}
const LIFECYCLE_CODES = new Set(['TEACHER_WORK', 'IN_PROGRESS', 'SUPERSEDED'])
export const teacherMessage = (code, stage) =>
  `${stage && stage !== 'COMPLETE' && !LIFECYCLE_CODES.has(code) ? `${stageLabel(stage)}: ` : ''}${TEACHER_MESSAGES[code] || TEACHER_MESSAGES.UNEXPECTED}`

export class PreparationError extends Error {
  constructor(stage, code, cause = null) {
    super(teacherMessage(code, stage))
    this.name = 'PreparationError'
    this.stage = stage; this.code = code; this.cause = cause
  }
}

const errText = e => [e?.message, e?.details, e?.hint, e?.cause?.message].filter(Boolean).join(' ')
function classify(stage, e) {
  if (e instanceof PreparationError) return e
  const t = errText(e)
  if (/KSC_DRAFT_HAS_TEACHER_WORK/.test(t)) return new PreparationError(stage, 'TEACHER_WORK', e)
  if (/KSC_PREPARATION_IN_PROGRESS/.test(t)) return new PreparationError(stage, 'IN_PROGRESS', e)
  if (/KSC_PREPARATION_NOT_RUNNING|KSC_ANALYSIS_RUN_INVALID|OWNER_INVALID/.test(t)) return new PreparationError(stage, 'SUPERSEDED', e)
  if (/KSC_OCR_TIMEOUT/.test(t)) return new PreparationError('READING_TELUGU', 'OCR_STALLED', e)
  if (/Failed to fetch|NetworkError|ECONNREFUSED|fetch failed|network/i.test(t)) return new PreparationError(stage, 'CONNECTION_LOST', e)
  if (stage === 'SAVING_DRAFT') return new PreparationError(stage, 'SAVE_FAILED', e)
  if (stage === 'PREPARING_REVIEW') return new PreparationError(stage, 'REVIEW_FAILED', e)
  return new PreparationError(stage, 'UNEXPECTED', e)
}
const unwrap = async p => { const { data, error } = await p; if (error) throw error; return data }

// Flat rows (as the Review Center reads them) -> the snapshot shape buildReviewItems consumes,
// ordered exactly like the SQL read-back of scripts/b4-persist-local.mjs.
export function snapshotFromFlat(flat) {
  const byKindPos = (a, b) => (a.media_kind < b.media_kind ? -1 : a.media_kind > b.media_kind ? 1 : a.position - b.position)
  const media = flat.media || []
  return {
    paper: flat.paper || null,
    materials: [...(flat.materials || [])].sort((a, b) => a.position - b.position)
      .map(m => ({ row: m, media: media.filter(x => x.draft_material_id === m.id).sort(byKindPos), texts: (flat.materialTexts || []).filter(t => t.draft_material_id === m.id) })),
    questions: [...(flat.questions || [])].sort((a, b) => a.position - b.position).map(q => ({
      row: q,
      media: media.filter(x => x.draft_question_id === q.id).sort(byKindPos),
      texts: (flat.questionTexts || []).filter(t => t.draft_question_id === q.id),
      options: (flat.options || []).filter(o => o.draft_question_id === q.id).sort((a, b) => a.position - b.position)
        .map(o => ({ row: o, texts: (flat.optionTexts || []).filter(t => t.draft_option_id === o.id) })),
    })),
  }
}

// hooks: { onProgress({ stage, label, detail }), beforeStage(stage) (tests inject failures here),
//          heartbeatMs (default 20 s) }. Returns { runId, draftPaperId, summary }.
export async function runPaperPreparation({ platform, api, importRecord, teacherId, pdfBytes, hooks = {} }) {
  const timings = {}
  const clock = () => platform.now()
  const tStart = clock()
  let stage = 'READING_PAPER', runId = null, lastDetail = {}, heartbeat = null, lastProgressAt = clock()
  const progress = async (s, detail = {}) => {
    stage = s; lastDetail = detail; lastProgressAt = clock()
    hooks.onProgress?.({ stage: s, label: stageLabel(s), detail })
    await unwrap(api.rpc('ksc_paper_preparation_progress', { p_run_id: runId, p_stage: s, p_detail: detail }))
  }
  const enter = async (s, detail = {}) => {
    if (timings[stage] && !timings[stage].ms) timings[stage].ms = clock() - timings[stage].t0
    timings[s] = { t0: clock() }
    stage = s   // a failure from here on belongs to this stage
    await hooks.beforeStage?.(s)
    await progress(s, detail)
  }

  // Start (refused when another run is live or the Draft holds teacher work).
  try {
    const started = await unwrap(api.rpc('ksc_start_paper_preparation', { p_import_id: importRecord.id, p_engine: PREPARATION_ENGINE,
      p_engine_version: PREPARATION_VERSION, p_client: { platform: platform.name, ocrModel: OCR_MODEL } }))
    runId = started.run_id
  } catch (e) { throw classify('READING_PAPER', e) }
  hooks.onProgress?.({ stage, label: stageLabel(stage), detail: {}, runId })
  // The heartbeat proves the pipeline is advancing, not merely that the tab is open: with no progress
  // for STALL_MS it stops, so a hung run becomes INTERRUPTED (0029: 120 s) and can be started again.
  const stallMs = hooks.stallMs ?? 300_000
  heartbeat = setInterval(() => {
    if (clock() - lastProgressAt > stallMs) return
    api.rpc('ksc_paper_preparation_progress', { p_run_id: runId, p_stage: stage, p_detail: lastDetail }).then(() => {}, () => {})
  }, hooks.heartbeatMs ?? 20000)

  let opened = null
  // pdf.js 6 has no PDFDocumentProxy.destroy(); the loading task ends the document and its worker.
  const closePdf = async () => {
    const o = opened; opened = null
    try { await o?.pdf?.loadingTask?.destroy() } catch { /* ignore */ }
    try { await o?.geometryPdf?.loadingTask?.destroy() } catch { /* ignore */ }
  }
  try {
    // 1. Reading paper (text layer of every page).
    timings.READING_PAPER = { t0: clock() }
    await hooks.beforeStage?.('READING_PAPER')
    // pdfBytes may be a loader (the browser downloads the private source PDF inside this recorded stage).
    try { opened = await platform.openPdf(typeof pdfBytes === 'function' ? await pdfBytes() : pdfBytes) } catch (e) { throw e instanceof PreparationError ? e : new PreparationError('READING_PAPER', 'PDF_UNREADABLE', e) }
    const { pages, numPages, fonts } = await buildPageModelsFromPdf(opened.pdf, opened.pdfjs.OPS,
      { geometryPdf: opened.geometryPdf ?? null, onPage: (page, total) => (page % 4 === 0 || page === total ? progress('READING_PAPER', { page, pages: total }) : null) })

    // 2. Questions, options, stems, shared materials and the answer key (one B4.1 pass).
    await enter('DETECTING_QUESTIONS', { pages: numPages })
    const model = analysePaper(pages)
    if (!model.questions.length) throw new PreparationError('DETECTING_QUESTIONS', 'NO_QUESTIONS')
    const found = { pages: numPages, questions: model.questions.length, fourOptions: model.questions.filter(q => q.options.length === 4).length,
      sharedMaterials: (model.materials || []).length, answerKeyEntries: model.answerKey?.entries?.length ?? model.questions.filter(q => q.proposedAnswer).length,
      proposedAnswers: model.questions.filter(q => q.proposedAnswer).length }
    await progress('DETECTING_QUESTIONS', found)

    // 3. Figures (conservative; ambiguous candidates go to review, never attached).
    await enter('DETECTING_FIGURES', { pages: numPages })
    const visual = await runVisualStage({ pdf: opened.pdf, pages, model, platform,
      onProgress: ({ page, pages: n }) => (page % 4 === 0 || page === n ? progress('DETECTING_FIGURES', { renderedPages: page, pages: n }) : null) })
    await progress('DETECTING_FIGURES', { figuresAttached: visual.manifest.accepted.length, candidatesForReview: visual.manifest.rejected.length,
      materialTeluguCrops: visual.manifest.materialSources.length })

    // 4. Telugu: Integer model + glyph hybrid (model checksum verified before use).
    await enter('READING_TELUGU', {})
    let pool, telugu
    try {
      const sha = await platform.modelSha256(OCR_MODEL)
      if (sha !== MODEL_SHA256[OCR_MODEL]) throw new Error(`model checksum mismatch ${sha}`)
      pool = await platform.createOcrPool({ model: OCR_MODEL, workers: platform.ocrWorkers ?? 4 })
    } catch (e) { throw new PreparationError('READING_TELUGU', 'OCR_MODEL_UNAVAILABLE', e) }
    try {
      // hooks.teluguDecoder === false: benchmark A/B only (the OCR-only routing); production always runs it.
      telugu = await runTeluguStage({ pdf: opened.pdf, pages, fonts, decoder: hooks.teluguDecoder !== false, passages: hooks.passageOcr !== false, model, platform, ocrPool: pool, modelKey: OCR_MODEL, modelSha256: MODEL_SHA256[OCR_MODEL],
        onProgress: ({ pagesDone, pagesTotal, runsDone, runsTotal }) => progress('READING_TELUGU', { pagesDone, pagesTotal, runsDone, runsTotal }) })
    } finally { await pool.terminate() }
    const tm = telugu.benchmark.metrics
    await progress('READING_TELUGU', { units: tm.unitsAttempted, questionsWithTelugu: tm.questionsWithTelugu, ocrSeconds: +(tm.timingsMs.ocr / 1000).toFixed(1) })
    await closePdf()

    // 5. Save: writer v3 (questions, options, shared materials, links, proposed answers only) ->
    //    question visuals -> material figures + material Telugu crops -> Telugu language versions.
    await enter('SAVING_DRAFT', {})
    const payload = mapPaperModelToDraft(model, { importId: importRecord.id, title: importRecord.test_name || importRecord.filename || 'Imported paper',
      sourceFilename: importRecord.filename || 'paper.pdf', visuals: visual.manifest })
    const written = await unwrap(api.rpc('ksc_replace_draft_analysis_v3', { p_import_id: importRecord.id, p_run_id: runId,
      p_paper: payload.paper, p_materials: payload.materials, p_questions: payload.questions, p_options: payload.options }))
    const draftPaperId = written.draft_paper_id
    const flat0 = await api.readDraftFlat(draftPaperId)
    const questionIdByNumber = new Map(flat0.questions.map(q => [String(q.source_question_number), q.id]))
    const numberById = new Map(flat0.questions.map(q => [q.id, q.source_question_number]))
    const optionsByKey = new Map(flat0.options.map(o => [`${numberById.get(o.draft_question_id)}|${o.marker}`, { id: o.id, content: o.content }]))
    const materialIdByIndex = new Map(payload.materials.map(m => [m.position, m.id]))
    let uploads = 0
    const totalUploads = visual.manifest.accepted.length + visual.manifest.materialSources.length + telugu.crops.size
    const storage = { ...api.storage, async upload(path, bytes, opts) {
      const r = await api.storage.upload(path, bytes, opts)
      uploads++
      if (uploads % 50 === 0 || uploads === totalUploads) await progress('SAVING_DRAFT', { questions: written.questions, uploads, totalUploads })
      return r
    } }
    const readVisual = row => visual.crops.get(row.file)
    const visualsRes = await persistAutoVisuals({ rows: visual.manifest.accepted, questionIdByNumber, teacherId, draftPaperId, runId, readCrop: readVisual, storage, rpc: api.rpc })
    const materialRes = await persistAutoMaterialMedia({ manifest: visual.manifest, materialIdByIndex, teacherId, draftPaperId, runId, readCrop: readVisual, storage, rpc: api.rpc })
    const teluguRes = await persistAutoTelugu({ benchmark: telugu.benchmark, questionIdByNumber, optionsByKey, teacherId, draftPaperId, runId,
      readCrop: region => telugu.crops.get(region.file), storage, rpc: api.rpc })
    // B4.8.4C: shared-passage OCR proposals (0033); never teacher verification.
    // hooks.passageOcr === false: tests/benchmarks only (the pre-0033 Draft shape); production always reads passages.
    const passageRes = hooks.passageOcr === false ? { inserted: 0 } : await persistAutoMaterialTelugu({ passages: telugu.benchmark.passages || [], materialIdByIndex, materialRecords: materialRes.records,
      ocrEngine: telugu.benchmark.meta.engine, ocrVersion: telugu.benchmark.meta.ocrVersion, draftPaperId, runId, rpc: api.rpc })
    await progress('SAVING_DRAFT', { questions: written.questions, options: written.options, materials: written.materials, uploads, totalUploads,
      questionVisuals: visualsRes.inserted, materialMedia: materialRes.inserted, teluguRows: teluguRes.question_texts + teluguRes.option_texts })

    // 6. Review items generated from the PERSISTED Draft (what the Review Center shows).
    await enter('PREPARING_REVIEW', {})
    const snapshot = snapshotFromFlat(await api.readDraftFlat(draftPaperId))
    const items = buildReviewItems(snapshot, { visualCandidates: visual.manifest })
    const review = await unwrap(api.rpc('ksc_replace_review_items', { p_draft_paper_id: draftPaperId, p_run_id: runId,
      p_generator: `${REVIEW_GENERATOR}@${REVIEW_GENERATOR_VERSION}`, p_items: items }))
    await progress('PREPARING_REVIEW', { reviewItems: review.items })

    // 7. Complete (server re-checks that this run wrote the Draft and its review items).
    timings.PREPARING_REVIEW.ms = clock() - timings.PREPARING_REVIEW.t0
    const summary = {
      questions: written.questions, options: written.options, sharedMaterials: written.materials, proposedAnswers: written.proposedAnswers,
      questionVisuals: visualsRes.inserted, materialMedia: materialRes.inserted, teluguCrops: teluguRes.crops,
      teluguQuestionRows: teluguRes.question_texts, teluguOptionRows: teluguRes.option_texts, passageOcrProposals: passageRes.unavailable ? 'UNAVAILABLE (0033 not applied)' : passageRes.inserted, reviewItems: review.items,
      ocrVersion: telugu.benchmark.meta.ocrVersion, platform: platform.name,
      timingsMs: { total: clock() - tStart, ocr: tm.timingsMs.ocr, teluguStage: timings.READING_TELUGU?.ms,
        ...Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, v.ms ?? null])) },
    }
    await unwrap(api.rpc('ksc_complete_paper_preparation', { p_run_id: runId, p_summary: summary }))
    hooks.onProgress?.({ stage: 'COMPLETE', label: stageLabel('COMPLETE'), detail: summary })
    return { runId, draftPaperId, summary }
  } catch (e) {
    const err = classify(stage, e)
    if (runId) {
      await api.rpc('ksc_fail_paper_preparation', { p_run_id: runId, p_stage: err.stage, p_code: err.code, p_message: err.message,
        p_detail: { technical: String(errText(err.cause || e)).slice(0, 1000) } }).then(() => {}, () => {})
    }
    throw err
  } finally {
    clearInterval(heartbeat)
    await closePdf()
  }
}
