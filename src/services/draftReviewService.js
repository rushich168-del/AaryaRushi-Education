import { supabase } from '../lib/supabaseClient.js'

// B4.6 — Teacher Preparation & Exception Review Center: data access.
//
// Reads are plain per-table selects (RLS limits them to the signed-in teacher's own Draft).
// Every review DECISION goes through the review RPCs of migrations 0027/0028:
//   ksc_resolve_telugu_review_item  ACCEPT | EDIT | MARK_MISSING | DEFER (Telugu + shared-material Telugu)
//   ksc_revise_language_text        REPLACE | CLEAR a Telugu value, keeping OCR history (0028); while an
//                                   open item targets the row it IS that item's EDIT / MARK_MISSING
//   ksc_resolve_review_item         RESOLVED | ACCEPTED_AS_IS (+note) | DEFER for structural items
// Nothing here writes or deletes a language row directly, and nothing touches answer flags.

const SOURCE_BUCKET = 'ksc-source-documents'
const SIGNED_URL_SECONDS = 600
const CHUNK = 80   // ids per `in` filter (keeps request URLs short)

async function all(query) {
  const { data, error } = await query
  if (error) throw error
  return data || []
}
async function inChunks(table, column, ids) {
  const out = []
  for (let i = 0; i < ids.length; i += CHUNK) {
    out.push(...await all(supabase.from(table).select('*').in(column, ids.slice(i, i + CHUNK))))
  }
  return out
}

export const draftReviewService = {
  async loadPaper(draftPaperId) {
    const { data: paper, error } = await supabase.from('draft_papers').select('*').eq('id', draftPaperId).maybeSingle()
    if (error) throw error
    if (!paper) return null
    let importRecord = null
    if (paper.source_import_id) {
      const rows = await all(supabase.from('test_imports').select('*').eq('id', paper.source_import_id))
      importRecord = rows[0] || null
    }
    return { paper, importRecord }
  },

  // Everything the Review Center shows, as flat rows.
  async loadDraft(draftPaperId) {
    const [questions, media, materials] = await Promise.all([
      all(supabase.from('draft_questions').select('*').eq('draft_paper_id', draftPaperId).order('position', { ascending: true })),
      all(supabase.from('draft_media').select('*').eq('draft_paper_id', draftPaperId)),
      all(supabase.from('draft_materials').select('*').eq('draft_paper_id', draftPaperId).order('position', { ascending: true })),
    ])
    const questionIds = questions.map(q => q.id)
    const options = await inChunks('draft_options', 'draft_question_id', questionIds)
    const [questionTexts, optionTexts, materialTexts, review] = await Promise.all([
      inChunks('draft_question_texts', 'draft_question_id', questionIds),
      inChunks('draft_option_texts', 'draft_option_id', options.map(o => o.id)),
      inChunks('draft_material_texts', 'draft_material_id', materials.map(m => m.id)),
      this.loadReviewState(draftPaperId),
    ])
    return { questions, options, questionTexts, optionTexts, media, materials, materialTexts, ...review }
  },

  // The parts a decision can change (re-read after every decision).
  async loadReviewState(draftPaperId) {
    const [items, readiness] = await Promise.all([
      all(supabase.from('draft_review_items').select('*').eq('draft_paper_id', draftPaperId)),
      all(supabase.from('draft_question_readiness').select('*').eq('draft_paper_id', draftPaperId)),
    ])
    return { items, readiness }
  },
  async loadTexts({ questionIds, optionIds, materialIds }) {
    const [questionTexts, optionTexts, materialTexts] = await Promise.all([
      inChunks('draft_question_texts', 'draft_question_id', questionIds),
      inChunks('draft_option_texts', 'draft_option_id', optionIds),
      inChunks('draft_material_texts', 'draft_material_id', materialIds),
    ])
    return { questionTexts, optionTexts, materialTexts }
  },
  async loadOptions(questionIds) { return inChunks('draft_options', 'draft_question_id', questionIds) },

  async signedUrls(paths) {
    const unique = [...new Set((paths || []).filter(Boolean))]
    if (!unique.length) return {}
    const out = {}
    for (let i = 0; i < unique.length; i += 200) {
      const { data, error } = await supabase.storage.from(SOURCE_BUCKET).createSignedUrls(unique.slice(i, i + 200), SIGNED_URL_SECONDS)
      if (error) throw error
      for (const d of data || []) if (d.signedUrl) out[d.path] = d.signedUrl
    }
    return out
  },

  // ---- decisions ----
  async teluguDecision(itemId, action, { text = null, note = null } = {}) {
    const { data, error } = await supabase.rpc('ksc_resolve_telugu_review_item', { p_item_id: itemId, p_action: action, p_text: text, p_note: note })
    if (error) throw error
    return data
  },
  // Replace or clear a Telugu value while keeping its OCR history (0028).
  async reviseText(textId, owner, action, { text = null, note = null } = {}) {
    const { data, error } = await supabase.rpc('ksc_revise_language_text', { p_text_id: textId, p_owner: owner, p_action: action, p_text: text, p_note: note })
    if (error) throw error
    return data
  },
  async resolveItem(itemId, resolution, note = null) {
    const { data, error } = await supabase.rpc('ksc_resolve_review_item', { p_item_id: itemId, p_resolution: resolution, p_note: note })
    if (error) throw error
    return data
  },
  // B4.8.4C (migration 0033). Each is ONE server transaction with its own stale-view checks and evidence log.
  // Question-level "Looks correct": confidence/agreement-only checks of one question, all or nothing.
  async verifyQuestionTelugu(questionId, items, note = null) {
    const { data, error } = await supabase.rpc('ksc_verify_question_telugu', { p_question_id: questionId, p_items: items, p_note: note })
    if (error) throw error
    return data
  },
  // One decision for every occurrence of the same printed unit (frozen fingerprint). Per-occurrence outcomes.
  async applySourceDecision(draftPaperId, fingerprint, mode, text, occurrences, note = null) {
    const { data, error } = await supabase.rpc('ksc_apply_telugu_source_decision', { p_draft_paper_id: draftPaperId, p_fingerprint: fingerprint, p_mode: mode,
      p_text: text, p_occurrences: occurrences, p_note: note })
    if (error) throw error
    return data
  },
  // A shared passage's OCR proposal: ACCEPT it, or EDIT it (the OCR stays beside the teacher's text).
  async resolvePassage(itemId, action, expected, text = null, note = null) {
    const { data, error } = await supabase.rpc('ksc_resolve_shared_passage', { p_item_id: itemId, p_action: action, p_expected: expected, p_text: text, p_note: note })
    if (error) throw error
    return data
  },
  // B4.8.2 (migration 0031): close items whose defect an earlier teacher edit already removed (decided by
  // the database with the same rules that created them; nothing is confirmed). Returns how many were
  // closed, or null when 0031 is not applied yet — the page then behaves exactly as before.
  async reconcile(draftPaperId) {
    const { data, error } = await supabase.rpc('ksc_reconcile_review_items', { p_draft_paper_id: draftPaperId })
    if (error) {
      const missing = error.code === 'PGRST202' || error.code === '42883' || /ksc_reconcile_review_items/.test(String(error.message))
      if (missing) return null
      throw error
    }
    return data?.reconciled ?? 0
  },
  // The Draft workspace's option-text edit (teacher types an option exactly as printed). Since 0031 the
  // database closes this question's items whose defect the edit removed.
  async updateOptionText(optionId, content) {
    const { error } = await supabase.from('draft_options').update({ content }).eq('id', optionId)
    if (error) throw error
  },
}
