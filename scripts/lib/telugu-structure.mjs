// B4.4 — Telugu structure from B4.1 geometry (offline, pure).
//
// Splits each question's Telugu block into a STEM unit and per-option units (A-D) using the
// text layer's GEOMETRY only: where Telugu items sit, and which Latin option marker ("A)")
// precedes them. The legacy U+F0xx strings are never read as text here; they are only used
// to know that an item is Telugu and where it is. OCR later reads the rendered pixels.
//
// Structure is decided BEFORE OCR, so OCR output can never create, merge or reorder options.
// When the geometry does not give a clean stem + A-D split, the whole Telugu block becomes one
// BLOCK unit and the question is routed to review (no guessed mapping).

import { classifyItemScript } from './paper-layout.mjs'
import { decodeNeutralNumeric } from './telugu-glyph-hybrid.mjs'
import { isMathItem, neutralSpanValue } from './math-notation.mjs'
import { buildQuestionZones } from './visual-detection.mjs'

const MARKER = /^([A-D])\s*[).]\s*(.*)$/
const LEGACY_CLOSE_PAREN = String.fromCharCode(0xF029)   // the legacy font's ")" glyph
const OPENS_WITH_CLOSE_PAREN = new RegExp(`^\\s*[${LEGACY_CLOSE_PAREN})]`)
const markerLetter = m => m.str.trim()[0]
const markerInline = m => (MARKER.exec(m.str.trim()) || [])[2] || ''
const isScriptNeutral = s => { const t = String(s || '').trim(); return t.length > 0 && /^[\s\d\p{P}\p{S}]+$/u.test(t) }

export const UNIT_PAD = Object.freeze({ xPt: 2, belowFactor: 0.5, aboveFactor: 1.05 })

const itemScript = (it, fontScriptMap) =>
  (fontScriptMap?.get(it.fontName) === 'TELUGU_LEGACY' ? 'TELUGU_LEGACY' : classifyItemScript(it.str))
const isTelugu = (it, fsm) => ['TELUGU_LEGACY', 'TELUGU_UNICODE'].includes(itemScript(it, fsm))

// Padded PDF-point rect of a set of items, one rect per (page, column).
export function unitRects(items, { rightLimit = null } = {}) {
  const groups = new Map()
  for (const it of items) {
    const key = `${it.page}:${it.column}`
    const h = it.height || 10
    const r = groups.get(key) || { page: it.page, column: it.column, x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }
    r.x0 = Math.min(r.x0, it.x - UNIT_PAD.xPt)
    r.x1 = Math.max(r.x1, it.x + (it.width || 0) + UNIT_PAD.xPt)
    r.y0 = Math.min(r.y0, it.y - h * UNIT_PAD.belowFactor)
    r.y1 = Math.max(r.y1, it.y + h * UNIT_PAD.aboveFactor)
    groups.set(key, r)
  }
  return [...groups.values()].map(r => {
    const lim = rightLimit?.get(`${r.page}:${r.column}`)
    return lim != null ? { ...r, x1: Math.min(r.x1, lim) } : r
  }).sort((a, b) => a.page - b.page || a.column - b.column || b.y1 - a.y1)
}

// One question -> { structure, units[], neutralOptions, reasons[] }.
export function questionTeluguStructure(seg, modelQuestion, fontScriptMap, numberX) {
  // Flatten the question's items in reading order, tagged with their line position.
  const items = []
  seg.lines.forEach((line, li) => line.items.forEach(it => items.push({ ...it, page: line.page, column: line.column, li, lineY: line.y })))
  const telugu = items.filter(it => isTelugu(it, fontScriptMap))
  const reasons = []
  const englishOptions = modelQuestion?.options || []
  const neutral = englishOptions.length > 0 && englishOptions.every(o => isScriptNeutral(o.text))

  if (!telugu.length) {
    return { structure: 'NO_TELUGU', units: [], neutralOptions: neutral, reasons: ['NO_TELUGU_REGION'] }
  }

  // Marker items (not the question number). A marker "owns" what follows it: the rest of its
  // line up to the next marker, then following lines until the next marker line.
  // Two marker forms occur: a Latin "A)" item, or (pages 15+) a bare Latin "A" followed within
  // 12pt by a legacy-Telugu item whose FIRST code point is the font's ")" glyph (U+F029). That
  // single code point is used as a structural delimiter only — never read as content.
  const bareMarker = it => {
    if (!/^[A-D]$/.test(it.str.trim())) return false
    const next = items.filter(o => o.li === it.li && o.x > it.x).sort((a, b) => a.x - b.x)[0]
    return !!next && next.x - (it.x + (it.width || 0)) <= 12 && isTelugu(next, fontScriptMap) && OPENS_WITH_CLOSE_PAREN.test(next.str)
  }
  const markers = items.filter(it => (MARKER.test(it.str.trim()) || bareMarker(it)) && !(numberX != null && Math.abs(it.x - numberX) <= 8))
  const markerLines = new Set(markers.map(m => m.li))
  // A continuation line stays with the marker only when the line is mostly in the marker's own
  // script, so an English "D) Three" never swallows the Telugu stem printed after it (even one
  // that opens with a Latin word such as "LEGU అను ...").
  const ownerOf = new Map()   // item -> marker
  const scriptOf = it => (isTelugu(it, fontScriptMap) ? 'TE' : 'EN')
  // Weighted by printed width: pdf.js items are runs of very different lengths.
  const lineScript = its => {
    const w = it => Math.max(1, it.width || 0)
    const te = its.filter(it => scriptOf(it) === 'TE').reduce((n, it) => n + w(it), 0)
    const all = its.reduce((n, it) => n + w(it), 0)
    return te * 2 >= all ? 'TE' : 'EN'
  }
  let current = null, currentScript = null
  for (let li = 0; li < seg.lines.length; li++) {
    const lineItems = items.filter(it => it.li === li).sort((a, b) => a.x - b.x)
    if (markerLines.has(li)) { current = null; currentScript = null }
    else if (current && lineItems.length && currentScript && lineScript(lineItems) !== currentScript) { current = null; currentScript = null }
    for (const it of lineItems) {
      if (markers.includes(it)) {
        current = it
        const inline = markerInline(it)
        currentScript = inline ? (classifyItemScript(inline) === 'LATIN' || classifyItemScript(inline) === 'NEUTRAL' ? 'EN' : 'TE') : null
        continue
      }
      if (!current) continue
      if (!currentScript) currentScript = scriptOf(it)
      ownerOf.set(it, current)
    }
  }
  // Telugu option markers = markers that own at least one Telugu item.
  const ownedTelugu = m => telugu.filter(t => ownerOf.get(t) === m)
  // B4.8.2: an option printed only as a NUMBER in the legacy font ("A" + ") 1990") is script-neutral,
  // not Telugu. Proof: its whole run decodes with decodeNeutralNumeric AND equals the English option
  // exactly. Such options get no OCR unit (they are written SCRIPT_NEUTRAL like "A) 15") and their
  // items never fall into the stem.
  const neutralGlyphMarkers = markers.filter(m => {
    const its = ownedTelugu(m)
    if (!its.length || its.some(t => t.li !== m.li)) return false
    // B4.8.3B: maths reconstructed from the same legacy digits (Q124 ") 10" + raised "21") is part of the
    // span; every piece must be proven digits or reconstructed maths, and the whole must equal the English.
    const mathIts = items.filter(it => isMathItem(it) && it.li === m.li && ownerOf.get(it) === m)
    const value = mathIts.length ? neutralSpanValue([...its, ...mathIts], t => isTelugu(t, fontScriptMap))
      : decodeNeutralNumeric(its.sort((a, b) => a.x - b.x).map(t => t.str).join(''))
    const english = englishOptions.find(o => o.marker === markerLetter(m))?.text
    return value !== null && isScriptNeutral(english) && String(english).trim() === value
  })
  const teluguMarkers = markers.filter(m => !neutralGlyphMarkers.includes(m) && ownedTelugu(m).length)
  const letters = teluguMarkers.map(markerLetter)
  const stemItems = telugu.filter(t => !ownerOf.has(t) || (!teluguMarkers.includes(ownerOf.get(t)) && !neutralGlyphMarkers.includes(ownerOf.get(t))))
  const firstTeluguMarkerLi = teluguMarkers.length ? Math.min(...teluguMarkers.map(m => m.li)) : Infinity
  const strayAfterOptions = stemItems.filter(t => t.li > firstTeluguMarkerLi)

  // Right limit for an option unit that shares its line with the next marker ("A) x   B) y").
  // Each unit also carries per-line RUNS: consecutive Telugu items form a pixel run for OCR;
  // Latin/number items keep their genuine text-layer string (the Latin fonts extract cleanly).
  // The Telugu model cannot read Latin, so OCRing "LEGU" or "A2 + FL" would invent Telugu.
  const unitFor = (kind, marker, its) => {
    const rightLimit = new Map()
    if (marker) {
      const next = markers.filter(m => m.li === marker.li && m.x > marker.x).sort((a, b) => a.x - b.x)[0]
      if (next) rightLimit.set(`${marker.page}:${marker.column}`, next.x - 1)
    }
    const lineIdx = [...new Set(its.map(i => i.li))].sort((a, b) => a - b)
    const lines = lineIdx.map(li => {
      const teluguHere = its.filter(i => i.li === li)
      const x0 = Math.min(...teluguHere.map(i => i.x)), x1 = Math.max(...teluguHere.map(i => i.x + (i.width || 0)))
      const lineItems = items.filter(it => it.li === li && !markers.includes(it) && (
        teluguHere.includes(it) ||
        (!isTelugu(it, fontScriptMap) && (marker ? ownerOf.get(it) === marker : !teluguMarkers.includes(ownerOf.get(it))) &&
          it.x >= (marker ? x0 - 60 : x0 - 200) && it.x <= x1 + 60)))
        .sort((a, b) => a.x - b.x)
      const runs = []
      for (const it of lineItems) {
        const te = isTelugu(it, fontScriptMap)
        const last = runs[runs.length - 1]
        if (te && last?.type === 'TE') { last.items.push(it); continue }
        if (te) runs.push({ type: 'TE', items: [it], skipLeadingParen: !!marker && OPENS_WITH_CLOSE_PAREN.test(it.str) && runs.length === 0 })
        else runs.push({ type: 'TEXT', text: it.str.trim(), x: it.x })
      }
      // "D) 1 <te> 2 <te> 3": the marker item's own inline text opens the option.
      if (marker && li === marker.li && markerInline(marker)) runs.unshift({ type: 'TEXT', text: markerInline(marker).trim(), x: marker.x })
      for (const r of runs) if (r.type === 'TE') { r.rect = unitRects(r.items, { rightLimit })[0]; r.itemCount = r.items.length; delete r.items }
      // Never start a bare-marker option crop inside the Latin marker letter itself.
      const first = runs.find(r => r.type === 'TE')
      if (first?.skipLeadingParen && marker) first.rect.x0 = Math.max(first.rect.x0, marker.x + (marker.width || 0) + 0.3)
      return { li, page: teluguHere[0].page, column: teluguHere[0].column, runs: runs.filter(r => r.type === 'TE' || r.text) }
    })
    return { kind, marker: marker ? markerLetter(marker) : null, itemCount: its.length, lines: lines.length, lineRuns: lines, rects: unitRects(its, { rightLimit }) }
  }

  // B4.8.3B: Telugu-side math evidence the OCR cannot carry (a bitmap in the Telugu line, a raised digit
  // after a Telugu word, an uncovered equation stub) is attached to the unit that owns it, so the Telugu
  // stage can flag that unit for review. Located only; no value is inferred.
  const withNotation = result => {
    const ev = (modelQuestion?.notation || []).filter(n => n.side === 'te' && (n.kind === 'IMAGE' || n.kind === 'UNRESOLVED' || (n.kind === 'STUB' && !n.covered)))
    for (const n of ev) {
      const li = seg.lines.findIndex(l => l.page === n.page && Math.abs(l.y - n.lineY) <= 1.5 && l.items.some(it => it.x <= n.x + 30 && it.x + (it.width || 0) >= n.x - 30))
      if (li < 0) continue
      const m = markers.filter(k => k.li === li && k.x <= n.x).sort((a, b) => b.x - a.x)[0]
      const unit = (m && result.units.find(u => u.kind === 'OPTION' && u.marker === markerLetter(m)))
        || result.units.find(u => u.lineRuns.some(l => l.li === li)) || result.units.find(u => u.kind === 'BLOCK') || result.units.find(u => u.kind === 'STEM')
      if (unit) (unit.notation ||= []).push({ kind: n.kind, why: n.why ?? null, page: n.page, x: n.x, y: n.y })
    }
    return result
  }

  const expected = englishOptions.map(o => o.marker)
  if (teluguMarkers.length === 0) {
    const units = [unitFor('STEM', null, stemItems)]
    if (neutral) return withNotation({ structure: 'STEM_WITH_NEUTRAL_OPTIONS', units, neutralOptions: true, reasons })
    reasons.push('TELUGU_OPTIONS_NOT_IN_SOURCE')
    return withNotation({ structure: 'STEM_ONLY', units, neutralOptions: false, reasons })
  }
  // A Telugu marker set is valid when it is the full English set, or an in-order subset whose
  // missing options are all script-neutral in English (e.g. "$, #, &" symbol options).
  const inOrder = letters.every((l, i) => i === 0 || expected.indexOf(l) > expected.indexOf(letters[i - 1]))
  const missing = englishOptions.filter(o => !letters.includes(o.marker))
  const markerSetOk = new Set(letters).size === letters.length && letters.every(l => expected.includes(l)) && inOrder &&
    (missing.length === 0 || missing.every(o => isScriptNeutral(o.text)))
  const clean = markerSetOk && expected.length === 4 && stemItems.length > 0 && strayAfterOptions.length === 0
  if (!clean) {
    if (!markerSetOk) reasons.push(`TELUGU_MARKERS_MISMATCH(${letters.join('') || '-'} vs ${expected.join('') || '-'})`)
    if (!stemItems.length) reasons.push('TELUGU_STEM_NOT_FOUND')
    if (strayAfterOptions.length) reasons.push('TELUGU_TEXT_AFTER_OPTIONS')
    if (expected.length !== 4) reasons.push(`ENGLISH_OPTIONS_${expected.length}`)
    return withNotation({ structure: 'AMBIGUOUS_BLOCK', units: [unitFor('BLOCK', null, telugu)], neutralOptions: neutral, reasons })
  }
  const units = [unitFor('STEM', null, stemItems)]
  for (const m of teluguMarkers) units.push(unitFor('OPTION', m, telugu.filter(t => ownerOf.get(t) === m)))
  return withNotation({ structure: 'STEM_AND_OPTIONS', units, neutralOptions: neutral, reasons })
}

// B4.8.4C — the Telugu of each shared material (Directions / passage) as one PASSAGE unit, from the material's
// Telugu region(s) found by B4.1 (geometry only, like the question units): Telugu-majority lines inside the
// region, in reading order; consecutive Telugu items form a pixel run for OCR, other items keep their
// text-layer string. Returns [{ materialIndex, unit }] for materials that print Telugu.
export function buildPassageUnits(pages, model) {
  const fsm = buildQuestionZones(pages, model).fontScriptMap
  const out = []
  for (const m of model.materials || []) {
    const lineRuns = [], teluguItems = []
    for (const region of m.teluguRegions || []) {
      const page = pages.find(p => p.page === region.page)
      const its = (page?.items || []).filter(it => String(it.str || '').trim() && it.y >= region.y && it.y <= region.y + region.h
        && it.x >= region.x - 2 && it.x <= region.x + region.w + 2).map(it => ({ ...it, page: region.page, column: 0 }))
      const lines = []
      for (const it of [...its].sort((a, b) => b.y - a.y || a.x - b.x)) {
        const l = lines.find(x => Math.abs(x.y - it.y) <= 2)
        if (l) l.items.push(it); else lines.push({ y: it.y, items: [it] })
      }
      for (const l of lines.sort((a, b) => b.y - a.y)) {
        const items = l.items.sort((a, b) => a.x - b.x)
        const w = it => Math.max(1, it.width || 0)
        const te = items.filter(it => isTelugu(it, fsm))
        if (!te.length || te.reduce((n, it) => n + w(it), 0) * 2 < items.reduce((n, it) => n + w(it), 0)) continue   // an English line
        const runs = []
        for (const it of items) {
          const isTe = isTelugu(it, fsm), last = runs[runs.length - 1]
          if (isTe && last?.type === 'TE') { last.items.push(it); continue }
          runs.push(isTe ? { type: 'TE', items: [it], skipLeadingParen: false } : { type: 'TEXT', text: it.str.trim(), x: it.x })
        }
        for (const r of runs) if (r.type === 'TE') { r.rect = unitRects(r.items)[0]; r.itemCount = r.items.length; delete r.items }
        lineRuns.push({ li: lineRuns.length, page: region.page, column: 0, runs: runs.filter(r => r.type === 'TE' || r.text) })
        teluguItems.push(...te)
      }
    }
    if (lineRuns.length) out.push({ materialIndex: m.index, unit: { kind: 'PASSAGE', marker: null, itemCount: teluguItems.length, lines: lineRuns.length, lineRuns, rects: unitRects(teluguItems) } })
  }
  return out
}

export function buildTeluguStructures(pages, model) {
  const zm = buildQuestionZones(pages, model)
  if (!zm.consistent) throw new Error('B4.4 segmentation does not match the B4.1 model; refusing.')
  const byNumber = new Map(model.questions.map(q => [q.number, q]))
  return zm.segments.map(seg => {
    const q = byNumber.get(seg.number)
    const startCol = zm.columns.find(c => c.index === seg.startLine?.column)
    return { number: seg.number, ...questionTeluguStructure(seg, q, zm.fontScriptMap, startCol?.numberX ?? null) }
  })
}
