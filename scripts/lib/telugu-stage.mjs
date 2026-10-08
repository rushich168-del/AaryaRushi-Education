// B4.4 Telugu stage — the ONE implementation used by the offline CLI (scripts/b44-ocr-benchmark.mjs)
// and the B4.7 in-browser preparation pipeline. Platform-neutral (see preparation-platform-node.mjs
// and src/services/preparation/browserPlatform.js).
//
// Telugu structure from geometry -> render each page once -> OCR only the Telugu runs (never the
// PDF's legacy strings) -> Integer + Glyph hybrid (B4.5R: digits/punctuation/॥/quotes/spacing from
// the text layer when a run aligns; letters always OCR) -> assemble units -> verdicts. Also cuts the
// untouched 2x source crop of every unit (TEXT_REGION provenance). Returns the benchmark object
// (same shape as reports/b44/b44-benchmark.json) and the crop bytes keyed by region file name.

import { renderPageWith } from './pdf-page-model-core.mjs'
import { buildTeluguStructures, buildPassageUnits } from './telugu-structure.mjs'
import { prepareCropCanvas, assembleUnit, questionOutcome, digitTokens, stemDigits, withSuspectCharacterFlag, withNotationFlag, withInvalidSequenceFlag, OCR_ENGINE, MODEL_LABELS, THRESHOLDS } from './telugu-ocr-core.mjs'
import { applyGlyphHybrid, assembleHybridUnit, GLYPH_HYBRID, GLYPH_HYBRID_VERSION, RATIO } from './telugu-glyph-hybrid.mjs'
import { decodeLegacyRuns, decodeUnit, withDecoderReading, LEGACY_DECODER, LEGACY_DECODER_VERSION, OCR_DECODER_AGREE, OCR_DECODER_DISAGREE } from './telugu-legacy-decoder.mjs'
import { unitSourceFingerprint, printedDigitEvidence } from './telugu-source-evidence.mjs'

const median = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0 }
const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)

// ocrPool: { workers: [{ recognize(input) -> { text, confidence } }] } created by the platform.
// fonts (B4.8.4B): { fontName -> identity } from buildPageModelsFromPdf. The legacy decoder runs only on
// glyphs of a proven-supported font; with no fonts (or decoder: false) every unit is NOT_APPLICABLE and
// routing is exactly the OCR-only routing.
export async function runTeluguStage({ pdf, pages, model, platform, ocrPool, modelKey = 'int', modelSha256, hybridMode = 'glyph',
  scale = 4, strategy = 'binary', threshold = 170, onProgress = null, fonts = null, decoder = true, passages: readPassages = true }) {
  const t0 = platform.now()
  const structures = buildTeluguStructures(pages, model)
  // B4.8.4C: shared-material Telugu (one PASSAGE unit per material) is read by the same rules; its text is only
  // ever stored as an OCR PROPOSAL that the teacher verifies once (migration 0033).
  const passages = readPassages ? buildPassageUnits(pages, model) : []
  const tStructure = platform.now()
  const runsByPage = new Map()
  const allUnits0 = [...structures.flatMap(q => q.units), ...passages.map(p => p.unit)]
  for (const u of allUnits0) for (const l of u.lineRuns) for (const r of l.runs) {
    if (r.type !== 'TE') continue
    if (!runsByPage.has(r.rect.page)) runsByPage.set(r.rect.page, [])
    runsByPage.get(r.rect.page).push(r)
  }
  const runsTotal = [...runsByPage.values()].reduce((n, rs) => n + rs.length, 0)
  const runResults = new Map()
  const unitCrops = new Map()   // unit -> [{ rect, canvas, pixel }]
  let renderMs = 0, ocrMs = 0, runsDone = 0, pagesDone = 0
  const pageList = [...runsByPage.entries()].sort((a, b) => a[0] - b[0])
  for (const [pageNumber, runs] of pageList) {
    const r0 = platform.now()
    const { canvas, pageHeightPt: heightPt } = await renderPageWith(platform.createCanvas, pdf, pageNumber, scale, { gray: false })
    renderMs += platform.now() - r0
    const o0 = platform.now()
    let next = 0
    await Promise.all(ocrPool.workers.map(async ocr => {
      while (next < runs.length) {
        const run = runs[next++]
        const prep = prepareCropCanvas(platform.createCanvas, canvas, run.rect, { scale, pageHeightPt: heightPt, strategy, threshold, skipLeadingGlyph: run.skipLeadingParen })
        if (prep.empty) { runResults.set(run, { text: '', confidence: 0, skipped: true }); runsDone++; continue }
        runResults.set(run, await ocr.recognize(platform.ocrInput(prep.canvas)))
        runsDone++
      }
    }))
    ocrMs += platform.now() - o0
    // Source crops (unprocessed, 2x) of every unit rect on this page, for review provenance.
    for (const q of structures) for (const u of q.units) {
      for (const rect of u.rects.filter(r => r.page === pageNumber)) {
        if (!unitCrops.has(u)) unitCrops.set(u, [])
        const c = prepareCropCanvas(platform.createCanvas, canvas, rect, { scale, outScale: 2, pageHeightPt: heightPt, strategy: 'none', marginPx: 0 })
        unitCrops.get(u).push({ rect, png: await platform.encodePng(c.canvas), widthPx: c.pixel.width, heightPx: c.pixel.height })
      }
    }
    pagesDone++
    if (onProgress) await onProgress({ step: 'page', page: pageNumber, pagesDone, pagesTotal: pageList.length, runsDone, runsTotal })
  }
  const tDone = platform.now()

  // Glyph-layer hybrid over the raw OCR (pure; the glyph stream is alignment evidence only and is never stored).
  const hybrid = hybridMode === 'glyph' ? applyGlyphHybrid(runResults, pages) : null
  const assemble = (u, opts) => (hybrid ? assembleHybridUnit(assembleUnit, u, { results: hybrid.results, status: hybrid.status, rawResults: runResults }, opts) : assembleUnit(u, runResults, opts))
  // Second, independent reading of the legacy glyph layer (pure; the stream is never stored).
  const dec0 = platform.now()
  const legacy = decoder ? decodeLegacyRuns([...structures, { units: passages.map(p => p.unit) }], pages, fonts || {}) : { runs: new Map(), fonts: {} }
  const decoderMs = platform.now() - dec0

  const crops = new Map()
  const itemsByPage = new Map(pages.map(p => [p.page, p.items]))
  const byNumber = new Map(model.questions.map(q => [q.number, q]))
  const pageOf = n => pages.find(p => p.page === n)
  const questions = []
  for (const s of structures) {
    const q = byNumber.get(s.number)
    // Digits the English counterpart prints: the option's own text, or the stem without its options.
    const englishDigits = u => (u.kind === 'OPTION' ? digitTokens(q.options.find(o => o.marker === u.marker)?.text)
      : u.kind === 'STEM' ? stemDigits(q.englishText, q.options.map(o => o.text)) : null)
    const units = []
    for (const u of s.units) {
      const regions = []
      for (const [k, c] of (unitCrops.get(u) || []).entries()) {
        const file = `crops/q${s.number}-${u.kind}${u.marker ?? ''}-${k}.png`
        crops.set(file, c.png)
        const p = pageOf(c.rect.page)
        const x0 = Math.max(0, c.rect.x0), y0 = Math.max(0, c.rect.y0), x1 = Math.min(p.widthPt, c.rect.x1), y1 = Math.min(p.heightPt, c.rect.y1)
        regions.push({ page: c.rect.page, file, sha256: await platform.sha256(c.png), widthPx: c.widthPx, heightPx: c.heightPx,
          renderScale: 2, pageWidthPt: p.widthPt, pageHeightPt: p.heightPt,
          region: { x: +(x0 / p.widthPt).toFixed(4), y: +((p.heightPt - y1) / p.heightPt).toFixed(4), w: +((x1 - x0) / p.widthPt).toFixed(4), h: +((y1 - y0) / p.heightPt).toFixed(4) } })
      }
      // Suspect characters are judged on the FINAL text (after the glyph hybrid), never on raw OCR.
      // B4.8.4B: validity rule, then the decoder reading (agreement routing applies only when nothing
      // else is wrong, so it comes last).
      const assembled = withInvalidSequenceFlag(withNotationFlag(withSuspectCharacterFlag(assemble(u, { englishDigits: englishDigits(u) })), u.notation))
      // B4.8.4C: source evidence for the teacher (a hash of the printed unit; the PDF's own digits). Neither
      // changes the text, the verdict or the routing.
      const sourceFp = await unitSourceFingerprint(u, itemsByPage, platform.sha256)
      const printedDigits = printedDigitEvidence(u, hybrid ? hybrid.results : runResults, itemsByPage, { assembleUnit, englishDigits: englishDigits(u), currentText: assembled.text })
      units.push({ ...withDecoderReading(assembled, decodeUnit(u, legacy.runs)), regions, ...(sourceFp ? { sourceFp } : {}), printedDigits })
    }
    const { outcome, reasons } = questionOutcome(s, units)
    questions.push({ number: s.number, structure: s.structure, neutralOptions: s.neutralOptions, outcome, reasons,
      englishStem: q.englishText, englishOptions: q.options.map(o => `${o.marker}) ${o.text}`), proposedAnswer: q.proposedAnswer?.letter ?? null, units })
  }

  // Passages: no English digit check (the English passage is a different text), otherwise the unit rules.
  const passageResults = passages.map(p => {
    const a = withInvalidSequenceFlag(withSuspectCharacterFlag(assemble(p.unit, { englishDigits: null })))
    const { lineRuns, ...rest } = withDecoderReading(a, decodeUnit(p.unit, legacy.runs))
    return { materialIndex: p.materialIndex, lines: p.unit.lines, ...rest }
  })

  const allUnits = questions.flatMap(q => q.units)
  const allRuns = [...runResults.values()].filter(r => !r.skipped)
  const unitConfs = allUnits.filter(u => u.runs).map(u => u.minConfidence)
  const bucket = c => (c >= 90 ? '90-100' : c >= 80 ? '80-89' : c >= 70 ? '70-79' : c >= 60 ? '60-69' : '<60')
  const dist = {}; for (const c of unitConfs) dist[bucket(c)] = (dist[bucket(c)] || 0) + 1
  const verdicts = {}; for (const u of allUnits) verdicts[u.verdict] = (verdicts[u.verdict] || 0) + 1
  const withTelugu = questions.filter(q => q.structure !== 'NO_TELUGU')
  const metrics = {
    pages: pdf.numPages, questions: questions.length, questionsWithTelugu: withTelugu.length,
    structures: Object.fromEntries(['STEM_AND_OPTIONS', 'STEM_WITH_NEUTRAL_OPTIONS', 'STEM_ONLY', 'AMBIGUOUS_BLOCK', 'NO_TELUGU'].map(k => [k, questions.filter(q => q.structure === k).length])),
    unitsAttempted: allUnits.length,
    runsAttempted: runResults.size,
    runsSkippedMarkerOnly: [...runResults.values()].filter(r => r.skipped).length,
    unitsWithOcrText: allUnits.filter(u => u.ocrText).length,
    unitsGenuineTelugu: allUnits.filter(u => u.ocrText && u.teluguRatio >= THRESHOLDS.minTeluguRatio).length,
    unitsEmptyOrUnusable: allUnits.filter(u => ['EMPTY', 'NOT_TELUGU'].includes(u.verdict)).length,
    unitVerdicts: verdicts,
    unitsDigitMismatch: allUnits.filter(u => u.digitCheck === 'MISMATCH').length,
    unitsDigitVerified: allUnits.filter(u => u.digitCheck === 'MATCH').length,
    runConfidence: { mean: +mean(allRuns.map(r => r.confidence)).toFixed(1), median: +median(allRuns.map(r => r.confidence)).toFixed(1) },
    unitMinConfidence: { mean: +mean(unitConfs).toFixed(1), median: +median(unitConfs).toFixed(1), distribution: dist },
    questionsStructurallySeparated: questions.filter(q => ['STEM_AND_OPTIONS', 'STEM_WITH_NEUTRAL_OPTIONS'].includes(q.structure)).length,
    questionsAutoOcr: questions.filter(q => q.outcome === 'AUTO_OCR').length,
    questionsReview: questions.filter(q => q.outcome === 'REVIEW').length,
    unitsNeedingTeacher: allUnits.filter(u => u.verdict !== 'HIGH').length,
    scriptNeutralOptions: questions.filter(q => q.structure === 'STEM_WITH_NEUTRAL_OPTIONS').length * 4,
    ...(hybrid ? { hybrid: {
      runStatus: [...hybrid.status.values()].reduce((o, h) => (o[h.status] = (o[h.status] || 0) + 1, o), {}),
      unitsChangedByGlyphLayer: allUnits.filter(u => u.hybrid?.changed).length,
      unitsAlignmentAmbiguous: allUnits.filter(u => u.hybrid?.ambiguous).length } } : {}),
    decoder: {
      fonts: legacy.fonts,
      runStatus: [...legacy.runs.values()].reduce((o, r) => { const k = r.status === 'REFUSED' ? `REFUSED:${r.reason}` : r.status; o[k] = (o[k] || 0) + 1; return o }, {}),
      unitStatus: allUnits.reduce((o, u) => { const k = u.decoder?.status === 'REFUSED' ? `REFUSED:${u.decoder.reason}` : (u.decoder?.status || 'NONE'); o[k] = (o[k] || 0) + 1; return o }, {}),
      unitsAgree: allUnits.filter(u => u.decoder?.agree === true).length,
      unitsAgreeRouted: allUnits.filter(u => (u.flags || []).includes(OCR_DECODER_AGREE)).length,
      unitsDisagree: allUnits.filter(u => (u.flags || []).includes(OCR_DECODER_DISAGREE)).length,
      unitsInvalidSequence: allUnits.filter(u => (u.flags || []).includes('INVALID_TELUGU_SEQUENCE')).length,
    },
    // B4.8.4C
    passages: { attempted: passageResults.length, withTelugu: passageResults.filter(p => p.text && !['EMPTY', 'NOT_TELUGU'].includes(p.verdict)).length,
      verdicts: passageResults.reduce((o, p) => { o[p.verdict] = (o[p.verdict] || 0) + 1; return o }, {}) },
    sourceEvidence: {
      unitsFingerprinted: allUnits.filter(u => u.sourceFp).length,
      distinctFingerprints: new Set(allUnits.map(u => u.sourceFp).filter(Boolean)).size,
      printedDigits: allUnits.reduce((o, u) => { const k = u.printedDigits?.status || 'NONE'; o[k] = (o[k] || 0) + 1; return o }, {}),
    },
    timingsMs: { total: tDone - t0, structure: tStructure - t0, render: renderMs, ocr: ocrMs, decoder: decoderMs },
  }
  const meta = { engine: OCR_ENGINE, engineVersion: platform.engineVersion, model: MODEL_LABELS[modelKey], modelKey, modelSha256,
    hybrid: hybrid ? { name: GLYPH_HYBRID, version: GLYPH_HYBRID_VERSION, segmentRatioBounds: RATIO,
      classes: 'digits, basic punctuation, ॥, single/double quotes, spacing from the PDF glyph layer; Telugu letters always OCR' } : null,
    // One provenance string for every stored OCR row: engine version + model (sha prefix) + hybrid version.
    ocrVersion: `${platform.engineVersion}+${MODEL_LABELS[modelKey]}@${String(modelSha256).slice(0, 12)}${hybrid ? `+${GLYPH_HYBRID}@${GLYPH_HYBRID_VERSION}` : ''}`,
    // B4.8.4B: the second reading. Its version is provenance for routing/suggestions only; it never
    // produces stored content by itself, so it is not part of ocrVersion.
    decoder: decoder ? { name: LEGACY_DECODER, version: LEGACY_DECODER_VERSION, role: 'second reading: agreement routing + suggestions; never replaces OCR text' } : null,
    scale, preprocessing: strategy === 'binary' ? `binary luminance < ${threshold}, 12px white margin` : `${strategy}, 12px white margin`,
    workers: ocrPool.workers.length, thresholds: THRESHOLDS, platform: platform.name }
  return { benchmark: { meta, metrics, questions, passages: passageResults }, crops, unitCropsByQuestion: questions.map(q => q.units.map(u => u.regions.map(r => crops.get(r.file)))) }
}
