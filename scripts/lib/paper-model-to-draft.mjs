// B4.2 — pure mapping from a B4.1 paper model to the writer payload.
//
// Invariants enforced here (and independently by the database):
//   * one B4 logical question  -> exactly one draft question;
//   * the question's content is its STEM only (B4.2R): option text lives in its logical options,
//     never in the stem;
//   * logical options stay unique per position and limited to the detected set;
//   * an answer-key entry sets is_proposed_correct ONLY;
//   * shared Directions/passage/data blocks become draft_materials that questions REFERENCE
//     (shared_material_id), never duplicated into each question;
//   * no confirmed answers, no language rows, no OCR text, no media;
//   * legacy Telugu glyph strings are never emitted as content — only region geometry.
//
// No pdf.js, no database, no network.

const PRIVATE_USE_OR_REPLACEMENT = /[-�]/

export const B4_ENGINE = 'ksc-b41-layout-engine'
export const B4_ENGINE_VERSION = '1.4.0'   // 1.1.0 bare-marker set; 1.2.0 stem/option separation + shared materials (B4.2R);
                                            // 1.3.0 provable inline-marker split + legacy-font digit options (B4.8.2);
                                            // 1.4.0 deterministic math notation \( … \) + located bitmaps (B4.8.3B)

// B4.8.3B provenance: where maths was reconstructed (rule, LaTeX) and where it could not be read (bitmap
// box + object id, stub, unresolved digits), in analysis_regions (existing JSONB) — geometry, no guesses.
const notationRegions = q => (q.notation || []).map(n => ({ kind: n.kind, side: n.side, owner: n.owner, page: n.page,
  ...(n.rule ? { rule: n.rule } : {}), ...(n.latex ? { latex: n.latex } : {}), ...(n.why ? { why: n.why } : {}),
  ...(n.box ? { box: n.box } : { x: n.x, y: n.y }), ...(n.obj ? { obj: n.obj } : {}), ...(n.kind === 'STUB' ? { covered: !!n.covered } : {}),
  // B4.8.3C: bitmap identity (exact pixels) and its place in the owner's English text.
  ...(n.fp !== undefined ? { fp: n.fp, px: n.px ?? null } : {}), ...(n.anchor !== undefined ? { anchor: n.anchor } : {}) }))
const mathWarnings = q => {
  const rec = (q.notation || []).filter(n => n.kind === 'RECONSTRUCTED' && n.side === 'en')
  return rec.length ? [`MATH_FROM_TEXT_GEOMETRY(${rec.map(n => `${n.owner}:${n.rule}`).join(',')})`] : []
}

// Question warnings that record a deterministic option repair (provenance, never a review reason).
const repairWarnings = q => (q.optionRepairs || []).map(r => r.kind === 'SPLIT_AT_INLINE_MARKER'
  ? `OPTION_SPLIT_AT_INLINE_MARKER(${r.host}|${r.marker}): ${String(r.source).slice(0, 200)}`
  : `OPTION_TEXT_FROM_LEGACY_GLYPH_DIGITS(${(r.markers || []).join(',')})`)

const uuid = () => (globalThis.crypto?.randomUUID
  ? globalThis.crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = (Math.random() * 16) | 0
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
    }))

// Text that carries unrenderable legacy glyphs is dropped rather than stored.
const safeText = (value) => {
  const s = typeof value === 'string' ? value : ''
  return PRIVATE_USE_OR_REPLACEMENT.test(s) ? null : (s.trim() || null)
}

// English text of a material. Labels that sit inside an accepted material figure (Venn counts,
// chart labels, table cells) are shown by the figure crop, so they are left out of the prose.
function materialEnglish(m, figureBoxes) {
  const inside = it => figureBoxes.some(b => b.page === it.page && it.x + it.width / 2 >= b.x0 && it.x + it.width / 2 <= b.x1
    && it.y + it.height / 2 >= b.y0 && it.y + it.height / 2 <= b.y1)
  const kept = (m.englishItems || []).filter(it => !inside(it))
  return { text: kept.map(it => it.str).join(' ').replace(/\s+/g, ' ').trim(), omittedLabels: (m.englishItems || []).length - kept.length }
}

// visuals: optional B4.3 manifest ({ accepted, rejected }), used only to keep figure labels out of
// material prose and to record whether a material's figure was captured automatically.
export function mapPaperModelToDraft(model, { importId, title = null, sourceFilename = null, visuals = null } = {}) {
  if (!importId) throw new Error('importId is required')
  const questions = []
  const options = []
  const materials = []
  const dropped = { optionsWithLegacyGlyphs: 0, questionsWithLegacyStem: 0, duplicateOptionPositions: 0, materialsWithLegacyText: 0 }

  const materialIds = new Map()
  for (const m of model.materials || []) {
    const id = uuid()
    materialIds.set(m.index, id)
    const figures = (visuals?.accepted || []).filter(v => v.owner?.kind === 'MATERIAL' && v.owner.materialIndex === m.index)
    const rejected = (visuals?.rejected || []).filter(v => v.materialIndex === m.index)
    const boxes = figures.map(v => ({ page: v.page, ...(v.figureBoxPt || v.inkBoxPt) }))
    const { text, omittedLabels } = materialEnglish(m, boxes)
    const content = safeText(text)
    if (content === null && text) dropped.materialsWithLegacyText++
    const reviewReasons = [...m.reviewReasons]
    if (visuals && ['DIAGRAM', 'CHART', 'TABLE'].includes(m.materialType) && !figures.length) reviewReasons.push('MATERIAL_VISUAL_NOT_CAPTURED')
    if (rejected.length) reviewReasons.push(`MATERIAL_VISUAL_CANDIDATE_REJECTED(${rejected.map(r => r.reasons.join('+')).join(';')})`)
    materials.push({
      id,
      position: m.index,
      material_type: m.materialType,
      content_text: content,
      language: 'en',
      source_page_start: Math.min(...m.pages),
      source_page_end: Math.max(...m.pages),
      extraction_confidence: m.confidence,
      heading: safeText(m.heading),
      source_regions: m.sourceRegions,
      telugu_regions: m.teluguRegions,
      applies_to_questions: m.covers,
      range_source: m.rangeSource,
      review_reasons: reviewReasons,
      warnings: omittedLabels ? [`FIGURE_LABELS_SHOWN_IN_CROP(${omittedLabels})`] : [],
    })
  }

  model.questions.forEach((q, index) => {
    const questionId = uuid()
    const rawStem = q.englishStem ?? q.englishText
    const stem = safeText(rawStem)
    if (stem === null && rawStem) dropped.questionsWithLegacyStem++

    questions.push({
      id: questionId,
      position: index,                             // draft order follows the paper
      source_question_number: q.number != null ? String(q.number) : null,
      content: stem,
      language: 'en',
      source_page: q.pages?.[0] ?? null,
      source_reference: `Auto-prepared from pages ${(q.pages || []).join(', ')}` +
        (q.crossColumn || q.crossPage ? ' (spans columns/pages)' : ''),
      extraction_status: q.status || 'NEEDS_REVIEW',
      review_reasons: q.reviewReasons || [],
      warnings: [...(q.unassignedEnglish ? [`UNASSIGNED_TEXT_AFTER_OPTIONS: ${q.unassignedEnglish.slice(0, 300)}`] : []), ...repairWarnings(q), ...mathWarnings(q)],
      shared_material_id: q.sharedMaterialIndex !== undefined ? (materialIds.get(q.sharedMaterialIndex) ?? null) : null,
      source_bbox: q.bbox || null,
      column_index: q.columns?.length ? Number(String(q.columns[0]).split(':')[1]) : null,
      // Geometry only: B4.3 crops these, B4.4 OCRs them. No glyph text is carried.
      analysis_regions: {
        telugu: (q.teluguRegions || []).map(r => ({ page: r.page, x: r.x, y: r.y, w: r.w, h: r.h, lines: r.lines })),
        figures: (q.visuals?.figureGaps || []).map(g => ({ page: g.page, column: g.column, x: g.x, y: g.y, w: g.w, h: g.h })),
        ...(q.notation?.length ? { notation: notationRegions(q) } : {}),
      },
      pairing_confidence: null,                    // pairing is B4.5
      answer_key_source: q.proposedAnswer?.source ?? null,
      answer_key_confidence: q.proposedAnswer ? 1 : null,
    })

    const usedPositions = new Set()
    ;(q.options || []).forEach((o, optionIndex) => {
      const position = Number.isInteger(o.position) ? o.position : optionIndex
      if (usedPositions.has(position)) { dropped.duplicateOptionPositions++; return }
      usedPositions.add(position)
      const text = safeText(o.text)
      if (text === null && o.text) dropped.optionsWithLegacyGlyphs++
      options.push({
        id: uuid(),
        draft_question_id: questionId,
        position,
        marker: o.marker ?? null,
        marker_confidence: null,
        content: text,
        // The key maps a letter to a position; it only ever proposes.
        is_proposed_correct: q.proposedAnswer ? position === q.proposedAnswer.position : false,
        warnings: [
          ...(o.textSource === 'TEXT_FROM_LEGACY_GLYPH_DIGITS' ? ['TEXT_FROM_LEGACY_GLYPH_DIGITS'] : []),
          ...((q.optionRepairs || []).some(r => r.kind === 'SPLIT_AT_INLINE_MARKER' && [r.host, r.marker].includes(o.marker)) ? ['SPLIT_AT_INLINE_MARKER'] : []),
          ...(/\\\(/.test(text || '') ? ['MATH_FROM_TEXT_GEOMETRY'] : []),
        ],
      })
    })
  })

  const metrics = {
    engine: B4_ENGINE,
    engineVersion: B4_ENGINE_VERSION,
    questionsDetected: model.stats?.questionsDetected ?? questions.length,
    optionsExactlyFour: model.stats?.optionsExactlyFour ?? null,
    answerKeyEntries: model.stats?.answerKeyEntries ?? null,
    ready: model.stats?.ready ?? null,
    needsReview: model.stats?.needsReview ?? null,
    unresolved: model.stats?.unresolved ?? null,
    teluguRegions: model.stats?.teluguRegionsDetected ?? null,
    sharedMaterials: materials.length,
    questionsWithSharedMaterial: questions.filter(q => q.shared_material_id).length,
    dropped,
  }

  return {
    paper: {
      title,
      source_type: 'PDF',
      source_filename: sourceFilename,
      source_page_count: model.stats?.pages ?? null,
      detected_language: 'en+te-legacy',
    },
    materials,
    questions,
    options,
    metrics,
  }
}
