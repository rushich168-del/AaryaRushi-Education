// Prepare the golden paper into a THROWAWAY local PostgreSQL through the ONE production orchestrator
// (scripts/lib/paper-preparation.mjs — the same code the teacher's "Prepare Paper Automatically" runs in
// the browser), then dump the persisted Draft.
//
// Full KSC migration chain (scripts/lib/local-draft-db.mjs) -> upload as the teacher -> runPaperPreparation
// (page model -> questions/materials/answer key -> figures -> Telugu OCR -> writer v3 + visuals + material
// media + Telugu rows -> review items -> PREPARED) -> read back questions, options, language rows, media,
// materials, review items and derived readiness -> reports/b4-preview/draft-dump.json, with the stored
// crops copied to reports/b4-preview/storage/ (storage_path -> local file map). The cluster is deleted
// afterwards. Never connects to Supabase; no auth.signUp.
//
// Usage: node scripts/b4-persist-local.mjs   (needs the golden PDF; KSC_GOLDEN_PDF overrides its path)

import fs from 'fs'
import path from 'path'
import { createLocalKscDb, prepareGoldenDraft, dumpDraft } from './lib/local-draft-db.mjs'

const OUT_DIR = 'reports/b4-preview'

async function main() {
  const t0 = Date.now()
  const db = await createLocalKscDb()
  try {
    const { runId, draftPaperId, summary } = await prepareGoldenDraft(db)
    const dump = await dumpDraft(db, draftPaperId, runId)
    // storage_path -> local copy of the stored crop (stands in for the private bucket in offline previews).
    const storage = {}
    fs.rmSync(path.join(OUT_DIR, 'storage'), { recursive: true, force: true })
    for (const [objectPath, file] of Object.entries(db.storageMap)) {
      if (!objectPath.includes('/draft-media/')) continue
      const out = path.join(OUT_DIR, 'storage', ...objectPath.split('/'))
      fs.mkdirSync(path.dirname(out), { recursive: true })
      fs.copyFileSync(file, out)
      storage[objectPath] = out.replace(/\\/g, '/')
    }
    fs.mkdirSync(OUT_DIR, { recursive: true })
    fs.writeFileSync(path.join(OUT_DIR, 'draft-dump.json'), JSON.stringify({ generated: new Date().toISOString(), orchestrator: 'scripts/lib/paper-preparation.mjs',
      writers: summary, storage, ...dump }, null, 1))
    console.log(JSON.stringify({ reviewItems: summary.reviewItems, readiness: dump.readiness.reduce((o, r) => (o[r.readiness] = (o[r.readiness] || 0) + 1, o), {}),
      questions: summary.questions, options: summary.options, sharedMaterials: summary.sharedMaterials, proposedAnswers: summary.proposedAnswers,
      questionVisuals: summary.questionVisuals, materialMedia: summary.materialMedia, teluguCrops: summary.teluguCrops,
      teluguQuestionRows: summary.teluguQuestionRows, teluguOptionRows: summary.teluguOptionRows, preparationState: dump.run.preparation_state,
      teacherWork: dump.teacherWork, seconds: (Date.now() - t0) / 1000 }))
  } finally {
    await db.stop()
  }
}
main().catch(e => { console.error('Local preparation failed:', e.message?.slice(0, 2000) || e); process.exit(1) })
