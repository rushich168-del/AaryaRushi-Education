import { supabase } from '../lib/supabaseClient.js'
import { STAGES, stageLabel } from '../../scripts/lib/preparation-stages.mjs'
import { draftReviewService } from './draftReviewService.js'
// The pipeline (pdf.js page analysis, OCR worker, writers) is loaded only when preparation starts.
const loadPipeline = () => Promise.all([import('../../scripts/lib/paper-preparation.mjs'), import('./preparation/browserPlatform.js')])

// B4.7 — "Prepare Paper Automatically": runs the ONE shared orchestrator
// (scripts/lib/paper-preparation.mjs) in the teacher's browser against Supabase.
// Lifecycle/state live in the database (0029); the UI derives everything from getStatus().

const BUCKET = 'ksc-source-documents'
export { STAGES, stageLabel }

const unwrap = async p => { const { data, error } = await p; if (error) throw error; return data }

async function sourcePdfBytes(importRecord) {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(importRecord.storage_path, 300)
  if (error || !data?.signedUrl) throw new Error(`source PDF not accessible: ${error?.message || 'no signed URL'}`)
  const res = await fetch(data.signedUrl)
  if (!res.ok) throw new Error(`source PDF download failed (${res.status})`)
  return new Uint8Array(await res.arrayBuffer())
}

const api = {
  rpc: (name, args) => supabase.rpc(name, args),
  storage: {
    upload: (path, bytes, opts = {}) => supabase.storage.from(BUCKET).upload(path, new Blob([bytes], { type: opts.contentType || 'image/png' }),
      { contentType: opts.contentType || 'image/png', upsert: opts.upsert ?? false }),
    remove: paths => supabase.storage.from(BUCKET).remove(paths),
  },
  readDraftFlat: paperId => draftReviewService.loadDraft(paperId),
}

export const paperPreparationService = {
  // Persisted state: UPLOADED | RUNNING | INTERRUPTED | FAILED | PREPARED (+ stage, counts, failure).
  getStatus: importId => unwrap(supabase.rpc('ksc_paper_preparation_status', { p_import_id: importId })),

  // Runs the whole pipeline. onProgress receives { stage, label, detail }. Resolves with
  // { runId, draftPaperId, summary }; rejects with a PreparationError (teacher-safe message).
  async prepare(importRecord, { onProgress } = {}) {
    const [{ runPaperPreparation, PreparationError }, { createBrowserPlatform }] = await loadPipeline()
    const { data: auth, error } = await supabase.auth.getUser()
    if (error || !auth?.user?.id) throw new PreparationError('READING_PAPER', 'UNEXPECTED', error)
    return runPaperPreparation({ platform: createBrowserPlatform(), api, importRecord, teacherId: auth.user.id,
      pdfBytes: () => sourcePdfBytes(importRecord), hooks: { onProgress } })
  },
}
