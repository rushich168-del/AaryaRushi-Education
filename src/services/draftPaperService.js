import { supabase } from '../lib/supabaseClient.js'
import { buildDraftPayload, compareDraftOptions, canMarkScriptNeutral, containsUnreadableGlyphs } from './draftPaperMapping.js'

// Server-side-of-the-client guards so the UI cannot be bypassed by calling the service
// directly. SCRIPT_NEUTRAL must be earned by the content; legacy glyphs are never stored.
function assertLanguagePayload({ content, textQuality, primaryContent }) {
  if (textQuality === 'SCRIPT_NEUTRAL' && !canMarkScriptNeutral(primaryContent ?? '')) {
    const err = new Error('KSC_NOT_SCRIPT_NEUTRAL')
    err.hint = 'Only digits or symbols can be marked as the same in both languages.'
    throw err
  }
  if (containsUnreadableGlyphs(content ?? '')) {
    const err = new Error('KSC_UNREADABLE_GLYPHS')
    err.hint = 'The text contains the PDF\'s legacy font glyphs, not Telugu characters.'
    throw err
  }
}

// Narrow service for the P0-A durable Draft Paper boundary.
// It is the canonical preparation state for the new import path. It does NOT
// touch the legacy candidate tables/RPC and does NOT perform any promotion.

export { buildDraftPayload }

// Controlled token raised by ksc_replace_draft_analysis (migration 0018) when the
// Draft Paper holds teacher work. Never show raw database wording to teachers.
export const TEACHER_WORK_BLOCKED_TOKEN = 'KSC_DRAFT_HAS_TEACHER_WORK'
export const TEACHER_WORK_BLOCKED_MESSAGE =
  'Retry Analysis is unavailable because this Draft Paper contains teacher changes. Your work has been preserved.'

// Teacher-facing text for guarded option removal errors (never raw database wording).
export function optionRemovalMessage(err) {
  const text = [err?.message, err?.details, err?.hint].filter(Boolean).join(' ')
  if (text.includes('KSC_OPTION_IS_CONFIRMED')) return 'This option is the confirmed answer. Unconfirm the answer before removing it.'
  if (text.includes('KSC_OPTION_HAS_MEDIA')) return 'This option has an attached visual. Remove the visual first.'
  if (text.includes('KSC_OPTION_SLOT_CONFLICT')) return 'This option slot has competing rows. Resolve the conflict first.'
  return 'Could not remove the option.'
}

// Teacher-facing text for language-version errors.
export function languageTextMessage(err) {
  const text = [err?.message, err?.details, err?.hint].filter(Boolean).join(' ')
  if (text.includes('KSC_NOT_SCRIPT_NEUTRAL')) return 'Only digits or symbols can be marked as the same in both languages. Type the Telugu for this option instead.'
  if (text.includes('KSC_UNREADABLE_GLYPHS')) return 'That text is the PDF\'s legacy font glyphs, not Telugu characters, so it would show as boxes. Copying Telugu out of this PDF cannot work — please type it instead.'
  if (text.includes('KSC_TEXT_SOURCE_NOT_TEXT_REGION')) return 'The linked source must be a captured text region.'
  if (text.includes('KSC_TEXT_SOURCE_WRONG_CONTEXT')) return 'That source region belongs to a different question. Capture the region on this question.'
  if (/draft_(question|option)_texts/i.test(text)) return 'Language versions are unavailable. Migration 0022 may not be applied yet.'
  return 'Could not save the language version.'
}

// Teacher-facing text for slot-conflict resolution errors.
export function conflictResolutionMessage(err) {
  const text = [err?.message, err?.details, err?.hint].filter(Boolean).join(' ')
  if (text.includes('KSC_CONFLICT_CHANGED')) return 'The competing options changed since you opened this. Reload and review again.'
  if (text.includes('KSC_CONFLICT_CONFIRMED_ON_DISCARDED_ROW')) return 'The option you are discarding is the confirmed answer. Keep it, or unconfirm the answer first.'
  if (text.includes('KSC_CONFLICT_VISUAL_ON_BOTH_ROWS')) return 'Both options have visuals. Remove one visual first.'
  if (text.includes('KSC_CONFLICT_VISUAL_ON_DISCARDED_ROW')) return 'The option you are discarding has a visual. Tick "Move its visual to the kept option", or keep that option.'
  if (text.includes('KSC_NO_CONFLICT_AT_SLOT')) return 'This slot no longer has a conflict. Reload to see the current options.'
  return 'Could not resolve the option conflict.'
}

export function isTeacherWorkBlockedError(err) {
  const text = [err?.message, err?.details, err?.hint].filter(Boolean).join(' ')
  return text.includes(TEACHER_WORK_BLOCKED_TOKEN)
}

export const draftPaperService = {
  // Persist a normalized analysis for an import as a durable Draft Paper.
  // Returns the paper id.
  async replaceAnalysis(importRecord, analysis) {
    const { paperMeta, draftMaterials, draftQuestions, draftOptions } = buildDraftPayload(importRecord, analysis)
    const { data, error } = await supabase.rpc('ksc_replace_draft_analysis', {
      p_import_id: importRecord.id,
      p_paper: paperMeta,
      p_materials: draftMaterials,
      p_questions: draftQuestions,
      p_options: draftOptions,
    })
    if (error) throw error
    return data // draft paper id
  },

  async getDraftPaperByImport(importId) {
    const { data, error } = await supabase
      .from('draft_papers')
      .select('*')
      .eq('source_import_id', importId)
      .maybeSingle()
    if (error) throw error
    return data
  },

  async getDraftQuestions(draftPaperId) {
    const query = select => supabase
      .from('draft_questions')
      .select(select)
      .eq('draft_paper_id', draftPaperId)
      .order('position', { ascending: true })
    // P0-B2 visuals are embedded when migration 0019 exists; otherwise fall back so
    // preparation keeps working without visuals.
    // P0-B3 language versions and P0-B2 visuals are embedded when their migrations exist;
    // otherwise fall back so preparation keeps working.
    let { data, error } = await query('*, draft_media(*), draft_question_texts(*), draft_options(*, draft_media(*), draft_option_texts(*))')
    if (error && /draft_(question|option)_texts/i.test(`${error.message} ${error.details || ''} ${error.hint || ''}`)) {
      console.warn('[draftPaper] Language versions unavailable (migration 0022 not applied?):', error.message)
      ;({ data, error } = await query('*, draft_media(*), draft_options(*, draft_media(*))'))
    }
    if (error && /draft_media/i.test(`${error.message} ${error.details || ''} ${error.hint || ''}`)) {
      console.warn('[draftPaper] Draft visuals unavailable (migration 0019 not applied?):', error.message)
      ;({ data, error } = await query('*, draft_options(*)'))
    }
    if (error) throw error
    return (data || []).map(q => ({
      ...q,
      draft_options: (q.draft_options || []).sort(compareDraftOptions),
    }))
  },

  async getDraftMaterials(draftPaperId) {
    const { data, error } = await supabase
      .from('draft_materials')
      .select('*')
      .eq('draft_paper_id', draftPaperId)
    if (error) throw error
    return data || []
  },

  // Current option rows of one question, read fresh (used to plan repeat-safe saves).
  async getDraftOptions(questionId) {
    const { data, error } = await supabase
      .from('draft_options')
      .select('id, position, content, is_proposed_correct, is_confirmed_correct, created_at')
      .eq('draft_question_id', questionId)
      .order('position', { ascending: true })
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
    if (error) throw error
    return data || []
  },

  // ---- P0-B3: language versions (never create options; never touch answers) ----
  // One row per (owner, language). Teacher-entered text is always TEACHER_ENTERED.
  async upsertQuestionText({ questionId, language, content, textQuality, sourceMediaId = null, primaryContent = '' }) {
    assertLanguagePayload({ content, textQuality, primaryContent })
    const { data, error } = await supabase
      .from('draft_question_texts')
      .upsert({
        draft_question_id: questionId, language, content: content ?? null,
        text_quality: textQuality, source: 'TEACHER', source_media_id: sourceMediaId,
      }, { onConflict: 'draft_question_id,language' })
      .select()
      .single()
    if (error) throw error
    return data
  },

  async upsertOptionText({ optionId, language, content, textQuality, sourceMediaId = null, primaryContent = '' }) {
    assertLanguagePayload({ content, textQuality, primaryContent })
    const { data, error } = await supabase
      .from('draft_option_texts')
      .upsert({
        draft_option_id: optionId, language, content: content ?? null,
        text_quality: textQuality, source: 'TEACHER', source_media_id: sourceMediaId,
      }, { onConflict: 'draft_option_id,language' })
      .select()
      .single()
    if (error) throw error
    return data
  },

  // Teacher-approved resolution of one conflicting option slot (migration 0020).
  // expectedOptionIds must be exactly the competing rows the teacher reviewed.
  async resolveOptionSlotConflict({ questionId, position, keepOptionId, expectedOptionIds, moveVisual = false }) {
    const { data, error } = await supabase.rpc('ksc_resolve_option_slot_conflict', {
      p_question_id: questionId,
      p_position: position,
      p_keep_option_id: keepOptionId,
      p_expected_option_ids: expectedOptionIds,
      p_move_visual: moveVisual,
    })
    if (error) throw error
    return data
  },

  // Explicit, guarded option removal (migration 0020). Refused for a confirmed
  // option or an option with a visual; ordinary Save never deletes options.
  async removeDraftOption(optionId) {
    const { error } = await supabase.rpc('ksc_remove_draft_option', { p_option_id: optionId })
    if (error) throw error
  },

  // Edit the question text (marks the row EDITED, but not CONFIRMED).
  async updateDraftQuestionText(questionId, content) {
    const { error } = await supabase
      .from('draft_questions')
      .update({ content, teacher_review_status: 'EDITED' })
      .eq('id', questionId)
    if (error) throw error
  },

  // Edit a single option's text.
  async updateDraftOptionText(optionId, content) {
    const { error } = await supabase
      .from('draft_options')
      .update({ content })
      .eq('id', optionId)
    if (error) throw error
  },

  // Atomically insert a TEACHER-origin draft question at a Draft position
  // (later questions shift). No options/answer are created. Returns { id, position }.
  async insertDraftQuestionAt({ draftPaperId, position, sourceQuestionNumber, content, sourceReference }) {
    const { data, error } = await supabase.rpc('ksc_insert_draft_question', {
      p_draft_paper_id: draftPaperId,
      p_position: position,
      p_source_question_number: sourceQuestionNumber ?? null,
      p_content: content ?? null,
      p_source_reference: sourceReference ?? null,
    })
    if (error) throw error
    return data
  },

  // True when the Draft Paper holds teacher work that Retry must not replace.
  async hasTeacherWork(draftPaperId) {
    const { data, error } = await supabase.rpc('ksc_draft_has_teacher_work', { p_draft_paper_id: draftPaperId })
    if (error) throw error
    return data === true
  },

  // Insert a teacher-entered option into an existing draft question. Never
  // proposed or confirmed automatically. Returns { id, position }.
  async insertDraftOption(questionId, position, content) {
    if (typeof content !== 'string' || content.trim() === '') {
      throw new Error('Cannot insert a blank draft option.')
    }
    const { data, error } = await supabase
      .from('draft_options')
      .insert({
        draft_question_id: questionId,
        position,
        content,
        is_proposed_correct: false,
        is_confirmed_correct: false,
        origin: 'TEACHER',
      })
      .select('id, position')
      .single()
    if (error) throw error
    return data
  },

  // Teacher confirms/corrects the SINGLE_CHOICE answer. Pass null to mark
  // reviewed with no confirmed answer.
  async confirmSingleChoice(questionId, optionId) {
    const { error } = await supabase.rpc('ksc_confirm_draft_single_choice', {
      p_question_id: questionId,
      p_option_id: optionId ?? null,
    })
    if (error) throw error
  },

  // Revert a confirmation: clear confirmed answer and mark the question EDITED.
  async unconfirmSingleChoice(questionId) {
    const { error: optErr } = await supabase
      .from('draft_options')
      .update({ is_confirmed_correct: false })
      .eq('draft_question_id', questionId)
    if (optErr) throw optErr
    const { error } = await supabase
      .from('draft_questions')
      .update({ teacher_review_status: 'EDITED', confirmed_by: null, confirmed_at: null })
      .eq('id', questionId)
    if (error) throw error
  },
}
