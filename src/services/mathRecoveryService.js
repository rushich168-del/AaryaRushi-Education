import { supabase } from '../lib/supabaseClient.js'

// B4.8.3C — Math Recovery (migration 0032): data access.
// Reads are plain selects (RLS: the owning teacher only). The ONLY write is ksc_resolve_math_image, which
// validates the maths, checks each placement against the stored evidence and the current text, writes
// atomically, logs every outcome and never touches answers or Telugu text.

async function all(query) {
  const { data, error } = await query
  if (error) throw error
  return data || []
}
const missing = e => e && (e.code === '42P01' || e.code === 'PGRST205' || e.code === 'PGRST202' || e.code === '42883'
  || /draft_math_image_(resolutions|placement_log)|ksc_resolve_math_image/.test(String(e.message)))

export const mathRecoveryService = {
  // { available, resolutions, log } — available=false when 0032 is not applied (the tab then explains why).
  async load(draftPaperId) {
    try {
      const [resolutions, log] = await Promise.all([
        all(supabase.from('draft_math_image_resolutions').select('*').eq('draft_paper_id', draftPaperId).order('revision', { ascending: true })),
        all(supabase.from('draft_math_image_placement_log').select('*').eq('draft_paper_id', draftPaperId).order('id', { ascending: true })),
      ])
      return { available: true, resolutions, log }
    } catch (e) {
      if (missing(e)) return { available: false, resolutions: [], log: [] }
      throw e
    }
  },

  // placements: [{ question_id, key, expected }] — exactly the placements and texts the teacher saw.
  async resolve({ draftPaperId, fingerprint, input, representation, placements, note = null }) {
    const { data, error } = await supabase.rpc('ksc_resolve_math_image', {
      p_draft_paper_id: draftPaperId, p_fingerprint: fingerprint, p_input: input, p_representation: representation,
      p_placements: placements, p_note: note,
    })
    if (error) throw error
    return data
  },
}

const MESSAGES = {
  KSC_MATH_REPRESENTATION_INVALID: 'That maths cannot be stored. Use numbers, fractions (8/11), roots (sqrt(3)) and powers (10^11).',
  KSC_PLACEMENT_NOT_OF_FINGERPRINT: 'The paper changed since this page was opened. Reload and try again.',
  KSC_PAPER_NOT_PREPARED: 'This paper is not prepared, so its maths images cannot be recovered yet.',
  KSC_ANSWER_INVARIANT_VIOLATED: 'Nothing was saved: the change would have affected an answer.',
}
export function mathRecoveryErrorMessage(e) {
  const m = String(e?.message || '')
  for (const [code, text] of Object.entries(MESSAGES)) if (m.includes(code)) return text
  if (/not found or unauthorized|Teacher access required/.test(m)) return 'Only the teacher who owns this paper can recover its maths.'
  return 'The maths could not be saved. Check your connection and try again.'
}

// Teacher-facing words for each placement outcome returned by ksc_resolve_math_image.
export const OUTCOME_WORDS = {
  APPLIED: 'placed',
  ALREADY_APPLIED: 'already placed',
  TELUGU_REVIEW: 'Telugu text: type it in the Telugu review',
  ALREADY_HANDED_TO_TELUGU_REVIEW: 'Telugu text: type it in the Telugu review',
  CONFLICT: 'not changed',
  REFUSED: 'not changed',
}
export const REASON_WORDS = {
  STALE_VIEW: 'the text changed after this page loaded',
  EDITED_SINCE_RECOVERY: 'someone edited it after the maths was placed',
  SEVERAL_VALUES_IN_FIELD: 'this text holds several maths values; correct it by hand',
  ANCHOR_NOT_FOUND: 'the text around the image is no longer as printed',
  ANCHOR_AMBIGUOUS: 'the text around the image appears twice',
  OWNER_TEXT_MISSING: 'the text around the image is missing',
  OWNER_NOT_FOUND: 'the option could not be found',
  NO_ANCHOR: 'the position of the image in the text is unknown',
}
