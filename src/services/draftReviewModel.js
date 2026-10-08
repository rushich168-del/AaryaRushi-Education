// B4.6 — Teacher Preparation & Exception Review Center: pure view model (no I/O).
//
// Everything here is DERIVED from persisted review state (draft_review_items, the derived
// draft_question_readiness view, language rows, media, materials). Nothing is stored, guessed or
// "fixed" here. Wording rule: high-confidence OCR is never called verified or correct — only a
// teacher decision is a verification.

export const TELUGU_ROW_TYPES = new Set(['TELUGU_STEM', 'TELUGU_OPTION', 'TELUGU_VERIFY'])
export const TELUGU_RPC_TYPES = new Set(['TELUGU_STEM', 'TELUGU_OPTION', 'TELUGU_VERIFY', 'MATERIAL_TELUGU'])
// Item types whose underlying defect must be FIXED before they can close; never "accepted as is".
export const MUST_FIX_TYPES = new Set(['ANSWER_KEY', 'OPTION_EMPTY'])
const VERIFY_TYPES = new Set(['QUESTION_VISUAL_VERIFY', 'MATERIAL_VISUAL_VERIFY'])

export const isOpen = item => item.status === 'OPEN' || item.status === 'DEFERRED'

// Same grouping as the B4.5 metrics (scripts/b45-review-metrics.mjs).
export function itemCategory(item) {
  if (item.draft_material_id) return 'sharedMaterial'
  if (['TELUGU_STEM', 'TELUGU_OPTION', 'TELUGU_STRUCTURE_AMBIGUOUS', 'TELUGU_VERIFY'].includes(item.item_type)) return 'telugu'
  if (/VISUAL/.test(item.item_type)) return 'visual'
  if (item.item_type === 'ANSWER_KEY') return 'answerKey'
  return 'optionStructure'
}

export const FILTERS = [
  { key: 'blocking', label: 'All blocking', test: i => isOpen(i) && i.blocking },
  { key: 'quick', label: 'Quick Check', test: i => isOpen(i) && i.blocking && i.route === 'QUICK_CHECK' },
  { key: 'manual', label: 'Manual Review', test: i => isOpen(i) && i.blocking && i.route === 'MANUAL_REVIEW' },
  { key: 'telugu', label: 'Telugu', test: i => isOpen(i) && i.blocking && itemCategory(i) === 'telugu' },
  { key: 'optionStructure', label: 'Options / Structure', test: i => isOpen(i) && i.blocking && itemCategory(i) === 'optionStructure' },
  { key: 'answerKey', label: 'Answer Key', test: i => isOpen(i) && i.blocking && itemCategory(i) === 'answerKey' },
  { key: 'visual', label: 'Visual', test: i => isOpen(i) && i.blocking && itemCategory(i) === 'visual' },
  { key: 'sharedMaterial', label: 'Shared Material', test: i => isOpen(i) && i.blocking && itemCategory(i) === 'sharedMaterial' },
  { key: 'optional', label: 'Optional Verification', test: i => isOpen(i) && !i.blocking },
  { key: 'resolved', label: 'Resolved', test: i => i.status === 'RESOLVED' },
]

// ---- data indexing -----------------------------------------------------------------------------
// data: { paper, importRecord, questions, options, questionTexts, optionTexts, media, materials,
//         materialTexts, items, readiness }  (flat rows as returned by the service)
export function indexDraft(data) {
  const byId = rows => new Map((rows || []).map(r => [r.id, r]))
  const questions = [...(data.questions || [])].sort((a, b) => a.position - b.position)
  const optionsByQuestion = new Map(questions.map(q => [q.id, []]))
  for (const o of data.options || []) optionsByQuestion.get(o.draft_question_id)?.push(o)
  for (const list of optionsByQuestion.values()) list.sort((a, b) => a.position - b.position)
  const te = rows => (rows || []).filter(t => t.language === 'te')
  const questionText = new Map(te(data.questionTexts).map(t => [t.draft_question_id, t]))
  const optionText = new Map(te(data.optionTexts).map(t => [t.draft_option_id, t]))
  const mediaByQuestion = new Map(), mediaByMaterial = new Map()
  for (const m of data.media || []) {
    const [map, key] = m.draft_question_id ? [mediaByQuestion, m.draft_question_id] : m.draft_material_id ? [mediaByMaterial, m.draft_material_id] : [null]
    if (!map) continue
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(m)
  }
  const materials = [...(data.materials || [])].sort((a, b) => a.position - b.position)
  const questionsByMaterial = new Map(materials.map(m => [m.id, []]))
  for (const q of questions) if (q.shared_material_id) questionsByMaterial.get(q.shared_material_id)?.push(q)
  const optionById = byId(data.options)
  return {
    ...data, questions, materials, optionsByQuestion, questionText, optionText, mediaByQuestion, mediaByMaterial, questionsByMaterial,
    questionById: byId(questions), optionById, mediaById: byId(data.media), materialById: byId(materials),
    materialText: new Map(te(data.materialTexts).map(t => [t.draft_material_id, t])),
    questionTextById: byId(data.questionTexts), optionTextById: byId(data.optionTexts),
    readinessByQuestion: new Map((data.readiness || []).map(r => [r.draft_question_id, r])),
    materialLabel: new Map(materials.map((m, i) => [m.id, `M${i + 1}`])),
  }
}

// ---- item context ------------------------------------------------------------------------------
export function itemQuestion(ix, item) {
  if (item.draft_question_id) return ix.questionById.get(item.draft_question_id) || null
  if (item.draft_option_id) return ix.questionById.get(ix.optionById.get(item.draft_option_id)?.draft_question_id) || null
  return null
}
export function itemOption(ix, item) { return item.draft_option_id ? ix.optionById.get(item.draft_option_id) || null : null }
export function itemTextRow(ix, item) {
  if (item.target_question_text_id) return { owner: 'QUESTION', row: ix.questionTextById.get(item.target_question_text_id) || null }
  if (item.target_option_text_id) return { owner: 'OPTION', row: ix.optionTextById.get(item.target_option_text_id) || null }
  return null
}
export const numberRange = qs => {
  const ns = qs.map(q => Number(q.source_question_number)).filter(Number.isFinite).sort((a, b) => a - b)
  if (!ns.length) return ''
  return ns.every((n, i) => i === 0 || n === ns[i - 1] + 1) && ns.length > 2 ? `Q${ns[0]}–Q${ns[ns.length - 1]}` : ns.map(n => `Q${n}`).join(', ')
}

export function itemLabel(ix, item) {
  if (item.draft_material_id) {
    const qs = ix.questionsByMaterial.get(item.draft_material_id) || []
    return `Shared material ${ix.materialLabel.get(item.draft_material_id) || ''} · ${numberRange(qs) || 'no linked questions'}`
  }
  const q = itemQuestion(ix, item)
  const o = itemOption(ix, item)
  const n = q ? `Q${q.source_question_number}` : 'Question'
  if (o) return `${n} · Option ${o.marker}`
  if (TELUGU_ROW_TYPES.has(item.item_type) || item.item_type === 'TELUGU_STRUCTURE_AMBIGUOUS') return `${n} · Telugu stem`
  return n
}

export const ITEM_TITLES = {
  TELUGU_STEM: 'Telugu stem needs a check', TELUGU_OPTION: 'Telugu option needs a check', TELUGU_VERIFY: 'Optional: confirm high-confidence OCR',
  TELUGU_STRUCTURE_AMBIGUOUS: 'Telugu block could not be split into stem and options', MATERIAL_TELUGU: 'Shared material Telugu needs transcription',
  MATERIAL_VISUAL_MISSING: 'Shared material figure missing', MATERIAL_VISUAL_VERIFY: 'Optional: confirm shared material figure',
  MATERIAL_RANGE_UNLINKED: 'Shared material is not linked to questions', QUESTION_VISUAL_MISSING: 'Figure expected but not captured',
  QUESTION_VISUAL_VERIFY: 'Optional: confirm automatic figure', OPTION_SET_ABNORMAL: 'Option set is abnormal', OPTION_EMPTY: 'Option text is missing',
  ANSWER_KEY: 'Answer key does not match the options', UNASSIGNED_TEXT: 'Text after the options belongs to nothing',
  ENGLISH_STEM_MISSING: 'English question text is missing or short', STRUCTURE: 'Structure needs a check',
}
// B4.8.4B: an optional check routed by OCR + decoder agreement reads differently from high-confidence OCR.
export function itemTitle(item) {
  if (item?.item_type === 'TELUGU_VERIFY' && (item.machine_reasons || []).includes('OCR_DECODER_AGREE')) return 'Optional: confirm Telugu (OCR and PDF glyph reading agree)'
  return ITEM_TITLES[item?.item_type] || item?.item_type
}

const REASONS = {
  OCR_HIGH_CONFIDENCE_UNVERIFIED: 'High-confidence OCR — not yet checked by a teacher (confidence is not correctness)',
  HIGH: 'High OCR confidence', MEDIUM: 'Medium OCR confidence', LOW: 'Low OCR confidence — not stored as text',
  DIGIT_MISMATCH: 'Numbers differ from the English version — not stored as text', EMPTY: 'OCR read nothing',
  NOT_TELUGU: 'OCR output is not Telugu', MISSING: 'No usable OCR', EMPTY_RUN: 'Part of the region read nothing',
  UNBALANCED_BRACKET: 'Unbalanced bracket (often a misread letter part)',
  GLYPH_ALIGNMENT_AMBIGUOUS: 'Numbers/punctuation from the PDF could not be aligned; OCR kept as read',
  STRUCTURE_AMBIGUOUS: 'Telugu stem and options could not be separated', TELUGU_TEXT_AFTER_OPTIONS: 'Telugu text found after the options',
  TELUGU_STEM_NOT_FOUND: 'Telugu stem not found', TELUGU_MATERIAL_TEXT_NOT_EXTRACTED: 'Shared material Telugu is only an image (no OCR)',
  AUTO_FIGURE_UNVERIFIED: 'Automatic figure crop — not yet checked by a teacher', EMPTY_OPTION_TEXT: 'Option has no text',
  KEY_POINTS_AT_EMPTY_OPTION: 'The answer key points at an option with no text', KEY_LETTER_HAS_NO_OPTION: 'The answer-key letter has no matching option',
  NO_ANSWER_KEY_ENTRY: 'No answer-key entry for this question', UNASSIGNED_TEXT_AFTER_OPTIONS: 'Text after the options is not owned by any option',
  ENGLISH_STEM_EMPTY: 'English stem is empty', ENGLISH_STEM_MISSING_OR_SHORT: 'English stem is missing or very short',
  FEWER_THAN_4_OPTIONS: 'Fewer than four options', MORE_THAN_4_OPTIONS: 'More than four options', DUPLICATE_OPTION_MARKERS: 'Duplicate option markers',
  VISUAL_EXPECTED_BUT_NONE_FOUND: 'Wording or layout suggests a figure, but none was captured',
  TELUGU_OPTIONS_NOT_IN_SOURCE: 'The paper prints no Telugu options',
  // B4.8.2 / B4.8.3B (display text only)
  DUPLICATE_OPTION_TEXT: 'Two options have the same text (notation may have been lost)',
  OCR_SUSPECT_CHARACTERS: 'OCR produced characters that cannot be right here (e.g. Telugu numerals, £)',
  NOTATION_IMAGE: 'The maths in this option is printed as an image — type it from the source',
  NOTATION_IMAGE_IN_STEM: 'Part of the question’s maths is printed as an image — the stored text is incomplete',
  NOTATION_NOT_IN_OCR: 'This Telugu text contains maths the OCR cannot read (an image or raised figure)',
  // B4.8.4B
  OCR_DECODER_AGREE: 'OCR and an independent reading of the PDF’s Telugu glyphs give exactly the same text (agreement is not proof)',
  OCR_DECODER_DISAGREE: 'OCR and the PDF’s glyph reading differ — the OCR text is kept; a suggestion is shown',
  INVALID_TELUGU_SEQUENCE: 'Not valid Telugu: a vowel letter is followed by a vowel sign (usually one misread letter)',
  OCR_CONFIDENCE_MEDIUM: 'OCR confidence was medium', OCR_CONFIDENCE_LOW: 'OCR confidence was low',
  // B4.8.4C
  TELUGU_MATERIAL_OCR_PROPOSAL: 'The passage Telugu was read by OCR: check it once against the source (a proposal, not verified)',
}
export function reasonText(code) {
  const c = String(code)
  if (REASONS[c]) return REASONS[c]
  let m = /^TELUGU_MARKERS_MISMATCH\((.*) vs (.*)\)$/.exec(c)
  if (m) return `Telugu option markers (${m[1]}) differ from English (${m[2]})`
  m = /^B4\.3_CANDIDATE_REJECTED\((.*)\)$/.exec(c)
  if (m) return `A figure candidate was rejected (${m[1].replace(/_/g, ' ').toLowerCase()})`
  m = /^OPTION_COUNT_(\d+)$/.exec(c)
  if (m) return `${m[1]} options found`
  m = /^ENGLISH_OPTIONS_(\d+)$/.exec(c)
  if (m) return `English has ${m[1]} options`
  m = /^NOTATION_IMAGE_IN_OPTIONS\((.*)\)$/.exec(c)
  if (m) return `The maths in option ${m[1].replace(/,/g, ', ')} is printed as an image — the stored text is incomplete`
  m = /^NOTATION_TEXT_UNRESOLVED\((.*)\)$/.exec(c)
  if (m) return `Raised or stacked numbers could not be rebuilt safely (${m[1].replace(/,/g, ', ')})`
  m = /^NOTATION_PLACEHOLDER_UNRESOLVED\((.*)\)$/.exec(c)
  if (m) return `An equation left no text in the PDF (${m[1].replace(/,/g, ', ')})`
  return c.replace(/_/g, ' ').toLowerCase()
}

// State of a Telugu language row, in teacher words. HIGH OCR is never "verified".
export function teluguState(row) {
  if (!row) return { key: 'none', label: 'No Telugu row' }
  switch (row.verification_state) {
    case 'VERIFIED_OCR': return { key: 'verified', label: 'OCR verified by teacher' }
    case 'EDITED_FROM_OCR': return { key: 'corrected', label: 'Corrected by teacher (original OCR kept)' }
    case 'TEACHER_TRANSCRIBED': return { key: 'typed', label: 'Typed by teacher' }
    case 'MARKED_MISSING': return { key: 'missing-teacher', label: 'Marked missing by teacher' }
    default: break
  }
  if (row.text_quality === 'SCRIPT_NEUTRAL') return { key: 'neutral', label: 'Same as English (digits/symbols)' }
  if (row.text_quality === 'TEACHER_ENTERED') return { key: 'typed', label: 'Entered by teacher' }
  if (row.text_quality === 'OCR_EXTRACTED') {
    return row.ocr_verdict === 'HIGH' ? { key: 'ocr-high', label: 'High-confidence OCR · not yet verified' } : { key: 'ocr', label: 'OCR text · not yet verified' }
  }
  return { key: 'missing', label: 'No usable Telugu text' }
}

// What the teacher is looking at for a Telugu item: stored text or the unstored OCR attempt.
export function teluguContent(ix, item) {
  const target = itemTextRow(ix, item)
  const crop = item.source_media_id ? ix.mediaById.get(item.source_media_id) : null
  const detail = crop?.detection_detail || {}
  const row = target?.row || null
  const stored = row?.text_quality === 'OCR_EXTRACTED' || row?.text_quality === 'TEACHER_ENTERED' ? row.content : null
  const attempt = !stored && /[ఀ-౿]/.test(detail.ocrText || '') ? detail.ocrText : null
  // B4.8.4B: the legacy decoder's differing reading — offered ONLY as a suggestion on an open item whose
  // row no teacher has decided yet, and only when it is real Telugu that differs from what is shown.
  const dec = detail.decoder
  const current = stored ?? attempt ?? ''
  const suggestion = dec?.agree === false && typeof dec.suggestion === 'string' && /[ఀ-౿]/.test(dec.suggestion) && !/[\uE000-\uF8FF\uFFFD]/.test(dec.suggestion)
    && !row?.verification_state && item.status !== 'RESOLVED' && dec.suggestion.trim() !== current.trim() ? dec.suggestion : null
  return { target, row, crop, stored, attempt, current, original: row?.ocr_original_content ?? null,
    suggestion, decoder: dec ? { name: dec.name ?? null, version: dec.version ?? null, status: dec.status ?? null, agree: dec.agree ?? null } : null,
    rawOcr: detail.ocrRawText && detail.ocrRawText !== detail.ocrText ? detail.ocrRawText : null,
    provenance: { engine: row?.ocr_engine || detail.ocrEngine || null, version: row?.ocr_version || detail.ocrVersion || null,
      confidence: row?.ocr_confidence != null ? Number(row.ocr_confidence) : item.confidence != null ? Number(item.confidence) : null, verdict: row?.ocr_verdict || detail.ocrVerdict || null } }
}

// Which decisions are offered. The server enforces the same rules; this only avoids offering
// something that would be refused. "accept" is ONLY ever a Telugu OCR acceptance.
export function allowedActions(ix, item) {
  const open = isOpen(item)
  if (TELUGU_ROW_TYPES.has(item.item_type)) {
    const c = teluguContent(ix, item)
    const acceptable = c.row && ((c.row.text_quality === 'OCR_EXTRACTED' && c.stored) || (c.row.text_quality === 'MISSING' && c.attempt))
    return { kind: 'telugu', accept: open && !!acceptable, edit: true, markMissing: true, defer: item.status === 'OPEN', revise: !open && !!c.row }
  }
  if (item.item_type === 'MATERIAL_TELUGU') return { kind: 'material-telugu', accept: false, edit: open, markMissing: open, defer: item.status === 'OPEN' }
  return {
    kind: VERIFY_TYPES.has(item.item_type) ? 'verify' : 'manual',
    accept: false,
    resolve: open,                                        // "the defect was fixed" — the server re-checks it
    acceptAsIs: open && !MUST_FIX_TYPES.has(item.item_type) && !VERIFY_TYPES.has(item.item_type),
    defer: item.status === 'OPEN',
    typeOption: open && item.item_type === 'OPTION_EMPTY',
    typeTeluguStem: open && item.item_type === 'TELUGU_STRUCTURE_AMBIGUOUS' && !!item.target_question_text_id,
  }
}

// ---- queue -------------------------------------------------------------------------------------
const TYPE_ORDER = ['TELUGU_STRUCTURE_AMBIGUOUS', 'TELUGU_STEM', 'TELUGU_OPTION', 'TELUGU_VERIFY', 'ENGLISH_STEM_MISSING', 'STRUCTURE', 'UNASSIGNED_TEXT',
  'OPTION_SET_ABNORMAL', 'OPTION_EMPTY', 'ANSWER_KEY', 'QUESTION_VISUAL_MISSING', 'QUESTION_VISUAL_VERIFY',
  'MATERIAL_TELUGU', 'MATERIAL_VISUAL_MISSING', 'MATERIAL_RANGE_UNLINKED', 'MATERIAL_VISUAL_VERIFY']
function sortKey(ix, item) {
  const q = itemQuestion(ix, item) || (item.draft_material_id ? (ix.questionsByMaterial.get(item.draft_material_id) || [])[0] : null)
  const pos = q ? q.position : item.draft_material_id ? -1 : 1e6
  const o = itemOption(ix, item)
  return [item.status === 'DEFERRED' ? 1 : 0, pos, item.draft_material_id ? 0 : 1, o ? o.position + 1 : 0, TYPE_ORDER.indexOf(item.item_type), item.item_key]
}
const cmp = (a, b) => { for (let i = 0; i < a.length; i++) { if (a[i] < b[i]) return -1; if (a[i] > b[i]) return 1 } return 0 }

export function buildQueue(ix, filterKey) {
  const f = FILTERS.find(x => x.key === filterKey) || FILTERS[0]
  return (ix.items || []).filter(f.test).map(item => ({ item, key: sortKey(ix, item) })).sort((a, b) => cmp(a.key, b.key)).map(x => x.item)
}
export function filterCounts(ix) {
  return Object.fromEntries(FILTERS.map(f => [f.key, (ix.items || []).filter(f.test).length]))
}

// After a decision the queue changes; continue with the item that followed the decided one.
export function nextAfter(prevQueue, newQueue, decidedId) {
  const at = prevQueue.findIndex(i => i.id === decidedId)
  if (at < 0) return newQueue[0]?.id ?? null
  const ids = new Set(newQueue.map(i => i.id))
  for (const i of prevQueue.slice(at + 1)) if (ids.has(i.id) && i.id !== decidedId) return i.id
  const still = newQueue.find(i => i.id !== decidedId)
  return still ? still.id : null
}

// ---- summary and progress ------------------------------------------------------------------------
export function summarize(ix) {
  const items = ix.items || []
  const readiness = [...ix.readinessByQuestion.values()]
  const tally = k => readiness.filter(r => r.readiness === k).length
  const blocking = items.filter(i => i.blocking), optional = items.filter(i => !i.blocking)
  const readyIds = new Set(readiness.filter(r => r.readiness === 'READY').map(r => r.draft_question_id))
  return {
    totalQuestions: ix.questions.length,
    noBlocking: tally('READY'), quickCheck: tally('QUICK_CHECK'), manualReview: tally('MANUAL_REVIEW'),
    blockingTotal: blocking.length, blockingResolved: blocking.filter(i => i.status === 'RESOLVED').length,
    blockingOpen: blocking.filter(isOpen).length, blockingDeferred: blocking.filter(i => i.status === 'DEFERRED').length,
    optionalTotal: optional.length, optionalResolved: optional.filter(i => i.status === 'RESOLVED').length, optionalOpen: optional.filter(isOpen).length,
    readyWithOptionalOutstanding: readiness.filter(r => readyIds.has(r.draft_question_id) && Number(r.open_advisory) > 0).length,
    draftReady: blocking.length > 0 ? blocking.every(i => i.status === 'RESOLVED') : readiness.every(r => r.readiness === 'READY'),
  }
}

// "tesseract.js 7.0.0 · tessdata/tel.traineddata (integer) · glyph hybrid 1.0.0"
export function provenanceText({ engine, version } = {}) {
  if (!engine && !version) return null
  const parts = String(version || '').split('+')
  const out = [engine && parts[0] ? `${engine} ${parts[0]}` : engine]
  if (parts[1]) out.push(parts[1].replace(/@[0-9a-f]{12}$/, ''))
  const hyb = parts.find(p => p.startsWith('ksc-glyph-hybrid@'))
  if (hyb) out.push(`glyph hybrid ${hyb.split('@')[1]}`)
  return out.filter(Boolean).join(' · ')
}

// Teacher-facing text for review RPC errors (never raw database wording).
export function reviewErrorMessage(err) {
  const t = [err?.message, err?.details, err?.hint].filter(Boolean).join(' ')
  const map = [
    ['KSC_STALE_VIEW', 'The Telugu changed since this page was loaded (perhaps in another tab). The page has been refreshed; look again.'],
    ['KSC_STALE_STATE', 'Part of this was already decided differently (perhaps in another tab). The page has been refreshed.'],
    ['KSC_ITEM_NOT_ELIGIBLE', 'One of these units has a specific problem, so it cannot be verified together with the others. Decide it on its own.'],
    ['KSC_OCCURRENCE_NOT_OF_FINGERPRINT', 'These places are not the same printed text, so one decision cannot cover them.'],
    ['KSC_NO_PASSAGE_OCR', 'This passage has no OCR reading. Type it from the source instead.'],
    ['KSC_NOTHING_TO_ACCEPT', 'There is no usable OCR text to accept. Edit it or mark it missing.'],
    ['KSC_TELUGU_TEXT_INVALID', 'Type the Telugu text. Empty text or the PDF\'s legacy font characters cannot be saved.'],
    ['KSC_ANSWER_ISSUE_MUST_BE_FIXED', 'Answer-key problems cannot be accepted as they are. Fix the options first.'],
    ['KSC_ANSWER_ISSUE_STILL_PRESENT', 'The answer-key problem is still there: the proposed answer must point at exactly one option with text.'],
    ['KSC_EMPTY_OPTION_MUST_BE_FIXED', 'An empty option cannot be accepted as it is. Type the option from the source first.'],
    ['KSC_EMPTY_OPTION_STILL_PRESENT', 'This option is still empty. Type it from the source first.'],
    ['KSC_NOTE_REQUIRED', 'Add a short note explaining why this is acceptable as it is.'],
    ['KSC_REVIEW_ITEM_ALREADY_RESOLVED', 'This item was already resolved (perhaps in another tab). The list has been refreshed.'],
    ['KSC_SCRIPT_NEUTRAL_NOT_REVISABLE', 'This option is digits/symbols only; it is the same in both languages.'],
    ['KSC_LANGUAGE_HISTORY_PROTECTED', 'OCR history is protected and cannot be deleted.'],
    ['KSC_REVIEW_ITEM_TARGET_MISSING', 'The Telugu row for this item is missing. Reload the page.'],
    ['not found or unauthorized', 'This item is not available to your account.'],
    ['Teacher access required', 'Teacher access is required.'],
  ]
  for (const [k, v] of map) if (t.includes(k)) return v
  return 'The decision could not be saved. Your previous state is unchanged; try again.'
}
