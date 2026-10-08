// B4.8.4C — question-level Telugu Review: pure view model (no I/O).
//
// The teacher reviews QUESTIONS, not OCR review-item rows. Everything here is derived from persisted review
// state (draft_review_items, language rows, crops and their preparation-time evidence). Nothing is stored,
// guessed or corrected here.
//
// Lanes (per question, over its OPEN Telugu items):
//   exception  at least one blocking unit has a substantive problem (disagreement, digits, invalid Telugu,
//              missing text or maths, structure). The problem is named in teacher words.
//   quick      the only blocking Telugu work is confidence verification ("Looks correct" / "Edit").
//   optional   nothing blocks; only optional checks remain (high-confidence OCR, OCR = glyph agreement).
// Shared passages (MATERIAL_TELUGU) are their own list: verified once for every linked question.
//
// Wording rule (as in draftReviewModel.js): confidence and agreement are never called verification.

import { isOpen, itemQuestion, itemOption, teluguContent, allowedActions, numberRange } from './draftReviewModel.js'

export const UNIT_TYPES = new Set(['TELUGU_STEM', 'TELUGU_OPTION', 'TELUGU_VERIFY', 'TELUGU_STRUCTURE_AMBIGUOUS'])
const CONFIDENCE_ONLY = new Set(['HIGH', 'MEDIUM', 'LOW', 'OCR_DECODER_AGREE', 'OCR_CONFIDENCE_MEDIUM', 'OCR_CONFIDENCE_LOW', 'OCR_HIGH_CONFIDENCE_UNVERIFIED'])
// Exactly the server's list (0033 ksc_telugu_reasons_confidence_only): only these may be verified together.
export const VERIFIABLE_REASONS = new Set(['MEDIUM', 'LOW', 'OCR_DECODER_AGREE', 'OCR_CONFIDENCE_MEDIUM', 'OCR_CONFIDENCE_LOW', 'OCR_HIGH_CONFIDENCE_UNVERIFIED'])
export const verifiableTogether = u => u.open && u.canKeep && !u.suggestion && ['TELUGU_STEM', 'TELUGU_OPTION', 'TELUGU_VERIFY'].includes(u.item.item_type)
  && (u.item.machine_reasons || []).length > 0 && (u.item.machine_reasons || []).every(r => VERIFIABLE_REASONS.has(String(r))) && !u.content.row?.verification_state

// Machine reason -> teacher-facing problem. Unknown reasons are exceptions too (shown by name, never hidden).
export const ISSUES = {
  DISAGREEMENT: { rank: 1, title: 'The OCR and the PDF’s own glyph reading give different text' },
  DIGITS: { rank: 2, title: 'Numbers differ from the English version' },
  DIGITS_UNCONFIRMED: { rank: 3, title: 'Numbers or punctuation could not be confirmed from the PDF' },
  INVALID: { rank: 4, title: 'Not valid Telugu — probably one misread letter' },
  ODD_CHARACTERS: { rank: 5, title: 'Characters that cannot be right here (e.g. £, Telugu numerals, a stray bracket)' },
  MISSING_TEXT: { rank: 6, title: 'Some or all of the Telugu could not be read' },
  MISSING_MATH: { rank: 7, title: 'The Telugu contains maths the OCR cannot read' },
  STRUCTURE: { rank: 8, title: 'The Telugu does not line up with the English stem and options' },
  OTHER: { rank: 9, title: 'Needs a check' },
}
export function issueOf(reason) {
  const r = String(reason)
  if (CONFIDENCE_ONLY.has(r)) return null
  const part = /^(?:STEM|BLOCK|OPTION[A-Z0-9]?)_(.+)$/.exec(r)   // question-level summaries, e.g. BLOCK_LOW, OPTIONB_EMPTY
  if (part) return issueOf(part[1])
  if (r === 'OCR_DECODER_DISAGREE') return 'DISAGREEMENT'
  if (r === 'DIGIT_MISMATCH') return 'DIGITS'
  if (r === 'GLYPH_ALIGNMENT_AMBIGUOUS') return 'DIGITS_UNCONFIRMED'
  if (r === 'INVALID_TELUGU_SEQUENCE') return 'INVALID'
  if (['OCR_SUSPECT_CHARACTERS', 'UNBALANCED_BRACKET', 'NOT_TELUGU'].includes(r)) return 'ODD_CHARACTERS'
  if (['EMPTY', 'MISSING', 'EMPTY_RUN'].includes(r)) return 'MISSING_TEXT'
  if (r === 'NOTATION_NOT_IN_OCR') return 'MISSING_MATH'
  if (/^(STRUCTURE_AMBIGUOUS|TELUGU_MARKERS_MISMATCH|TELUGU_TEXT_AFTER_OPTIONS|TELUGU_STEM_NOT_FOUND|ENGLISH_OPTIONS_)/.test(r)) return 'STRUCTURE'
  return 'OTHER'
}

const digitsOf = s => String(s ?? '').match(/\d+/g) || []

// The specific problem, in teacher words, with the evidence that makes it concrete.
function describe(code, ctx) {
  const { content, english, printed, reasons } = ctx
  const detail = (() => {
    if (code === 'DIGITS') {
      const te = digitsOf(content.current)
      const base = `Telugu reads ${te.length ? te.join(' ') : 'no numbers'}; the English has ${english.length ? english.join(' ') : 'no numbers'}.`
      if (printed?.status === 'MATCH') return `${base} The Telugu numbers are exactly the digits printed in the PDF, so the two versions may genuinely differ.`
      if (printed?.status === 'REPAIRABLE') return `${base} The PDF prints ${(printed.after || []).join(' ')} here.`
      return base
    }
    if (code === 'DIGITS_UNCONFIRMED') return printed?.status === 'MATCH' ? 'The OCR digits are exactly the digits printed in the PDF.' : 'Compare the numbers and punctuation with the source.'
    if (code === 'DISAGREEMENT') return 'Compare both readings with the source; the suggestion is not always right.'
    if (code === 'MISSING_MATH') return 'Type the maths from the source (e.g. a fraction or power printed as an image).'
    if (code === 'STRUCTURE') {
      const m = reasons.map(r => /^TELUGU_MARKERS_MISMATCH\((.*) vs (.*)\)$/.exec(r)).find(Boolean)
      return m ? `The Telugu options are ${m[1]}; the English options are ${m[2]}.` : 'Check which Telugu text belongs to the stem and to each option.'
    }
    if (code === 'MISSING_TEXT') return content.current ? 'Part of the printed text may be missing — compare the whole crop.' : 'Type it from the source, or mark it missing.'
    if (code === 'OTHER') return reasons.filter(r => issueOf(r) === 'OTHER').join(', ')
    return null
  })()
  return { code, title: ISSUES[code].title, detail }
}

// All crops of one unit (a long stem spans several), in reading order.
export function unitCrops(ix, q, crop) {
  if (!crop) return []
  const d = crop.detection_detail || {}
  const pool = crop.draft_question_id ? ix.mediaByQuestion.get(crop.draft_question_id) || [] : []
  const same = pool.filter(m => m.media_kind === 'TEXT_REGION' && (m.detection_detail || {}).unit === d.unit && ((m.detection_detail || {}).marker ?? null) === (d.marker ?? null)
    && (m.detection_detail || {}).runId === d.runId)
  return (same.length ? same : [crop]).sort((a, b) => ((a.detection_detail || {}).regionIndex ?? 0) - ((b.detection_detail || {}).regionIndex ?? 0))
}

// Repeated identical source evidence: sourceFp -> every Telugu unit (row) printed from it.
export function sourceGroups(ix) {
  const groups = new Map()
  const add = (owner, row) => {
    const crop = row?.source_media_id ? ix.mediaById.get(row.source_media_id) : null
    const fp = crop?.detection_detail?.sourceFp
    if (!fp) return
    if (!groups.has(fp)) groups.set(fp, [])
    groups.get(fp).push({ owner, row, crop })
  }
  for (const t of ix.questionText.values()) add('QUESTION', t)
  for (const t of ix.optionText.values()) add('OPTION', t)
  return groups
}

const unitKey = (kind, marker) => (kind === 'STEM' ? 'STEM' : `OPTION ${marker}`)

// One Telugu unit of a question, with everything the teacher needs to decide it.
function buildUnit(ix, item, { groups, openItemByRow }) {
  const q = itemQuestion(ix, item), o = itemOption(ix, item)
  const content = teluguContent(ix, item)
  const crop = content.crop
  const reasons = (item.machine_reasons || []).map(String)
  const open = isOpen(item)
  const printed = crop?.detection_detail?.printedDigits || item.detail?.printedDigits || null
  const english = o ? digitsOf(o.content) : digitsOf(q?.content)   // what the English prints (display only)
  const codes = [...new Set(reasons.map(issueOf).filter(Boolean))].sort((a, b) => ISSUES[a].rank - ISSUES[b].rank)
  const structure = item.item_type === 'TELUGU_STRUCTURE_AMBIGUOUS'
  const lane = !open ? 'done' : !item.blocking ? 'optional' : codes.length || structure ? 'exception' : 'quick'
  const issues = lane === 'exception' ? (codes.length ? codes : ['STRUCTURE']).map(c => describe(c, { content, english, printed, reasons })) : []
  // "Use printed digits": offered only for the PDF's own digits, when the stored/attempted text is exactly the
  // text the evidence was computed on (a teacher edit or a different reading makes it stale).
  // One click only when wrong digits are the unit's ONLY problem; otherwise the repair pre-fills the editor
  // so the teacher fixes the rest in the same decision. "Punctuation unconfirmed" (GLYPH_ALIGNMENT_AMBIGUOUS)
  // is another problem: on the golden paper Q7 the OCR read "6 : 30" as "6 వ 80" — the digits alone are not enough.
  const digitRepair = open && printed?.status === 'REPAIRABLE' && printed.text && content.current
    && digitsOf(content.current).join(' ') === (printed.before || []).join(' ') && printed.text !== content.current
    ? { ...printed, oneClick: codes.length === 1 && codes[0] === 'DIGITS' } : null
  const fp = crop?.detection_detail?.sourceFp || null
  const members = fp ? (groups.get(fp) || []) : []
  const others = members.filter(m => m.row?.id !== content.row?.id)
  const readingOf = m => (m.row?.text_quality === 'OCR_EXTRACTED' || m.row?.text_quality === 'TEACHER_ENTERED' ? m.row.content : m.crop?.detection_detail?.ocrText) || ''
  const repeat = members.length > 1 ? {
    fp, count: members.length,
    places: members.map(m => {
      const oq = m.owner === 'OPTION' ? ix.optionById.get(m.row.draft_option_id) : null
      const qq = ix.questionById.get(oq ? oq.draft_question_id : m.row.draft_question_id)
      return { label: `Q${qq?.source_question_number ?? '?'}${oq ? ` ${oq.marker}` : ''}`, questionId: qq?.id, reading: readingOf(m), open: openItemByRow.has(m.row.id), decided: !!m.row.verification_state }
    }),
    differentReadings: [...new Set(others.map(readingOf).filter(r => r && r !== content.current))],
  } : null
  const acts = allowedActions(ix, item)
  return {
    id: item.id, item, question: q, option: o, kind: o ? 'OPTION' : structure ? 'BLOCK' : 'STEM', marker: o?.marker ?? null,
    label: structure ? 'Telugu block' : o ? `Option ${o.marker}` : 'Stem', key: structure ? 'BLOCK' : unitKey(o ? 'OPTION' : 'STEM', o?.marker),
    english: o ? o.content : q?.content, englishDigits: english,
    content, crops: unitCrops(ix, q, crop), lane, open, blocking: !!item.blocking, issues, reasons,
    suggestion: open ? content.suggestion : null, digitRepair, repeat,
    canKeep: open && !!acts.accept, canEdit: !structure, canMarkMissing: !structure && open, canDefer: item.status === 'OPEN',
  }
}

// Questions with open Telugu work, in paper order, each with all its Telugu units (decided ones for context).
export function buildTeluguReview(ix) {
  const groups = sourceGroups(ix)
  const teluguItems = (ix.items || []).filter(i => UNIT_TYPES.has(i.item_type))
  const openItemByRow = new Map()
  for (const i of teluguItems.filter(isOpen)) {
    const rowId = i.target_question_text_id || i.target_option_text_id
    if (rowId) openItemByRow.set(rowId, i)
  }
  const byQuestion = new Map()
  for (const i of teluguItems) {
    const q = itemQuestion(ix, i)
    if (!q) continue
    if (!byQuestion.has(q.id)) byQuestion.set(q.id, [])
    byQuestion.get(q.id).push(i)
  }
  const questions = []
  for (const q of ix.questions) {
    const items = byQuestion.get(q.id)
    if (!items?.length || !items.some(isOpen)) continue
    // One unit per text row: the open item if any, else the latest decided one.
    const perRow = new Map()
    for (const i of items) {
      const k = i.target_question_text_id || i.target_option_text_id || i.id
      const cur = perRow.get(k)
      if (!cur || (isOpen(i) && !isOpen(cur)) || (!isOpen(cur) && !isOpen(i) && String(i.resolved_at) > String(cur.resolved_at))) perRow.set(k, i)
    }
    const units = [...perRow.values()].map(i => buildUnit(ix, i, { groups, openItemByRow }))
      .sort((a, b) => (a.kind === 'OPTION') - (b.kind === 'OPTION') || String(a.marker ?? '').localeCompare(String(b.marker ?? '')))
    const openUnits = units.filter(u => u.open)
    const lane = openUnits.some(u => u.lane === 'exception') ? 'exception' : openUnits.some(u => u.lane === 'quick') ? 'quick' : 'optional'
    const otherBlocking = (ix.items || []).filter(i => isOpen(i) && i.blocking && !UNIT_TYPES.has(i.item_type) && !i.draft_material_id && itemQuestion(ix, i)?.id === q.id).length
    const material = q.shared_material_id ? ix.materialById.get(q.shared_material_id) : null
    const materialOpen = material ? (ix.items || []).some(i => i.draft_material_id === material.id && i.item_type === 'MATERIAL_TELUGU' && isOpen(i)) : false
    questions.push({
      id: q.id, number: Number(q.source_question_number), question: q, lane, units, openUnits,
      blockingOpen: openUnits.filter(u => u.blocking).length, optionalOpen: openUnits.filter(u => !u.blocking).length,
      deferred: openUnits.some(u => u.item.status === 'DEFERRED'),
      // What ONE atomic "Looks correct" verifies (0033): every confidence/agreement-only check still open here.
      verifyUnits: openUnits.filter(verifiableTogether),
      otherBlocking, material, materialOpen,
    })
  }
  const passages = (ix.items || []).filter(i => i.item_type === 'MATERIAL_TELUGU').map(i => ({
    id: i.id, item: i, material: ix.materialById.get(i.draft_material_id), open: isOpen(i),
    // 0033: the OCR proposal (never verification) and what the teacher decided about it.
    text: ix.materialText.get(i.draft_material_id) || null,
    proposal: ix.materialText.get(i.draft_material_id)?.source === 'AUTO_OCR' ? ix.materialText.get(i.draft_material_id).ocr_original_content : null,
    questions: ix.questionsByMaterial.get(i.draft_material_id) || [], range: numberRange(ix.questionsByMaterial.get(i.draft_material_id) || []),
    crops: (ix.mediaByMaterial.get(i.draft_material_id) || []).filter(m => m.media_kind === 'TEXT_REGION'),
  })).sort((a, b) => (a.material?.position ?? 0) - (b.material?.position ?? 0))   // paper order, stable across decisions
  const repeated = [...groups.entries()].map(([fp, members]) => ({ fp, members })).filter(g => g.members.length > 1)
  // Decision-ready groups: every member with its open item and the text the teacher sees there (the server
  // checks each occurrence against exactly this text before it changes anything).
  const openByRow = new Map()
  for (const i of teluguItems.filter(x => isOpen(x) && x.item_type !== 'TELUGU_STRUCTURE_AMBIGUOUS')) {
    const rowId = i.target_question_text_id || i.target_option_text_id
    if (rowId) openByRow.set(rowId, i)
  }
  const sourceDecisions = repeated.map(g => {
    const places = g.members.map(m => {
      const o = m.owner === 'OPTION' ? ix.optionById.get(m.row.draft_option_id) : null
      const q = ix.questionById.get(o ? o.draft_question_id : m.row.draft_question_id)
      const item = openByRow.get(m.row.id) || null
      const reading = item ? teluguContent(ix, item).current : ((m.row.text_quality === 'OCR_EXTRACTED' || m.row.text_quality === 'TEACHER_ENTERED' ? m.row.content : m.crop?.detection_detail?.ocrText) || '')
      return { key: m.row.id, item, question: q, label: `Q${q?.source_question_number ?? '?'}${o ? ` ${o.marker}` : ''}`, reading, decided: !!m.row.verification_state, blocking: !!item?.blocking, crop: m.crop }
    }).sort((a, b) => (a.question?.position ?? 0) - (b.question?.position ?? 0))
    const open = places.filter(p => p.item)
    const readings = [...new Set(open.map(p => p.reading))]
    return { fp: g.fp, places, open, readings, blockingOpen: open.filter(p => p.blocking).length, crop: g.members[0].crop }
  }).filter(g => g.open.length >= 2)
    .sort((a, b) => (b.blockingOpen > 0) - (a.blockingOpen > 0) || b.readings.length - a.readings.length || b.open.length - a.open.length)
  return { questions, passages, repeated, groups, sourceDecisions }
}

// Lane contents in working order: blocking questions first (deferred ones last), then paper order.
export function laneQuestions(review, lane) {
  return review.questions.filter(q => q.lane === lane)
    .sort((a, b) => (a.deferred - b.deferred) || (a.question.position - b.question.position))
}
export function laneCounts(review) {
  const c = { quick: 0, exception: 0, optional: 0, passages: review.passages.filter(p => p.open).length }
  for (const q of review.questions) c[q.lane]++
  c.repeated = review.sourceDecisions.filter(g => g.blockingOpen > 0).length
  return c
}

// The next unit the keyboard acts on: the first open blocking unit, then open optional ones.
export function activeUnitOf(q, preferId = null) {
  if (!q) return null
  if (preferId) { const u = q.openUnits.find(x => x.id === preferId); if (u) return u }
  return q.openUnits.find(u => u.blocking && u.item.status === 'OPEN') || q.openUnits.find(u => u.blocking) || q.openUnits[0] || null
}

// Which question to show after a decision: the same one while it still has blocking work (or the teacher
// is still working through it), else the next question of the lane that follows it in the previous order.
export function nextQuestionAfter(prevList, newList, currentId) {
  const cur = newList.find(q => q.id === currentId)
  if (cur && cur.blockingOpen > 0 && cur.openUnits.some(u => u.blocking && u.item.status === 'OPEN')) return currentId
  const at = prevList.findIndex(q => q.id === currentId)
  const ids = new Set(newList.map(q => q.id))
  for (const q of prevList.slice(at + 1)) if (ids.has(q.id)) return q.id
  const rest = newList.find(q => q.id !== currentId)
  return rest ? rest.id : null
}

// Word-level difference between the current text and a suggestion (longest common subsequence over
// whitespace-separated words, line breaks kept), so a long stem that differs in one word is compared at a glance.
export function wordDiff(a, b) {
  const tok = s => String(s ?? '').split(/(\s+)/).filter(x => x !== '')
  const A = tok(a), B = tok(b)
  const n = A.length, m = B.length
  const L = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
  const left = [], right = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (A[i] === B[j]) { left.push({ t: A[i], same: true }); right.push({ t: B[j], same: true }); i++; j++ }
    else if (L[i + 1][j] >= L[i][j + 1]) left.push({ t: A[i++], same: /^\s+$/.test(A[i - 1]) })
    else right.push({ t: B[j++], same: /^\s+$/.test(B[j - 1]) })
  }
  while (i < n) left.push({ t: A[i++], same: /^\s+$/.test(A[i - 1]) })
  while (j < m) right.push({ t: B[j++], same: /^\s+$/.test(B[j - 1]) })
  return { left, right }
}

// ---- teacher evidence (item 8) -----------------------------------------------------------------------
// Every Telugu decision classified from SERVER-stored state only: the resolution and value the RPC recorded,
// against the suggestion / printed digits recorded with the item at preparation. Never an accuracy metric —
// a decision is not ground truth.
export function classifyDecision(item) {
  if (item.status !== 'RESOLVED' || item.resolution === 'RECONCILED') return null
  const v = item.resolution_value
  const sug = item.detail?.decoder?.agree === false ? item.detail.decoder.suggestion : null
  const pd = item.detail?.printedDigits?.status === 'REPAIRABLE' ? item.detail.printedDigits.text : null
  if (item.resolution === 'ACCEPTED_OCR') return 'OCR_ACCEPTED_UNCHANGED'
  if (item.resolution === 'MARKED_MISSING') return 'MARKED_MISSING'
  if (item.resolution === 'EDITED_OCR' || item.resolution === 'TRANSCRIBED') {
    if (v != null && sug != null && v.trim() === sug.trim()) return 'SUGGESTION_ACCEPTED'
    if (v != null && pd != null && v.trim() === pd.trim()) return 'PRINTED_DIGITS_USED'
    return item.resolution === 'TRANSCRIBED' ? 'TEACHER_TRANSCRIBED' : 'TEACHER_EDITED'
  }
  return item.resolution
}
export function teacherEvidence(ix) {
  const rows = []
  for (const i of ix.items || []) {
    if (!UNIT_TYPES.has(i.item_type) && i.item_type !== 'MATERIAL_TELUGU') continue
    const outcome = classifyDecision(i)
    if (!outcome) continue
    const crop = i.source_media_id ? ix.mediaById.get(i.source_media_id) : null
    const d = crop?.detection_detail || {}
    rows.push({ itemId: i.id, itemType: i.item_type, outcome, blocking: !!i.blocking, verdict: i.detail?.verdict ?? d.ocrVerdict ?? null,
      reasons: i.machine_reasons || [], issues: [...new Set((i.machine_reasons || []).map(issueOf).filter(Boolean))],
      decoder: d.decoder ? { status: d.decoder.status, agree: d.decoder.agree ?? null } : null,
      printedDigits: d.printedDigits?.status ?? null, sourceFp: d.sourceFp ?? null, resolvedAt: i.resolved_at, note: i.resolution_note ?? null })
  }
  const tally = {}
  for (const r of rows) tally[r.outcome] = (tally[r.outcome] || 0) + 1
  return { rows, tally }
}
