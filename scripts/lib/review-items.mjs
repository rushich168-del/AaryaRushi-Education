// B4.5 — exception review model (pure).
//
// Turns a PERSISTED Draft (questions, options, language rows, media, shared materials — the shape
// scripts/b4-persist-local.mjs dumps) into granular review items. Each item names exactly one owner
// (question, option or shared material), its type, route, effort estimate, source page/crop/region,
// the extracted value (OCR text, option text, unowned text…), a confidence and machine reasons.
//
// Routes (question readiness is DERIVED from open blocking items, never stored separately):
//   QUICK_CHECK   blocking; structure is complete, the teacher verifies/corrects bounded content
//                 (Telugu OCR, a shared material's Telugu).
//   MANUAL_REVIEW blocking; needs judgment (options, answer key, visuals, structure, ambiguity).
//   ADVISORY      non-blocking; content that confidence says is fine but is NOT proven correct
//                 (HIGH OCR — Q105's stem is HIGH and wrong — and automatic figures).
//
// Effort (an estimate for planning, never a correctness claim):
//   ONE_CLICK_ACCEPT, SHORT_CORRECTION, TRANSCRIPTION (no usable OCR to start from),
//   MANUAL_INVESTIGATION.
//
// Nothing here writes, confirms an answer, creates an option or invents content.

export const REVIEW_GENERATOR = 'ksc-b45-review-items'
export const REVIEW_GENERATOR_VERSION = '1.6.0'   // 1.1.0 (B4.5R): Telugu items carry OCR engine/model/hybrid provenance
                                                  // 1.2.0 (B4.8.2): DUPLICATE_OPTION_TEXT is an option-set defect
                                                  // 1.3.0 (B4.8.3B): math notation reasons (bitmaps, unresolved, stubs)
                                                  // 1.4.0 (B4.8.4B): legacy-decoder agreement -> optional verification;
                                                  //   disagreement stays blocking and carries the suggestion
                                                  // 1.5.0 (B4.8.4C): Telugu items carry source evidence (sourceFp,
                                                  //   printedDigits) in detail; routing unchanged
                                                  // 1.6.0 (B4.8.4C/0033): a shared passage with an OCR proposal is a
                                                  //   blocking one-time check of it (still MATERIAL_TELUGU)

export const ITEM_TYPES = Object.freeze({
  TELUGU_STEM: { route: 'QUICK_CHECK' },
  TELUGU_OPTION: { route: 'QUICK_CHECK' },
  TELUGU_VERIFY: { route: 'ADVISORY' },
  TELUGU_STRUCTURE_AMBIGUOUS: { route: 'MANUAL_REVIEW' },
  MATERIAL_TELUGU: { route: 'QUICK_CHECK' },
  MATERIAL_VISUAL_MISSING: { route: 'MANUAL_REVIEW' },
  MATERIAL_VISUAL_VERIFY: { route: 'ADVISORY' },
  MATERIAL_RANGE_UNLINKED: { route: 'MANUAL_REVIEW' },
  QUESTION_VISUAL_MISSING: { route: 'MANUAL_REVIEW' },
  QUESTION_VISUAL_VERIFY: { route: 'ADVISORY' },
  OPTION_SET_ABNORMAL: { route: 'MANUAL_REVIEW' },
  OPTION_EMPTY: { route: 'MANUAL_REVIEW' },
  ANSWER_KEY: { route: 'MANUAL_REVIEW' },
  UNASSIGNED_TEXT: { route: 'MANUAL_REVIEW' },
  ENGLISH_STEM_MISSING: { route: 'MANUAL_REVIEW' },
  STRUCTURE: { route: 'MANUAL_REVIEW' },
})

const OPTION_SET_REASONS = /^(FEWER_THAN_4_OPTIONS|MORE_THAN_4_OPTIONS|NO_OPTIONS|DUPLICATE_OPTION_MARKERS|DUPLICATE_OPTION_TEXT)/
const VISUAL_REASONS = /^(VISUAL_EXPECTED_BUT_NONE_FOUND|VISUAL_PARTIALLY_CONTAINED)/
// NOTATION_IMAGE_IN_OPTIONS is routed to the option items above. NOTATION_IMAGE_IN_STEM,
// NOTATION_TEXT_UNRESOLVED and NOTATION_PLACEHOLDER_UNRESOLVED fall through to the STRUCTURE item (manual).
const KNOWN_QUESTION_REASONS = /^(NOTATION_IMAGE_IN_OPTIONS|NO_TELUGU_REGION|FEWER_THAN_4_OPTIONS|MORE_THAN_4_OPTIONS|NO_OPTIONS|DUPLICATE_OPTION_MARKERS|DUPLICATE_OPTION_TEXT|EMPTY_OPTION_TEXT|VISUAL_|NO_ANSWER_KEY_ENTRY|UNASSIGNED_TEXT_AFTER_OPTIONS|ENGLISH_STEM_MISSING_OR_SHORT)/

const regionOf = m => (m ? { page: m.source_page, x: Number(m.region_x), y: Number(m.region_y), w: Number(m.region_w), h: Number(m.region_h) } : null)

// Telugu language row -> review item (or null when nothing needs a teacher).
function teluguItem({ t, kind, question, option, mediaById }) {
  if (!t || t.text_quality === 'SCRIPT_NEUTRAL' || t.text_quality === 'TEACHER_ENTERED') return null
  const reasons = t.ocr_review_reasons || []
  if (reasons.length === 1 && reasons[0] === 'TELUGU_OPTIONS_NOT_IN_SOURCE') return null     // the paper prints none
  const crop = t.source_media_id ? mediaById.get(t.source_media_id) : null
  const attempt = crop?.detection_detail?.ocrText || null
  const base = {
    draft_question_id: option ? null : question.id,
    draft_option_id: option ? option.id : null,
    target_question_text_id: kind === 'QUESTION' ? t.id : null,
    target_option_text_id: kind === 'OPTION' ? t.id : null,
    source_page: crop?.source_page ?? question.source_page,
    source_media_id: crop?.id ?? null,
    source_region: regionOf(crop),
    confidence: t.ocr_confidence != null ? Number(t.ocr_confidence) : null,
  }
  // Which engine/model/hybrid produced the text — shown to the reviewer, never used as correctness.
  const d = crop?.detection_detail || {}
  const ocr = { engine: t.ocr_engine ?? d.ocrEngine ?? null, version: t.ocr_version ?? d.ocrVersion ?? null,
    ...(d.hybrid ? { hybrid: { version: d.hybrid.version, changed: d.hybrid.changed, ambiguous: d.hybrid.ambiguous }, rawOcr: d.ocrRawText ?? null } : {}) }
  if (reasons[0] === 'STRUCTURE_AMBIGUOUS') {
    return { ...base, item_type: 'TELUGU_STRUCTURE_AMBIGUOUS', extracted_value: attempt, machine_reasons: reasons, effort: 'MANUAL_INVESTIGATION', detail: { ocr } }
  }
  const type = kind === 'QUESTION' ? 'TELUGU_STEM' : 'TELUGU_OPTION'
  // B4.8.4B: the legacy decoder's reading, as stored beside the crop (never content by itself).
  const decoder = d.decoder ? { name: d.decoder.name, version: d.decoder.version, status: d.decoder.status, reason: d.decoder.reason ?? null,
    agree: d.decoder.agree ?? null, suggestion: d.decoder.agree === false ? (d.decoder.suggestion ?? null) : null } : null
  // B4.8.4C: source evidence recorded with the item at preparation, so each later teacher decision can be
  // classified (OCR kept / suggestion used / printed digits used / own edit) without trusting the client.
  const source = { ...(d.sourceFp ? { sourceFp: d.sourceFp } : {}), ...(d.printedDigits ? { printedDigits: d.printedDigits } : {}) }
  if (t.text_quality === 'OCR_EXTRACTED' && t.ocr_verdict === 'HIGH' && !reasons.length) {
    // Confidence is not correctness: kept as a non-blocking verification item.
    return { ...base, item_type: 'TELUGU_VERIFY', extracted_value: t.content, machine_reasons: ['OCR_HIGH_CONFIDENCE_UNVERIFIED'], effort: 'ONE_CLICK_ACCEPT', detail: { verifies: type, ocr, ...(decoder ? { decoder } : {}), ...source } }
  }
  // B4.8.4B: the ONLY reason the unit needed a teacher was OCR confidence, and an independent reading of the
  // PDF's glyphs gives exactly the same text: optional verification (routing, not proof of correctness).
  // Requires the stored text, the agreement recorded beside the crop, and no other reason at all.
  if (t.text_quality === 'OCR_EXTRACTED' && ['MEDIUM', 'LOW'].includes(t.ocr_verdict) && reasons.length === 2
      && reasons[0] === t.ocr_verdict && reasons[1] === 'OCR_DECODER_AGREE' && decoder?.agree === true && t.content) {
    return { ...base, item_type: 'TELUGU_VERIFY', extracted_value: t.content, machine_reasons: ['OCR_DECODER_AGREE', `OCR_CONFIDENCE_${t.ocr_verdict}`], effort: 'ONE_CLICK_ACCEPT',
      detail: { verifies: type, verdict: t.ocr_verdict, routedBy: 'OCR_DECODER_AGREE', ocr, decoder, ...source } }
  }
  const value = t.text_quality === 'OCR_EXTRACTED' ? t.content : attempt
  const flags = reasons.filter(r => r !== t.ocr_verdict)
  let effort
  if (t.text_quality === 'OCR_EXTRACTED' && t.ocr_verdict === 'MEDIUM' && !flags.length) effort = 'ONE_CLICK_ACCEPT'
  else if (value && /[ఀ-౿]/.test(value)) effort = 'SHORT_CORRECTION'
  else effort = 'TRANSCRIPTION'
  return { ...base, item_type: type, extracted_value: value, machine_reasons: reasons.length ? reasons : [t.ocr_verdict || 'MISSING'], effort,
    detail: { stored: t.text_quality === 'OCR_EXTRACTED', verdict: t.ocr_verdict, ocr, ...(decoder ? { decoder } : {}), ...source } }
}

// snapshot: { questions: [{ row, media, texts, options: [{ row, texts }] }], materials: [{ row, media }] }
// visualCandidates: optional B4.3 manifest (rejected question candidates are not persisted as media).
export function buildReviewItems(snapshot, { visualCandidates = null } = {}) {
  const items = []
  const mediaById = new Map()
  for (const q of snapshot.questions) for (const m of q.media || []) mediaById.set(m.id, m)
  for (const m of snapshot.materials || []) for (const x of m.media || []) mediaById.set(x.id, x)
  const push = (item, key) => items.push({ route: ITEM_TYPES[item.item_type].route, blocking: ITEM_TYPES[item.item_type].route !== 'ADVISORY',
    source_region: null, extracted_value: null, confidence: null, detail: {}, draft_question_id: null, draft_option_id: null, draft_material_id: null,
    target_question_text_id: null, target_option_text_id: null, source_media_id: null, ...item, item_key: key })
  const materialById = new Map((snapshot.materials || []).map(m => [m.row.id, m]))
  const rejectedByNumber = new Map()
  for (const r of visualCandidates?.rejected || []) {
    if (!r.questionNumber || r.reasons.includes('WHITESPACE_NO_INK')) continue
    if (!rejectedByNumber.has(r.questionNumber)) rejectedByNumber.set(r.questionNumber, [])
    rejectedByNumber.get(r.questionNumber).push(r)
  }

  // ---- shared materials: reviewed ONCE, however many questions reference them -------------
  for (const { row: m, media, texts } of snapshot.materials || []) {
    const teCrops = (media || []).filter(x => x.media_kind === 'TEXT_REGION')
    const figures = (media || []).filter(x => x.media_kind !== 'TEXT_REGION')
    const reasons = m.review_reasons || []
    // B4.8.4C: with a passage OCR proposal (0033) the item is a one-time check of that proposal; without one it
    // stays a transcription. Blocking either way: OCR is never teacher verification.
    const ocr = (texts || []).find(t => t.language === 'te' && t.source === 'AUTO_OCR' && t.ocr_original_content)
    if (reasons.includes('TELUGU_MATERIAL_TEXT_NOT_EXTRACTED') && ocr) {
      const flags = (ocr.ocr_detail?.flags || []).filter(f => f !== 'OCR_DECODER_AGREE')
      push({ item_type: 'MATERIAL_TELUGU', draft_material_id: m.id, source_page: teCrops[0]?.source_page ?? m.source_page_start,
        source_media_id: teCrops[0]?.id ?? null, source_region: regionOf(teCrops[0]), extracted_value: ocr.ocr_original_content,
        confidence: ocr.ocr_confidence != null ? Number(ocr.ocr_confidence) : null,
        machine_reasons: ['TELUGU_MATERIAL_OCR_PROPOSAL', ocr.ocr_verdict, ...flags].filter(Boolean),
        effort: ['HIGH', 'MEDIUM'].includes(ocr.ocr_verdict) && !flags.length ? 'ONE_CLICK_ACCEPT' : 'SHORT_CORRECTION',
        detail: { crops: teCrops.map(c => c.id), appliesTo: m.applies_to_questions, ocr: { engine: ocr.ocr_engine, version: ocr.ocr_version, verdict: ocr.ocr_verdict },
          ...(ocr.ocr_detail?.decoder ? { decoder: { status: ocr.ocr_detail.decoder.status, agree: ocr.ocr_detail.decoder.agree ?? null } } : {}) } }, `MATERIAL_TELUGU:${m.id}`)
    } else if (reasons.includes('TELUGU_MATERIAL_TEXT_NOT_EXTRACTED')) {
      push({ item_type: 'MATERIAL_TELUGU', draft_material_id: m.id, source_page: teCrops[0]?.source_page ?? m.source_page_start,
        source_media_id: teCrops[0]?.id ?? null, source_region: regionOf(teCrops[0]), machine_reasons: ['TELUGU_MATERIAL_TEXT_NOT_EXTRACTED'],
        effort: 'TRANSCRIPTION', detail: { crops: teCrops.map(c => c.id), appliesTo: m.applies_to_questions } }, `MATERIAL_TELUGU:${m.id}`)
    }
    const visualReasons = reasons.filter(r => r.startsWith('MATERIAL_VISUAL_'))
    if (visualReasons.length) {
      push({ item_type: 'MATERIAL_VISUAL_MISSING', draft_material_id: m.id, source_page: m.source_page_start, source_region: m.source_regions?.[0] ?? null,
        machine_reasons: visualReasons, effort: 'MANUAL_INVESTIGATION', detail: { appliesTo: m.applies_to_questions } }, `MATERIAL_VISUAL_MISSING:${m.id}`)
    }
    for (const f of figures) {
      push({ item_type: 'MATERIAL_VISUAL_VERIFY', draft_material_id: m.id, source_page: f.source_page, source_media_id: f.id, source_region: regionOf(f),
        confidence: f.detection_confidence != null ? Number(f.detection_confidence) : null, machine_reasons: ['AUTO_FIGURE_UNVERIFIED'], effort: 'ONE_CLICK_ACCEPT' }, `MATERIAL_VISUAL_VERIFY:${f.id}`)
    }
    if (!(m.applies_to_questions || []).length) {
      push({ item_type: 'MATERIAL_RANGE_UNLINKED', draft_material_id: m.id, source_page: m.source_page_start, source_region: m.source_regions?.[0] ?? null,
        extracted_value: m.heading, machine_reasons: reasons.filter(r => r.startsWith('MATERIAL_RANGE')), effort: 'MANUAL_INVESTIGATION' }, `MATERIAL_RANGE_UNLINKED:${m.id}`)
    }
  }

  // ---- questions ---------------------------------------------------------------------------
  for (const { row: q, media, texts, options } of snapshot.questions) {
    const number = Number(q.source_question_number)
    const reasons = q.review_reasons || []
    const opts = (options || []).map(o => ({ ...o.row, texts: o.texts || [] }))
    const qItem = (item, suffix) => push({ draft_question_id: q.id, source_page: q.source_page, ...item, detail: { number, ...(item.detail || {}) } }, `${item.item_type}:${q.id}${suffix ? `:${suffix}` : ''}`)

    // Telugu stem and options.
    const teStem = (texts || []).find(t => t.language === 'te')
    const stemItem = teluguItem({ t: teStem, kind: 'QUESTION', question: q, mediaById })
    if (stemItem) push({ ...stemItem, detail: { number, ...(stemItem.detail || {}) } }, `${stemItem.item_type}:${teStem.id}`)
    for (const o of opts) {
      const t = o.texts.find(x => x.language === 'te')
      const it = teluguItem({ t, kind: 'OPTION', question: q, option: o, mediaById })
      if (it) push({ ...it, detail: { number, marker: o.marker, englishOption: o.content, ...(it.detail || {}) } }, `${it.item_type}:${t.id}`)
    }

    // Options: set-level problems on the question, empty options on the option itself.
    // B4.8.3B: a bitmap in an EMPTY option is that option's own empty-option item (reason NOTATION_IMAGE);
    // a bitmap in an option that HAS text (the whole number of a mixed number, "70" of 70√3) means the text
    // is incomplete — a set-level manual item naming those options. Neither is ever auto-closed by 0031.
    const imageMarkers = new Set(reasons.filter(r => r.startsWith('NOTATION_IMAGE_IN_OPTIONS(')).flatMap(r => r.slice(26, -1).split(',')))
    const partial = opts.filter(o => o.content && imageMarkers.has(o.marker)).map(o => o.marker)
    const setReasons = [...reasons.filter(r => OPTION_SET_REASONS.test(r)), ...(partial.length ? [`NOTATION_IMAGE_IN_OPTIONS(${partial.join(',')})`] : [])]
    if (setReasons.length || (opts.length && opts.length !== 4)) {
      qItem({ item_type: 'OPTION_SET_ABNORMAL', extracted_value: opts.map(o => `${o.marker}) ${o.content ?? ''}`).join('  '),
        machine_reasons: setReasons.length ? setReasons : [`OPTION_COUNT_${opts.length}`], effort: 'MANUAL_INVESTIGATION' })
    }
    for (const o of opts.filter(o => !o.content)) {
      push({ item_type: 'OPTION_EMPTY', draft_option_id: o.id, source_page: q.source_page, extracted_value: null,
        machine_reasons: ['EMPTY_OPTION_TEXT', ...(imageMarkers.has(o.marker) ? ['NOTATION_IMAGE'] : [])], effort: 'MANUAL_INVESTIGATION', detail: { number, marker: o.marker } }, `OPTION_EMPTY:${o.id}`)
    }

    // Answer key: proposed only. Problems are explicit manual items — never "fixed" by inventing text.
    const proposed = opts.filter(o => o.is_proposed_correct)
    if (!q.answer_key_source) qItem({ item_type: 'ANSWER_KEY', machine_reasons: ['NO_ANSWER_KEY_ENTRY'], effort: 'MANUAL_INVESTIGATION' })
    else if (!proposed.length) qItem({ item_type: 'ANSWER_KEY', machine_reasons: ['KEY_LETTER_HAS_NO_OPTION'], effort: 'MANUAL_INVESTIGATION',
      extracted_value: opts.map(o => o.marker).join(''), detail: { optionCount: opts.length } })
    else if (!proposed[0].content) qItem({ item_type: 'ANSWER_KEY', machine_reasons: ['KEY_POINTS_AT_EMPTY_OPTION'], effort: 'MANUAL_INVESTIGATION',
      detail: { proposedMarker: proposed[0].marker } })

    // Visuals.
    const figures = (media || []).filter(m => m.media_kind !== 'TEXT_REGION')
    const material = q.shared_material_id ? materialById.get(q.shared_material_id) : null
    const materialFigures = material ? material.media.filter(x => x.media_kind !== 'TEXT_REGION') : []
    const visualReasons = reasons.filter(r => VISUAL_REASONS.test(r))
    const rejected = rejectedByNumber.get(number) || []
    if ((visualReasons.length && !figures.length && !materialFigures.length) || rejected.length) {
      const r0 = rejected[0]
      qItem({ item_type: 'QUESTION_VISUAL_MISSING', source_page: r0?.page ?? q.source_page,
        source_region: r0 ? { page: r0.page, pt: r0.cropPt || r0.inkBoxPt } : null,
        machine_reasons: [...visualReasons, ...rejected.map(r => `B4.3_CANDIDATE_REJECTED(${r.reasons.join('+')})`)], effort: 'MANUAL_INVESTIGATION',
        detail: { candidate: r0?.id ?? null } })
    }
    for (const f of figures) {
      push({ item_type: 'QUESTION_VISUAL_VERIFY', draft_question_id: q.id, source_page: f.source_page, source_media_id: f.id, source_region: regionOf(f),
        confidence: f.detection_confidence != null ? Number(f.detection_confidence) : null, machine_reasons: ['AUTO_FIGURE_UNVERIFIED'],
        effort: 'ONE_CLICK_ACCEPT', detail: { number } }, `QUESTION_VISUAL_VERIFY:${f.id}`)
    }

    // Structure.
    if (reasons.includes('UNASSIGNED_TEXT_AFTER_OPTIONS')) {
      const w = (q.warnings || []).find(x => String(x).startsWith('UNASSIGNED_TEXT_AFTER_OPTIONS'))
      qItem({ item_type: 'UNASSIGNED_TEXT', extracted_value: w ? String(w).replace(/^UNASSIGNED_TEXT_AFTER_OPTIONS:\s*/, '') : null,
        machine_reasons: ['UNASSIGNED_TEXT_AFTER_OPTIONS'], effort: 'MANUAL_INVESTIGATION' })
    }
    if (!q.content || reasons.includes('ENGLISH_STEM_MISSING_OR_SHORT')) {
      qItem({ item_type: 'ENGLISH_STEM_MISSING', extracted_value: q.content, machine_reasons: [q.content ? 'ENGLISH_STEM_MISSING_OR_SHORT' : 'ENGLISH_STEM_EMPTY'], effort: 'MANUAL_INVESTIGATION' })
    }
    const other = reasons.filter(r => !KNOWN_QUESTION_REASONS.test(r))
    if (other.length) qItem({ item_type: 'STRUCTURE', machine_reasons: other, effort: 'MANUAL_INVESTIGATION' })
  }
  return items
}

// Readiness is derived from open blocking items only: the question's own, its options', and its
// shared material's. The same rule is implemented by the draft_question_readiness view (0027).
export function deriveReadiness(snapshot, items, { isOpen = i => !i.status || i.status === 'OPEN' || i.status === 'DEFERRED' } = {}) {
  const optionToQuestion = new Map()
  for (const q of snapshot.questions) for (const o of q.options || []) optionToQuestion.set(o.row.id, q.row.id)
  const byQuestion = new Map(snapshot.questions.map(q => [q.row.id, []]))
  const questionsByMaterial = new Map()
  for (const q of snapshot.questions) if (q.row.shared_material_id) {
    if (!questionsByMaterial.has(q.row.shared_material_id)) questionsByMaterial.set(q.row.shared_material_id, [])
    questionsByMaterial.get(q.row.shared_material_id).push(q.row.id)
  }
  for (const i of items) {
    const targets = i.draft_material_id ? (questionsByMaterial.get(i.draft_material_id) || [])
      : [i.draft_question_id || optionToQuestion.get(i.draft_option_id)]
    for (const t of targets) byQuestion.get(t)?.push(i)
  }
  return snapshot.questions.map(q => {
    const mine = byQuestion.get(q.row.id)
    const open = mine.filter(i => i.blocking && isOpen(i))
    const readiness = open.some(i => i.route === 'MANUAL_REVIEW') ? 'MANUAL_REVIEW' : open.length ? 'QUICK_CHECK' : 'READY'
    return { draft_question_id: q.row.id, number: Number(q.row.source_question_number), readiness, openBlocking: open.length,
      openManual: open.filter(i => i.route === 'MANUAL_REVIEW').length, openQuick: open.filter(i => i.route === 'QUICK_CHECK').length,
      openAdvisory: mine.filter(i => !i.blocking && isOpen(i)).length }
  })
}

// Teacher actions: independent (a material item re-reviewed for every linked question) vs actual
// (a material item is reviewed once).
export function actionCounts(snapshot, items, { blockingOnly = true } = {}) {
  const linked = new Map()
  for (const q of snapshot.questions) if (q.row.shared_material_id) linked.set(q.row.shared_material_id, (linked.get(q.row.shared_material_id) || 0) + 1)
  const pool = items.filter(i => !blockingOnly || i.blocking)
  const actual = pool.length
  const independent = pool.reduce((n, i) => n + (i.draft_material_id ? Math.max(1, linked.get(i.draft_material_id) || 0) : 1), 0)
  return { actual, independent, savedBySharing: independent - actual }
}
