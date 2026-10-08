// Pure, dependency-free mapping from the legacy in-memory analysis
// { materials[], candidates[] } into the durable Draft Paper RPC payload.
// No Supabase import here so it can be unit-tested in Node directly.
// Incomplete / uncertain extraction is preserved honestly; no answer or
// content is ever invented.

export function draftUuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

export function normalizeMaterialType(t) {
  const allowed = ['PASSAGE', 'IMAGE', 'DIAGRAM', 'TABLE', 'CHART', 'INSTRUCTIONS', 'OTHER']
  return allowed.includes(t) ? t : 'OTHER'
}

export function normalizeExtractionStatus(s) {
  if (s === 'READY') return 'READY'
  if (s === 'FAILED') return 'FAILED'
  if (s === 'UNRESOLVED') return 'UNRESOLVED'
  return 'NEEDS_REVIEW'
}

// Number of option slots the current P0-A SINGLE_CHOICE edit card shows.
export const DRAFT_OPTION_SLOTS = 4

// Index existing option rows by slot position (first row wins per position).
export function optionRowsBySlot(rows = [], slotCount = DRAFT_OPTION_SLOTS) {
  const slots = Array(slotCount).fill(null)
  for (const row of rows) {
    const p = row?.position
    if (Number.isInteger(p) && p >= 0 && p < slotCount && !slots[p]) slots[p] = row
  }
  return slots
}

// Slot conflicts: positions holding MORE than one option row. They are never resolved
// implicitly (no "first row wins"); the teacher must resolve them explicitly.
export function detectOptionConflicts(rows = []) {
  const byPosition = new Map()
  for (const row of rows) {
    if (!Number.isInteger(row?.position)) continue
    if (!byPosition.has(row.position)) byPosition.set(row.position, [])
    byPosition.get(row.position).push(row)
  }
  return [...byPosition.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([position, group]) => ({ position, rows: group.slice().sort(compareDraftOptions) }))
    .sort((a, b) => a.position - b.position)
}

// Option to confirm when the teacher clicks Confirm: the confirmed row, else the
// proposed row, looked up by SLOT (not by array index). Null if unknown or if the
// question has slot conflicts (confirmation is blocked until they are resolved).
export function confirmTargetOptionId(rows = []) {
  if (detectOptionConflicts(rows).length) return null
  const slots = optionRowsBySlot(rows)
  const row = slots.find(r => r?.is_confirmed_correct) || slots.find(r => r?.is_proposed_correct)
  return row ? row.id : null
}

// Pure plan for saving the four-slot edit card.
//  - existing row + changed text  -> update
//  - no row + nonblank text        -> insert at that position
//  - no row + blank text           -> nothing (no empty rows)
// An answer is confirmed ONLY when the teacher explicitly chose one during this
// edit (answerChosen). A parser-proposed answer never implies confirmation.
export function planDraftEdit({ rows = [], formOptions = [], selectedSlot = null, answerChosen = false, slotCount = DRAFT_OPTION_SLOTS }) {
  const slots = optionRowsBySlot(rows, slotCount)
  const updates = []
  const inserts = []
  // Existing options whose text the teacher cleared. Blank text is never treated as
  // an implicit delete (nor silently kept): Save is refused and the teacher is told
  // to use the explicit Remove option action.
  const blankedExisting = []

  for (let i = 0; i < slotCount; i++) {
    const text = typeof formOptions[i] === 'string' ? formOptions[i] : ''
    const row = slots[i]
    if (row) {
      if (text.trim() === '' && (row.content ?? '').trim() !== '') blankedExisting.push(i)
      else if (text !== (row.content ?? '')) updates.push({ id: row.id, position: i, content: text })
    } else if (text.trim() !== '') {
      inserts.push({ position: i, content: text })
    }
  }

  let confirmSlot = null
  let confirmBlocked = false
  if (answerChosen && Number.isInteger(selectedSlot) && selectedSlot >= 0 && selectedSlot < slotCount) {
    const resolvable = slots[selectedSlot] || inserts.some(ins => ins.position === selectedSlot)
    if (resolvable) confirmSlot = selectedSlot
    else confirmBlocked = true // chosen slot has no option text to confirm
  }

  const conflicts = detectOptionConflicts(rows).map(c => c.position)
  return { updates, inserts, confirmSlot, confirmBlocked, blankedExisting, conflicts }
}

// Deterministic option order: position, then creation time, then id. Without the
// tie-breaks, rows sharing a position come back in database order, which changes
// after an UPDATE and made a cleared duplicate look like it "came back".
export function compareDraftOptions(a, b) {
  return ((a.position || 0) - (b.position || 0))
    || String(a.created_at || '').localeCompare(String(b.created_at || ''))
    || String(a.id || '').localeCompare(String(b.id || ''))
}

// Resolve a slot to an option id using existing rows plus newly inserted rows
// (each inserted result must carry { id, position }).
export function resolveSlotOptionId(slot, rows = [], insertedRows = [], slotCount = DRAFT_OPTION_SLOTS) {
  if (!Number.isInteger(slot)) return null
  const existing = optionRowsBySlot(rows, slotCount)[slot]
  if (existing) return existing.id
  const inserted = insertedRows.find(r => r?.position === slot)
  return inserted ? inserted.id : null
}

// ---- P0-B3: bilingual Draft language versions ----------------------------

export const DRAFT_LANGUAGES = ['en', 'te']
export const TEXT_QUALITIES = ['VALID_UNICODE', 'UNRELIABLE', 'TEACHER_ENTERED', 'SCRIPT_NEUTRAL', 'MISSING']

// Legacy (non-Unicode) Indic text detection, from code-point evidence only.
// The probe on the real SI paper proved this PDF reports generic "serif"/"sans-serif"
// families, so font NAMES cannot be used. Two proven signatures:
//   - private-use characters (U+E000-U+F8FF), e.g. the U+F0xx body Telugu;
//   - a dense run of Latin-1/symbol characters, e.g. the ANSI-mapped page-1 header.
// Genuine Telugu Unicode is never reported as legacy.
const PRIVATE_USE = /[-]/
const TELUGU_UNICODE = /[ఀ-౿]/
const SYMBOLISH = /[ -˿ -➿]/g
const MIN_SYMBOL_RUN = 6
const MIN_SYMBOL_RATIO = 0.15

export function classifyExtractedText(text = '') {
  const str = String(text)
  if (!str.trim()) return { legacyUnreliable: false, reason: 'EMPTY' }
  if (TELUGU_UNICODE.test(str)) return { legacyUnreliable: false, reason: 'TELUGU_UNICODE' }
  if (PRIVATE_USE.test(str)) return { legacyUnreliable: true, reason: 'PRIVATE_USE_GLYPHS' }
  const symbols = (str.match(SYMBOLISH) || []).length
  if (symbols >= MIN_SYMBOL_RUN && symbols / str.length >= MIN_SYMBOL_RATIO) {
    return { legacyUnreliable: true, reason: 'ANSI_MAPPED_GLYPHS' }
  }
  return { legacyUnreliable: false, reason: 'PLAIN_TEXT' }
}

export const isLegacyUnreliableText = text => classifyExtractedText(text).legacyUnreliable

// Characters no font can render: the source PDF's legacy glyphs (private use) and
// replacement characters. Text copied out of this paper's Telugu arrives like this and
// shows as empty boxes. It is never stored as Telugu content.
export function containsUnreadableGlyphs(text = '') {
  return /[-�]/.test(String(text))
}

export const hasTeluguUnicode = (text = '') => /[ఀ-౿]/.test(String(text))

// Validates text a teacher typed/pasted as a Telugu version.
//   ok:false  -> refuse to save (unreadable legacy glyphs)
//   warn:true -> savable, but no Telugu characters present (teacher confirms)
export function validateTeluguInput(text = '') {
  const str = String(text)
  if (!str.trim()) return { ok: true, warn: false, reason: 'EMPTY' }
  if (containsUnreadableGlyphs(str)) {
    return {
      ok: false, warn: false, reason: 'UNREADABLE_GLYPHS',
      message: 'This text is made of the PDF\'s legacy font glyphs, not Telugu characters, so it shows as boxes. Copying Telugu out of this PDF cannot work — please type the Telugu instead.',
    }
  }
  if (!hasTeluguUnicode(str)) return { ok: true, warn: true, reason: 'NO_TELUGU_CHARACTERS' }
  return { ok: true, warn: false, reason: 'TELUGU_UNICODE' }
}

// Script-neutral may only be claimed when the option's own content really is
// script-neutral (digits/symbols). Words like "None" never qualify, whatever is asked.
export function canMarkScriptNeutral(primaryContent = '') {
  return isScriptNeutralText(primaryContent)
}

// Content that reads the same in every language (digits, punctuation, symbols),
// e.g. Q6's "15" / "19" / "22" / "24" — no translation is needed.
export function isScriptNeutralText(text = '') {
  const str = String(text).trim()
  return str.length > 0 && /^[\s\d\p{P}\p{S}]+$/u.test(str)
}

// Language versions of one logical question and of its logical options.
// Never creates options: a Telugu option is a child text of the SAME draft_option.
export function groupLanguageTexts(question) {
  const questionTexts = {}
  for (const t of question?.draft_question_texts || []) questionTexts[t.language] = t
  const optionTexts = {}
  for (const o of question?.draft_options || []) {
    optionTexts[o.id] = {}
    for (const t of o.draft_option_texts || []) optionTexts[o.id][t.language] = t
  }
  return { questionTexts, optionTexts }
}

// ---- P0-B2: source-faithful Draft visuals --------------------------------

// Render/capture scale for stored crops (locked product decision: 2x).
export const DRAFT_MEDIA_RENDER_SCALE = 2
// Smallest accepted region, as a fraction of page width and of page height.
export const MIN_REGION_FRACTION = 0.01
// Kinds offered in the B2 capture UI. TEXT_REGION is allowed by the database for
// B3 (unreliable Telugu source regions) but is intentionally not offered in B2.
export const DRAFT_MEDIA_KINDS = ['DIAGRAM', 'FIGURE', 'IMAGE', 'TABLE', 'CHART', 'MAP', 'OTHER']

const round6 = n => Math.round(n * 1e6) / 1e6
const clamp01 = n => Math.min(1, Math.max(0, n))

// Region contract: a drag between two canvas points (any direction, possibly
// beyond the page edge) becomes { x, y, w, h } normalized to the source page,
// top-left origin, each in 0..1. Points outside the page are CLAMPED to it.
export function normalizeRegion(drag, canvas) {
  if (!drag || !canvas?.width || !canvas?.height) return null
  const xs = [drag.x0, drag.x1].map(v => clamp01(v / canvas.width))
  const ys = [drag.y0, drag.y1].map(v => clamp01(v / canvas.height))
  const x = Math.min(...xs), y = Math.min(...ys)
  return { x: round6(x), y: round6(y), w: round6(Math.max(...xs) - x), h: round6(Math.max(...ys) - y) }
}

// Usable = inside the page and at least MIN_REGION_FRACTION on both axes.
export function isUsableRegion(r) {
  if (!r || ![r.x, r.y, r.w, r.h].every(Number.isFinite)) return false
  if (r.x < 0 || r.y < 0 || r.x + r.w > 1 + 1e-9 || r.y + r.h > 1 + 1e-9) return false
  return r.w >= MIN_REGION_FRACTION && r.h >= MIN_REGION_FRACTION
}

// Normalized region -> integer pixel rectangle on a canvas of the given size.
export function regionToPixels(r, canvas) {
  const sx = Math.round(r.x * canvas.width), sy = Math.round(r.y * canvas.height)
  const sw = Math.max(1, Math.min(canvas.width - sx, Math.round(r.w * canvas.width)))
  const sh = Math.max(1, Math.min(canvas.height - sy, Math.round(r.h * canvas.height)))
  return { sx, sy, sw, sh }
}

// Stable private object path inside the existing teacher-owner prefix (0014 policy).
export function draftMediaPath(teacherId, draftPaperId, mediaId) {
  return `imports/${teacherId}/draft-media/${draftPaperId}/${mediaId}.png`
}

// Insert payload for draft_media. Stores the private path only — never a URL.
export function buildDraftMediaRecord({ id, teacherId, draftPaperId, owner, mediaKind, region, sourcePage,
  pageWidthPt, pageHeightPt, renderScale = DRAFT_MEDIA_RENDER_SCALE, widthPx, heightPx, sourceImportId }) {
  const owners = ['questionId', 'optionId', 'materialId'].filter(k => owner?.[k])
  if (owners.length !== 1) throw new Error('A visual must have exactly one owner.')
  if (!isUsableRegion(region)) throw new Error('Select a larger region inside the page.')
  return {
    id,
    draft_paper_id: draftPaperId,
    draft_question_id: owner.questionId ?? null,
    draft_option_id: owner.optionId ?? null,
    draft_material_id: owner.materialId ?? null,
    media_kind: mediaKind,
    capture_method: 'SOURCE_REGION',
    storage_path: draftMediaPath(teacherId, draftPaperId, id),
    mime_type: 'image/png',
    width_px: widthPx ?? null,
    height_px: heightPx ?? null,
    source_import_id: sourceImportId ?? null,
    source_page: sourcePage,
    region_x: region.x, region_y: region.y, region_w: region.w, region_h: region.h,
    page_width_pt: pageWidthPt,
    page_height_pt: pageHeightPt,
    render_scale: renderScale,
  }
}

const byPosition = (a, b) => (a.position || 0) - (b.position || 0)

// Question visuals come only from rows owned by the question itself; option
// visuals are attached per option. Visuals never touch answer flags.
export function groupDraftMedia(question) {
  const questionMedia = (question?.draft_media || []).filter(m => m.draft_question_id === question.id).sort(byPosition)
  const optionMedia = {}
  for (const o of question?.draft_options || []) {
    optionMedia[o.id] = (o.draft_media || []).filter(m => m.draft_option_id === o.id).sort(byPosition)
  }
  return { questionMedia, optionMedia }
}

// ---- P0-B1: teacher-added (manual) draft questions -----------------------

const asQuestionInt = n => {
  const s = typeof n === 'string' ? n.trim() : n
  return (typeof s === 'number' || (typeof s === 'string' && /^\d+$/.test(s))) ? Number(s) : null
}

// Suggest a question number for an insertion point.
//  - between two numbered questions with a real gap (9 -> 11): the next number ("10")
//  - between sequential numbers (9 -> 10) or unknown numbers: null (teacher decides)
//  - after the last question: previous + 1
// Never used to fabricate content; it only pre-fills the number field.
export function suggestMissingNumber(prevNumber, nextNumber) {
  const prev = asQuestionInt(prevNumber)
  const hasNext = nextNumber !== undefined && nextNumber !== null && nextNumber !== ''
  if (!hasNext) return prev !== null ? String(prev + 1) : null
  const next = asQuestionInt(nextNumber)
  if (prev === null || next === null) return null
  return next - prev >= 2 ? String(prev + 1) : null
}

// Honest provenance note for a teacher-added question. No source page is implied.
export function teacherAddedReference(prevNumber, nextNumber) {
  const has = v => v !== undefined && v !== null && String(v).trim() !== ''
  const base = 'Teacher added during preparation'
  if (has(prevNumber) && has(nextNumber)) return `${base} between Q${prevNumber} and Q${nextNumber}`
  if (has(prevNumber)) return `${base} after Q${prevNumber}`
  if (has(nextNumber)) return `${base} before Q${nextNumber}`
  return base
}

// Draft position for inserting after cards[afterIndex] (-1 = before the first card),
// where cards is the full list in position order.
export function manualInsertPosition(cards = [], afterIndex = -1) {
  if (afterIndex >= 0 && cards[afterIndex]) return (cards[afterIndex].position ?? afterIndex) + 1
  return cards[0]?.position ?? 0
}

export function buildDraftPayload(importRecord, analysis) {
  const { materials = [], candidates = [] } = analysis || {}

  const materialIdMap = new Map()
  const draftMaterials = materials.map(m => {
    const id = draftUuid()
    materialIdMap.set(m.id, id)
    return {
      id,
      material_type: normalizeMaterialType(m.material_type),
      content_text: m.content_text ?? null,
      language: m.language ?? null,
      media_ref: m.media_ref ?? null,
      source_page_start: m.source_page ?? null,
      source_page_end: m.source_page ?? null,
      warnings: Array.isArray(m.warnings) ? m.warnings : [],
    }
  })

  const draftQuestions = []
  const draftOptions = []
  candidates.forEach((c, idx) => {
    const qId = draftUuid()
    const opts = Array.isArray(c.options) ? c.options : []
    draftQuestions.push({
      id: qId,
      shared_material_id: c.material_id ? (materialIdMap.get(c.material_id) ?? null) : null,
      position: idx,
      source_question_number: c.question_number ?? null,
      response_type: 'SINGLE_CHOICE',
      content: c.question_text ?? null,
      language: c.language ?? null,
      source_page: c.source_page ?? null,
      source_reference: c.source_reference ?? null,
      extraction_status: normalizeExtractionStatus(c.status),
      warnings: Array.isArray(c.warnings) ? c.warnings : [],
    })
    opts.forEach((optText, oIdx) => {
      draftOptions.push({
        id: draftUuid(),
        draft_question_id: qId,
        position: oIdx,
        label: null,
        content: typeof optText === 'string' ? optText : (optText?.content ?? null),
        // Parser proposal only. Confirmed answer is never set by ingest.
        is_proposed_correct: Number.isInteger(c.proposed_correct_index) && c.proposed_correct_index === oIdx,
        warnings: [],
      })
    })
  })

  const paperMeta = {
    title: importRecord.test_name ?? importRecord.filename ?? null,
    exam_id: importRecord.exam_id ?? null,
    level_id: importRecord.level_id ?? null,
    subject_id: null,
    source_type: 'PDF',
    source_filename: importRecord.filename ?? null,
    source_page_count: analysis?.source_page_count ?? null,
    detected_language: analysis?.detected_language ?? null,
  }

  return { paperMeta, draftMaterials, draftQuestions, draftOptions }
}
