// B4.1 — Golden-Paper Layout Engine (offline, pure).
//
// Turns a page model (pdf.js text items + image rectangles) into a structured paper model:
// columns, question boundaries, cross-column/page continuation, English blocks, legacy
// Telugu regions (kept as regions, never as text), logical option markers, figure
// candidates, the answer key, and a confidence/review verdict per question.
//
// No pdf.js, no database, no OCR, no network. Everything here is deterministic and testable.

import { decodeNeutralNumeric } from './telugu-glyph-hybrid.mjs'
import { isMathItem, isBlank, neutralSpanValue } from './math-notation.mjs'

// ---------- script classification -------------------------------------------------
const PRIVATE_USE = /[-]/
const TELUGU_UNICODE = /[ఀ-౿]/
const LATIN_LETTER = /[A-Za-z]/
const SYMBOLISH = /[ -˿ -➿]/g

export function classifyItemScript(str = '') {
  const s = String(str)
  if (!s.trim()) return 'EMPTY'
  if (TELUGU_UNICODE.test(s)) return 'TELUGU_UNICODE'
  if (PRIVATE_USE.test(s)) return 'TELUGU_LEGACY'
  const symbols = (s.match(SYMBOLISH) || []).length
  if (symbols >= 3 && symbols / s.length >= 0.25) return 'TELUGU_LEGACY'
  if (LATIN_LETTER.test(s)) return 'LATIN'
  return 'NEUTRAL'
}

// A font id is legacy-Telugu when most of its non-empty items classify that way. This is
// the reliable signal for this paper: font FAMILY names are generic ("serif"/"sans-serif").
export function buildFontScriptMap(pages) {
  const tally = new Map()
  for (const page of pages) {
    for (const it of page.items) {
      const script = classifyItemScript(it.str)
      if (script === 'EMPTY') continue
      if (!tally.has(it.fontName)) tally.set(it.fontName, {})
      const t = tally.get(it.fontName)
      t[script] = (t[script] || 0) + 1
    }
  }
  const map = new Map()
  for (const [font, t] of tally) {
    const legacy = t.TELUGU_LEGACY || 0
    const total = Object.values(t).reduce((a, b) => a + b, 0)
    map.set(font, legacy / total >= 0.5 ? 'TELUGU_LEGACY' : 'LATIN')
  }
  return map
}

// ---------- columns ---------------------------------------------------------------
// Primary signal: question numbers are typeset at a fixed x per column, so clustering the
// x of "1." / "2." style tokens across the whole paper recovers the column grid exactly.
// (On this paper the gutter is only ~8pt wide, too narrow for whitespace detection alone.)
const NUMERIC_TOKEN = /^(\d{1,3})\s*[.)]?$/

export function detectColumnsFromNumbers(pages, { tolerance = 3, minHits = 5, marginTop = 0.965, marginBottom = 0.035 } = {}) {
  const hits = new Map()
  for (const page of pages) {
    const byY = new Map()
    for (const it of page.items) {
      if (!it.str.trim()) continue
      // Running header/footer page numbers form a phantom column; exclude those bands.
      if (it.y > page.heightPt * marginTop || it.y < page.heightPt * marginBottom) continue
      const key = Math.round(it.y / 4)
      const cur = byY.get(key)
      if (!cur || it.x < cur.x) byY.set(key, it)      // leftmost item on that line
    }
    for (const it of byY.values()) {
      if (!NUMERIC_TOKEN.test(it.str.trim())) continue
      const bucket = Math.round(it.x / tolerance) * tolerance
      hits.set(bucket, (hits.get(bucket) || 0) + 1)
    }
  }
  const centres = [...hits.entries()].filter(([, n]) => n >= minHits).map(([x]) => x).sort((a, b) => a - b)
  // Merge near-duplicate buckets.
  const merged = []
  for (const x of centres) {
    // Indented list/option numbers are not additional newspaper columns.
    // Keep the leftmost anchor within a plausible column width; otherwise a
    // narrow phantom column separates question numbers from their own text.
    if (merged.length && x - merged[merged.length - 1] < (pages[0]?.widthPt ?? 595) * 0.2) continue
    merged.push(x)
  }
  if (merged.length < 2) return null
  const width = pages[0]?.widthPt ?? 595
  const columns = merged.map((x, i) => ({
    index: i,
    from: i === 0 ? 0 : (merged[i - 1] + merged[i]) / 2,
    to: i === merged.length - 1 ? width : (merged[i] + merged[i + 1]) / 2,
    numberX: x,
  }))
  // Column bounds must start at the number x, not halfway across the previous column.
  for (let i = 1; i < columns.length; i++) columns[i].from = merged[i] - 8
  for (let i = 0; i < columns.length - 1; i++) columns[i].to = columns[i + 1].from
  return { columns, gutter: { x: columns[1].from, widthPt: 0 }, confident: true, source: 'QUESTION_NUMBER_CLUSTERS' }
}

// Fallback: the widest low-density vertical band in the middle of the page.
export function detectColumns(page, { bin = 2, minGutter = 4 } = {}) {
  const W = page.widthPt
  const bins = new Array(Math.ceil(W / bin)).fill(0)
  for (const it of page.items) {
    if (!it.str.trim()) continue
    const from = Math.max(0, Math.floor(it.x / bin))
    const to = Math.min(bins.length - 1, Math.floor((it.x + (it.width || 0)) / bin))
    for (let b = from; b <= to; b++) bins[b]++
  }
  const lo = Math.floor((W * 0.3) / bin)
  const hi = Math.ceil((W * 0.7) / bin)
  const peak = Math.max(...bins)
  const quiet = Math.max(0, Math.floor(peak * 0.01))   // near-empty, not strictly empty
  let best = null, run = null
  for (let b = lo; b <= hi; b++) {
    if (bins[b] <= quiet) { run = run ?? b; if (!best || (b - run) >= (best.to - best.from)) best = { from: run, to: b } }
    else run = null
  }
  if (!best || (best.to - best.from + 1) * bin < minGutter) {
    return { columns: [{ index: 0, from: 0, to: W }], gutter: null, confident: false }
  }
  const mid = ((best.from + best.to + 1) / 2) * bin
  return {
    columns: [{ index: 0, from: 0, to: mid }, { index: 1, from: mid, to: W }],
    gutter: { x: mid, widthPt: (best.to - best.from + 1) * bin },
    confident: true,
  }
}

// ---------- lines -----------------------------------------------------------------
export function buildLines(page, columnModel, { yTolerance = 4, marginTop = 0.965, marginBottom = 0.02 } = {}) {
  const H = page.heightPt
  const lines = []
  for (const col of columnModel.columns) {
    const items = page.items.filter(it => it.str.trim()
      && (it.x + (it.width || 0) / 2) >= col.from && (it.x + (it.width || 0) / 2) < col.to
      && it.y <= H * marginTop && it.y >= H * marginBottom)   // drop running header/footer
    items.sort((a, b) => (b.y - a.y) || (a.x - b.x))
    let current = null
    for (const it of items) {
      if (!current || Math.abs(current.y - it.y) > yTolerance) {
        current = { page: page.page, column: col.index, y: it.y, items: [it] }
        lines.push(current)
      } else current.items.push(it)
    }
  }
  for (const l of lines) {
    l.items.sort((a, b) => a.x - b.x)
    l.text = l.items.map(i => i.str).join(' ').replace(/\s+/g, ' ').trim()
    l.x = Math.min(...l.items.map(i => i.x))
    l.right = Math.max(...l.items.map(i => i.x + (i.width || 0)))
  }
  return lines
}

// A line is Telugu when it carries any legacy-Telugu item (its A)/B) markers are Latin).
export function tagLine(line, fontScriptMap) {
  let telugu = 0, latin = 0
  for (const it of line.items) {
    const byFont = fontScriptMap?.get(it.fontName)
    const script = byFont === 'TELUGU_LEGACY' ? 'TELUGU_LEGACY' : classifyItemScript(it.str)
    if (script === 'TELUGU_LEGACY' || script === 'TELUGU_UNICODE') telugu++
    else if (script === 'LATIN') latin++
  }
  return telugu > 0 ? 'TELUGU' : (latin > 0 ? 'ENGLISH' : 'NEUTRAL')
}

// ---------- reading order & question segmentation ---------------------------------
const QUESTION_NUMBER = /^(\d{1,3})\s*[.)]?$/
const QUESTION_INLINE = /^(\d{1,3})\s*[.)]\s+(.*)$/
// An option marker alone ("A)", "A )", "A.", "(A)") or leading its text ("A) Text", "A )Text", "A)Text",
// "(A) Text", "A. Text"). A dot needs a space after it: "1.5 km" and "A.P." are text, not markers.
// closer is the marker's style: ")" , "." or "(" for a bracketed "(A)".
const OPTION_MARKER = /^(\()?([A-D1-4])\s*([).])(.*)$/
export function readOptionMarker(str) {
  const m = OPTION_MARKER.exec(String(str).trim())
  if (!m) return null
  const [, open, label, close, rest] = m
  if (open && close !== ')') return null
  if (rest && close === '.' && !/^\s/.test(rest)) return null
  return { label, text: rest.trim(), closer: open ? '(' : close }
}
// Singular "direction" also occurs inside stems ("direction from the starting
// point?"). Only a labelled singular instruction can end a question.
const DIRECTIONS = /^(?:directions(?=\b|Q\s*\d)|direction(?=\s*(?:[:(]|Q\.?\s*\d|\d{1,3}\s*:)))/i
// Some papers label shared tables/passages with only a question range.
// Require both an explicit range and an instruction verb to avoid treating
// numeric series/ranges inside ordinary questions as a material boundary.
const RANGED_MATERIAL = /^(\d{1,3})\s*[-–—]\s*(\d{1,3})\s*[:.)]\s*(?:look\s+at|read|study|observe|consider|refer\s+to|answer\b|based\s+on|choose\b|find\b|identify\b|select\b)/i
const isMaterialHeading = text => DIRECTIONS.test(text) || RANGED_MATERIAL.test(text)

// Reading order: page ascending, then column, then top-to-bottom.
export function readingOrder(pageLines) {
  return pageLines.slice().sort((a, b) => (a.page - b.page) || (a.column - b.column) || (b.y - a.y))
}

// A question starts at a line whose first token is a number at the column's number x.
// A question starts where a number token sits at its column's number x (±tolerance).
export function findQuestionStarts(lines, columns, { numberXTolerance = 8 } = {}) {
  const numberX = new Map((columns || []).map(c => [c.index, c.numberX]))
  const starts = []
  lines.forEach((line, index) => {
    const first = line.items[0]
    if (!first) return
    const m = QUESTION_NUMBER.exec(first.str.trim()) || QUESTION_INLINE.exec(line.text)
    if (!m) return
    const anchor = numberX.get(line.column)
    if (anchor === undefined || Math.abs(first.x - anchor) > numberXTolerance) return
    const number = Number(m[1])
    if (!Number.isFinite(number) || number < 1 || number > 300) return
    starts.push({ index, number, line })
  })
  // A short numbered list inside a later question can share its left margin.
  // Treat 1–4 as list items only when the next established question resumes
  // exactly at previous+1. Other duplicates/gaps remain visible for review.
  return starts.filter((start, i) => {
    if (start.number > 4) return true
    const previous = starts.slice(0, i).findLast(s => s.number > 4)
    if (!previous) return true
    const next = starts.slice(i + 1).find(s => s.number > 4)
    return next?.number !== previous.number + 1
  })
}

export function segmentQuestions(lines, starts) {
  return starts.map((start, i) => {
    let end = i + 1 < starts.length ? starts[i + 1].index : lines.length
    // A "Directions (Q. Nos. …)" line introduces the NEXT questions' shared material, so it
    // terminates the current block instead of bleeding into its last option.
    for (let j = start.index + 1; j < end; j++) {
      if (isMaterialHeading(lines[j].text)) { end = j; break }
    }
    const body = lines.slice(start.index, end)
    const pages = [...new Set(body.map(l => l.page))]
    const columns = [...new Set(body.map(l => `${l.page}:${l.column}`))]
    return { number: start.number, lines: body, pages, columns, startLine: start.line }
  })
}

// A bilingual paper can print one question twice under the same number: the English part with its options
// and then the Telugu part, numbered again (typically after a single-question "Directions:" block, whose
// Telugu wording comes first). That is ONE question. The second start is merged into the first only on
// this evidence:
//   * it carries the same number as the question immediately before it;
//   * that question begins in English, and the copy has no English line of its own (Telugu and neutral
//     lines only; the A)-D) markers beside Telugu text are part of a Telugu line);
//   * nothing English lies between the two (Telugu directions between them go with the question).
// The lines stay in reading order, so the crop shows the English part and then the Telugu part. Any other
// repeat (two English questions, a repeat further on) is left as two questions and reported as a repeat.
export function mergeTeluguRepeats(segments, ordered, fontScriptMap) {
  const position = new Map(ordered.map((l, i) => [l, i]))
  const english = l => tagLine(l, fontScriptMap) === 'ENGLISH'
  const merged = []
  for (const seg of segments) {
    const previous = merged[merged.length - 1]
    const between = previous ? ordered.slice(position.get(previous.lines[previous.lines.length - 1]) + 1, position.get(seg.lines[0])) : []
    const teluguCopy = previous && previous.number === seg.number && !previous.teluguHalfMerged
      && english(previous.lines[0]) && tagLine(seg.lines[0], fontScriptMap) === 'TELUGU'
      && !seg.lines.some(english) && !between.some(english)
    if (!teluguCopy) { merged.push(seg); continue }
    const lines = [...previous.lines, ...between, ...seg.lines]
    merged[merged.length - 1] = { ...previous, lines, pages: [...new Set(lines.map(l => l.page))], columns: [...new Set(lines.map(l => `${l.page}:${l.column}`))], teluguHalfMerged: true }
  }
  return merged
}

// ---------- question internals -----------------------------------------------------
// The Telugu block often sits BETWEEN the English stem and the English options (Q6), so
// lines are separated by their own tag, never by "everything after the first Telugu line".
// A physical line can carry BOTH scripts (English option markers beside Telugu text).
// Such a line is split by item, so English markers survive instead of being discarded.
const itemScript = (it, fontScriptMap) =>
  (fontScriptMap?.get(it.fontName) === 'TELUGU_LEGACY' ? 'TELUGU_LEGACY' : classifyItemScript(it.str))

export function splitLanguageRuns(question, fontScriptMap) {
  const english = [], telugu = []
  const rebuild = (line, items) => {
    const l = { ...line, items }
    l.text = items.map(i => i.str).join(' ').replace(/\s+/g, ' ').trim()
    l.x = Math.min(...items.map(i => i.x))
    l.right = Math.max(...items.map(i => i.x + (i.width || 0)))
    return l
  }
  for (const line of question.lines) {
    const teluguItems = line.items.filter(it => ['TELUGU_LEGACY', 'TELUGU_UNICODE'].includes(itemScript(it, fontScriptMap)))
    if (teluguItems.length === 0) { english.push(line); continue }
    const otherItems = line.items.filter(it => !teluguItems.includes(it))
    telugu.push(rebuild(line, teluguItems))
    // Latin fragments of a Telugu line are usually the Telugu block's own A)-D) markers.
    // They are kept, but marked, so option parsing prefers clean English lines.
    if (otherItems.length) english.push({ ...rebuild(line, otherItems), fromMixedLine: true })
  }
  english.sort((a, b) => (a.page - b.page) || (a.column - b.column) || (b.y - a.y))
  telugu.sort((a, b) => (a.page - b.page) || (a.column - b.column) || (b.y - a.y))
  return { english, telugu }
}

// Logical options from marker tokens, supporting two options on one line.
export function parseOptions(allLines, { numberX = null, numberXTolerance = 8, teluguLines = [] } = {}) {
  // Latin fragments that shared a line with Telugu are the Telugu block's own markers.
  // If the clean English lines already carry a full marker set, ignore those fragments
  // entirely — otherwise their text bleeds into the last option. A letter printed inside the
  // previous option's run ("C) South China Sea D) Arabian Sea") counts towards that set.
  const cleanLines = allLines.filter(l => !l.fromMixedLine)
  const markersIn = ls => new Set(ls.flatMap(l => l.items.flatMap(i => {
    const marker = readOptionMarker(i.str)
    if (!marker) return []
    return [marker.label, ...(/[A-D]/.test(marker.label) ? [...marker.text.matchAll(INLINE_MARKER)].map(m => m[1]) : [])]
  })))
  const cleanMarkers = markersIn(cleanLines)
  const cleanHasSet = ['A', 'B', 'C', 'D'].every(m => cleanMarkers.has(m)) || ['1', '2', '3', '4'].every(m => cleanMarkers.has(m))
  const lines = cleanHasSet ? cleanLines : allLines

  // Bare "A B C D" markers (no bracket) are accepted ONLY as a complete ordered set on one
  // line, left to right, with real spacing between them and nothing else Latin on the line.
  // An isolated bare letter is never a marker.
  const bare = findBareMarkerSet(lines)

  const found = []
  const unowned = []
  for (const line of lines) {
    for (let i = 0; i < line.items.length; i++) {
      const item = line.items[i]
      const marker = readOptionMarker(item.str)
      if (!marker) continue
      // The question's own number ("1.") also matches the 1-4 marker pattern: skip any
      // marker sitting at the column's question-number x.
      if (numberX !== null && Math.abs(item.x - numberX) <= numberXTolerance) continue
      found.push({ marker: marker.label, closer: marker.closer, x: item.x, y: line.y, page: line.page, column: line.column, parts: marker.text ? [marker.text] : [], inlineParts: marker.text ? 1 : 0, itemIndex: i, line })
    }
  }
  // Text after a marker belongs to it until the next marker (same line to its right, or
  // following lines before the next marker). "Before" is READING order (page, column, then
  // top-down): comparing only page and y let a marker at the top of the next column claim the
  // stem printed at the bottom of the previous one (Q18/Q24/Q28/... option D leakage).
  for (const line of lines) {
    const markersHere = found.filter(f => f.line === line).sort((a, b) => a.x - b.x)
    line.items.forEach((item, idx) => {
      if (readOptionMarker(item.str)) return
      // Latin fragments of a mixed (Telugu) line belong to the Telugu block: they may only be
      // owned by a marker on that same line, never continue an option from an earlier line.
      // A continuation line never starts to the LEFT of its option's marker: in a two-up row
      // ("C) 39   D) 56") a following full-width line is not option D's continuation.
      const previous = line.fromMixedLine ? null : [...found].reverse().find(f => f.line !== line && readingCompare(f.line, line) < 0)
      const owner = [...markersHere].reverse().find(m => m.itemIndex < idx)
        || (previous && (previous.column !== line.column || line.x >= previous.x - 2) ? previous : null)
      if (owner) owner.parts.push(item.str)
      else if (!line.fromMixedLine) unowned.push({ line, idx, str: item.str })
    })
  }
  // Stems often contain numbered sub-lists ("1. Consultation 2. Illness ..."), which look
  // like 1-4 markers. When a complete A-D set exists, it is the option set; the digits are
  // stem content.
  // Prefer markers from clean English lines; only use markers that shared a line with
  // Telugu when the clean lines do not already provide a complete set.
  const pool = found.length ? found : bare
  const letters = pool.filter(f => /[A-D]/.test(f.marker))
  const hasFullLetterSet = ['A', 'B', 'C', 'D'].every(l => letters.some(f => f.marker === l))
  const order = ['A', 'B', 'C', 'D', '1', '2', '3', '4']
  const toOptions = list => list.slice().sort((a, b) => order.indexOf(a.marker) - order.indexOf(b.marker))
    .map(f => ({ marker: f.marker, text: markerText(f), page: f.page, column: f.column, at: f }))
  // Letters completed by the ones printed inside the previous option's run ("A) a-2, b-3 B) a-2, b-1")
  // are a full letter set as well: a numbered list before them is stem content, not options.
  const completedInline = !hasFullLetterSet && letters.length > 0 && new Set(letters.map(f => f.marker)).size === letters.length
    && splitInlineMarker(toOptions(letters)) !== null
  // The mirror case: a lettered list first, then the options numbered 1)-4) (see numberedOptionsAfterList).
  const numbered = numberedOptionsAfterList(letters, pool.filter(f => /[1-4]/.test(f.marker)), lines)
  // Match-the-following stems label their lists "A. Aravalli"; the paper's options use "A)".
  // When a complete ")" set exists it is the option set and the "." labels stay stem content.
  const letterPool = numbered ? numbered.options : hasFullLetterSet || completedInline ? letters : pool
  const paren = letterPool.filter(f => f.closer === ')')
  const parenFull = ['A', 'B', 'C', 'D'].every(l => paren.some(f => f.marker === l))
  const kept = parenFull ? paren : letterPool
  // A marker of another style printed inside the option area ("C) May 4)June", "B) Both (1) and (2)") is
  // that option's text: it goes back, with what follows it, to the option it sits in, under the same
  // ownership rule as any other text. Lists printed before the first option stay stem content.
  for (const f of found) {
    if (kept.includes(f)) continue
    const own = kept.filter(k => k.line === f.line && k.itemIndex < f.itemIndex).pop()
    const previous = f.line.fromMixedLine ? null : kept.filter(k => k.line !== f.line && readingCompare(k.line, f.line) < 0).pop()
    const owner = own || (previous && (previous.column !== f.line.column || f.line.x >= previous.x - 2) ? previous : null)
    const text = [f.line.items[f.itemIndex].str, ...f.parts.slice(f.inlineParts)]
    if (owner) owner.parts.push(...text)
    else if (previous && !f.line.fromMixedLine) unowned.push({ line: f.line, idx: f.itemIndex, str: text.join(' ') })
  }
  const { candidates, source: resolvedSource } = resolveMarkerSets(kept, lines, teluguLines)
  const optionSetSource = numbered ? numbered.source : resolvedSource
  const seen = new Map()
  for (const f of candidates) if (!seen.has(f.marker)) seen.set(f.marker, f)
  const parsed = toOptions([...seen.values()])
  const repair = splitInlineMarker(parsed, candidates.length - seen.size)
  const options = (repair ? repair.options : parsed).map((o, i) => ({ ...o, position: i }))
  // Where the chosen option set begins (earliest marker in reading order): the stem ends here.
  const first = [...seen.values()].sort((a, b) => readingCompare(a.line, b.line) || (a.itemIndex - b.itemIndex))[0]
  const stemBoundary = first ? { line: first.line, itemIndex: first.itemIndex } : null
  // English text after the option set that no option owns (e.g. the next question's unlabelled
  // instructions). It is kept and flagged, never silently appended to an option or dropped.
  const unassignedAfterOptions = stemBoundary ? unowned.filter(u => readingCompare(u.line, stemBoundary.line) > 0
    || (u.line === stemBoundary.line && u.idx > stemBoundary.itemIndex)).map(u => u.str).join(' ').replace(/\s+/g, ' ').trim() : ''
  return { options, markerSequence: repair ? options.map(o => o.marker) : [...seen.keys()], duplicates: candidates.length - seen.size, stemBoundary, unassignedAfterOptions,
    optionRepairs: repair ? repair.records : [], optionSetSource }
}

const markerText = f => f.parts.join(' ').replace(/\s+/g, ' ').trim()
// The line just before a marker's line, when it carries no marker of its own: the prompt that introduces a set.
const promptBefore = (marker, lines) => {
  const before = lines[lines.indexOf(marker.line) - 1]
  return before && !before.items.some(i => readOptionMarker(i.str)) ? before.text : ''
}
const refersToListAbove = prompt => /[:?]\s*$/.test(prompt) && /\babove\b/i.test(prompt)
const areListCodes = texts => texts.every(isAnswerCode) && texts.some(t => /\b[A-H]\b/.test(t))

// LETTERED_LIST_BEFORE_NUMBERED_OPTIONS: a lettered list (A.., in order, printed once) followed by exactly
// one 1-4 set in order, in one marker style, where that set is the options by the same evidence as
// STATEMENT_LIST_BEFORE_OPTIONS: its texts are codes of the list ("A and B", "A, B, D"), or the line that
// introduces it ends in ":" or "?" and refers to the list "above". Without that evidence the letters stay
// the options, as before (a numbered sub-list inside an option is not an option set).
export function numberedOptionsAfterList(letters, digits, lines) {
  if (letters.length < 2 || digits.length !== 4 || !letters.every((f, i) => f.marker === 'ABCD'[i])) return null
  if (digits.map(f => f.marker).join('') !== '1234' || new Set(digits.map(f => f.closer)).size !== 1) return null
  const lastLetter = letters[letters.length - 1]
  if (!digits.every(f => readingCompare(lastLetter.line, f.line) < 0 || (f.line === lastLetter.line && f.itemIndex > lastLetter.itemIndex))) return null
  if (!areListCodes(digits.map(markerText)) && !refersToListAbove(promptBefore(digits[0], lines))) return null
  return { options: digits, source: { kind: 'LETTERED_LIST_BEFORE_NUMBERED_OPTIONS', listMarkers: letters.map(f => f.marker) } }
}
// Answer codes only name the items of a lettered list: "A and B", "Only C", "A, B and E", "None of the above",
// "A, B are correct", "A-4, B-2, C-3, D-1".
const CODE_WORDS = /^(?:(?:only|both|neither|nor|and|or|all|none|of|the|above|these|is|are|correct|incorrect|true|false|right|wrong|statements?)\b|[\s,&.\d-])*$/
const isAnswerCode = text => CODE_WORDS.test(text.replace(/\b[A-H]\b/g, ' ').toLowerCase())

// A question can print more than one A-D set. Two cases are provable, and only then is a set put aside;
// every other repeat stays a duplicate for the teacher (e.g. a set misprinted "A) A) C) C)").
//   OPTION_SET_REPEATED_IN_TELUGU_BLOCK  the last set repeats the one before it word for word and Telugu
//                                        text lies between them: it is the Telugu rendering's copy.
//   STATEMENT_LIST_BEFORE_OPTIONS        a lettered list (A.., in order) comes first and the last set is
//                                        the options: its texts are codes of that list, or the line that
//                                        introduces it ends in ":" or "?" and refers to the list "above".
// The list stays stem content. The source is reported, never a review reason.
export function resolveMarkerSets(candidates, lines, teluguLines = []) {
  if (!candidates.length || candidates.some(f => !/^[A-D]$/.test(f.marker))) return { candidates, source: null }
  let sets = []
  for (const f of candidates) {
    const cur = sets.at(-1)
    if (!cur || cur.some(g => g.marker >= f.marker)) sets.push([f])
    else cur.push(f)
  }
  if (sets.length < 2) return { candidates, source: null }
  const complete = set => set.map(f => f.marker).join('') === 'ABCD'
  let source = null
  const last = sets.at(-1), previous = sets.at(-2)
  if (complete(last) && complete(previous) && last.every((f, i) => markerText(f) && markerText(f) === markerText(previous[i]))
    && teluguLines.some(t => readingCompare(previous[0].line, t) < 0 && readingCompare(t, last[0].line) < 0)) {
    sets = sets.slice(0, -1)
    source = { kind: 'OPTION_SET_REPEATED_IN_TELUGU_BLOCK' }
  }
  if (sets.length === 2 && complete(sets[1]) && sets[0].every((f, i) => f.marker === 'ABCD'[i])) {
    const [list, options] = sets
    if (areListCodes(options.map(markerText)) || refersToListAbove(promptBefore(options[0], lines))) {
      sets = [options]
      source = { kind: 'STATEMENT_LIST_BEFORE_OPTIONS', listMarkers: list.map(f => f.marker) }
    }
  }
  return { candidates: sets.flat(), source }
}

// B4.8.2 — a following option marker printed inside the previous option's text ("C) Iron D)Aluminium",
// "A) Prathaparudra DevaB) Ganapathi Deva", "C) Absence of foreskin D) Scaly skin"). The split is made
// ONLY when it is provable:
//   * the letter set is A-D with one or more letters missing (never A) and no duplicate markers;
//   * the option set contains exactly one embedded "X)" (not "(X)") for each missing letter and no
//     other, and each sits in the run of the letter immediately before it ("A) .. B) ..", "C) .. D) ..");
//   * every part is non-empty and the parts with their markers reproduce the source text exactly.
// Anything else (e.g. Q28, where D already exists as a separate empty marker) is left untouched for the
// teacher. Nothing is guessed: a missing option is never created from nothing.
export const INLINE_MARKER = /(?<![(A-Z])([A-D])\)/g
export function splitInlineMarker(options, duplicates = 0) {
  if (duplicates > 0 || !options.length || options.length > 3 || options.some(o => !/^[A-D]$/.test(o.marker))) return null
  const missing = ['A', 'B', 'C', 'D'].filter(l => !options.some(o => o.marker === l))
  if (!missing.length || missing.includes('A')) return null
  const repaired = [], records = []
  for (const host of options) {
    const hits = [...host.text.matchAll(INLINE_MARKER)].filter(m => m.index > 0)
    if (!hits.length) { repaired.push(host); continue }
    // Every letter printed inside the run must be the next letter, and one that is missing.
    const pieces = []
    let letter = host.marker, from = 0
    for (const m of hits) {
      const next = String.fromCharCode(letter.charCodeAt(0) + 1)
      if (m[1] !== next || !missing.includes(next)) return null
      pieces.push({ marker: letter, text: host.text.slice(from, m.index) })
      letter = next; from = m.index + m[0].length
    }
    pieces.push({ marker: letter, text: host.text.slice(from) })
    if (pieces.some(p => !p.text.trim())) return null
    pieces.forEach((p, i) => repaired.push(i === 0 ? { ...host, text: p.text.trim() } : { ...host, marker: p.marker, text: p.text.trim(), at: null }))
    hits.forEach((m, i) => records.push({ kind: 'SPLIT_AT_INLINE_MARKER', host: pieces[i].marker, marker: m[1], source: host.text }))
  }
  if (records.length !== missing.length) return null
  repaired.sort((x, y) => x.marker.localeCompare(y.marker))
  if (repaired.map(o => o.marker).join('') !== 'ABCD') return null
  return { options: repaired, record: records[0], records }
}

// B4.8.2 — English option text for options printed ONLY as numbers in the legacy Telugu font
// ("A" + ") 1921" in the Telugu font, Q125). The run between the option's marker and the next marker on
// the same line is decoded with decodeNeutralNumeric (digits and number punctuation only) and used only
// when every check holds:
//   * the English option is empty and the run is entirely legacy-font glyphs of that restricted class;
//   * nothing else is printed within the option's span on a nearby line (±9 pt): no exponent,
//     subscript or fraction part, so stacked mathematics is never flattened (Q124 "10" with exponents
//     is refused);
//   * the recovered values of one question are all different.
// The option records where its text came from; nothing Telugu-linguistic is ever copied.
export const TEXT_FROM_LEGACY_GLYPH_DIGITS = 'TEXT_FROM_LEGACY_GLYPH_DIGITS'
export function recoverNeutralNumericOptions(options, segLines, fontScriptMap, { band = 9 } = {}) {
  const legacy = it => itemScript(it, fontScriptMap) === 'TELUGU_LEGACY'
  const recovered = []
  for (const o of options) {
    if (o.text || !o.at) continue
    const { page, column, x, y } = o.at
    const line = segLines.find(l => l.page === page && l.column === column && Math.abs(l.y - y) <= 1.5)
    if (!line) continue
    const nextX = Math.min(...options.filter(p => p !== o && p.at && p.at.page === page && p.at.column === column
      && Math.abs(p.at.y - y) <= 1.5 && p.at.x > x).map(p => p.at.x), Infinity)
    const span = line.items.filter(it => (it.x > x + 1 || (isMathItem(it) && it.x >= x)) && it.x < nextX - 0.5 && !/^[A-D1-4]\s*[).]?$/.test(it.str.trim()))
    // B4.8.3B: a span may also hold maths reconstructed from the same legacy digits (") 10" + raised "21"
    // -> \(10^{21}\)); every piece must still be proven digits or reconstructed maths.
    const withMath = span.some(isMathItem)
    if (!span.length || !span.every(it => legacy(it) || isMathItem(it))) continue
    const stacked = segLines.some(l => l !== line && l.page === page && l.column === column && Math.abs(l.y - y) < band
      && l.items.some(it => it.x + (it.width || 0) > x && it.x < nextX))
    if (stacked) continue
    const value = withMath ? neutralSpanValue(span, legacy) : decodeNeutralNumeric(span.sort((a, b) => a.x - b.x).map(it => it.str).join(''))
    if (value) recovered.push({ o, value })
  }
  if (!recovered.length || new Set(recovered.map(r => r.value)).size !== recovered.length) return []
  for (const { o, value } of recovered) { o.text = value; o.textSource = TEXT_FROM_LEGACY_GLYPH_DIGITS }
  return recovered.map(r => r.o.marker)
}

// B4.8.3B — the page model's math evidence (scripts/lib/math-notation.mjs) that belongs to THIS question:
// the evidence's baseline must be one of the question's own lines (same page, same column, ±1.5 pt).
// Each entry gets its side (en / te: the line carries legacy Telugu glyphs) and its owner (the option
// whose marker precedes it on that line, an option continued from an earlier line, or the stem).
export function assignNotation(seg, options, stemBoundary, pages, columns) {
  const out = []
  const colOf = x => (columns || []).find(c => x >= c.from && x < c.to)?.index
  for (const page of new Set(seg.lines.map(l => l.page))) {
    const evidence = pages.find(p => p.page === page)?.notation || []
    for (const ev of evidence) {
      const col = colOf(ev.x)
      const line = seg.lines.find(l => l.page === page && (col === undefined || l.column === col) && Math.abs(l.y - ev.lineY) <= 1.5)
      if (!line) continue
      let owner = 'stem'
      const optionLine = options.some(o => o.at && o.at.page === page && o.at.column === line.column && Math.abs(o.at.y - line.y) <= 1.5)
      const onLine = options.filter(o => o.at && o.at.page === page && o.at.column === line.column && Math.abs(o.at.y - line.y) <= 1.5 && o.at.x <= ev.x)
        .sort((a, b) => b.at.x - a.at.x)[0]
      if (onLine) owner = onLine.marker
      else if (stemBoundary && readingCompare(line, stemBoundary.line) > 0) {
        const before = options.filter(o => o.at && readingCompare(o.at.line || o.at, line) <= 0).pop()
        owner = before ? before.marker : 'stem'
      }
      // Side: a line that carries the ENGLISH option markers is English content even when a Telugu-only
      // option shares it (Q60 "C) 16 [½]  D) ఏదికాదు"); otherwise a line with legacy glyphs is Telugu.
      const side = optionLine ? 'en' : ev.te ? 'te' : 'en'
      const anchor = ev.kind === 'IMAGE' && side === 'en' ? imageAnchor(line, ev, owner, options) : undefined
      out.push({ ...ev, side, owner: side === 'te' ? null : owner, ...(anchor !== undefined ? { anchor } : {}) })   // Telugu units are resolved by telugu-structure
    }
  }
  return out
}

// B4.8.3C: where a bitmap sits inside its owner's English text — the owner's text on the same line just
// before and just after it (e.g. Q60 A: before "15", after ""; Q67 stem: "... at the rate of 12" | "% is?").
// A later recovery may insert a verified value only where this anchor matches the stored text exactly
// once; otherwise it refuses. Null when the line carries glyphs that are never stored as text.
export function imageAnchor(line, ev, owner, options) {
  const items = line.items
  // The option markers printed on THIS line, found by position (the option parser may hold its own
  // copies of the line objects, so identity and item indexes are not comparable).
  const markerIdx = options.filter(o => o.at && o.at.page === line.page && o.at.column === line.column && Math.abs(o.at.y - line.y) <= 1.5)
    .map(o => ({ marker: o.marker, idx: items.findIndex(it => Math.abs(it.x - o.at.x) <= 0.5 && readOptionMarker(it.str)) }))
    .filter(m => m.idx >= 0).sort((a, b) => a.idx - b.idx)
  const own = owner !== 'stem' ? markerIdx.find(m => m.marker === owner) : null
  if (owner !== 'stem' && !own && markerIdx.length) return null      // the owner's marker is elsewhere: refuse
  const from = own ? own.idx + 1 : 0
  const nextMarker = markerIdx.find(m => m.idx >= from && items[m.idx].x > ev.x)
  const to = nextMarker ? nextMarker.idx : items.length
  // Legacy-glyph runs are never stored as text (e.g. Q75's unit "మీ॥" after "35 [√3]"), so they are
  // not part of the anchor either.
  const span = items.slice(from, to).filter(it => !isBlank(it) && !PRIVATE_USE.test(it.str))
  const inline = own ? readOptionMarker(items[own.idx].str)?.text || null : null
  const right = ev.x + (ev.box?.w ?? 0)
  const before = [inline, ...span.filter(it => it.x + (it.width || 0) <= ev.x + 1).map(it => it.str)].filter(Boolean).join(' ')
  const after = span.filter(it => it.x >= right - 1).map(it => it.str).join(' ')
  const norm = s => s.replace(/\s+/g, ' ').trim()
  if (PRIVATE_USE.test(before)) return null            // an inline marker item carrying glyphs
  return { before: norm(before).slice(-40), after: norm(after).slice(0, 40) }
}

// Blocking reasons from English-side evidence (Telugu-side evidence flags the Telugu OCR units instead,
// see telugu-structure/telugu-stage). Reconstructed maths is provenance, never a reason.
export function notationReasons(notation = []) {
  const en = notation.filter(n => n.side === 'en')
  const reasons = []
  const imageOptions = [...new Set(en.filter(n => n.kind === 'IMAGE' && n.owner !== 'stem').map(n => n.owner))].sort()
  if (imageOptions.length) reasons.push(`NOTATION_IMAGE_IN_OPTIONS(${imageOptions.join(',')})`)
  if (en.some(n => n.kind === 'IMAGE' && n.owner === 'stem')) reasons.push('NOTATION_IMAGE_IN_STEM')
  const unresolved = [...new Set(en.filter(n => n.kind === 'UNRESOLVED').map(n => n.owner))].sort()
  if (unresolved.length) reasons.push(`NOTATION_TEXT_UNRESOLVED(${unresolved.join(',')})`)
  const stubs = [...new Set(en.filter(n => n.kind === 'STUB' && !n.covered).map(n => n.owner))].sort()
  if (stubs.length) reasons.push(`NOTATION_PLACEHOLDER_UNRESOLVED(${stubs.join(',')})`)
  return reasons
}

// Reading order: page, then column, then top-down.
export const readingCompare = (a, b) => (a.page - b.page) || (a.column - b.column) || (b.y - a.y)

// The English STEM as its own field: clean English items that come before the option set in
// reading order. Latin fragments that shared a line with Telugu (fromMixedLine) belong to the
// Telugu block and are never stem text. Only the leading question-number token is removed —
// no pattern deletion is applied to the stem's prose.
export function extractEnglishStem(englishLines, stemBoundary, { numberX = null, numberXTolerance = 8 } = {}) {
  const parts = []
  let first = true
  for (const line of englishLines) {
    if (line.fromMixedLine) continue
    let items = line.items
    if (stemBoundary) {
      if (line === stemBoundary.line) items = items.slice(0, stemBoundary.itemIndex)
      else if (readingCompare(line, stemBoundary.line) > 0) continue
    }
    for (const it of items) {
      let s = it.str
      if (first) {
        first = false
        if (numberX !== null && Math.abs(it.x - numberX) <= numberXTolerance) {
          if (QUESTION_NUMBER.test(s.trim())) continue
          s = s.replace(/^\s*\d{1,3}\s*[.)]\s*/, '')
        }
      }
      parts.push(s)
    }
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

const BARE_LETTER = /^([A-D])$/
export function findBareMarkerSet(lines, { minGapPt = 10 } = {}) {
  for (const line of lines) {
    const letters = line.items.filter(i => BARE_LETTER.test(i.str.trim()))
    if (letters.length !== 4) continue
    const seq = letters.map(i => i.str.trim().toUpperCase())
    if (seq.join('') !== 'ABCD') continue                                   // ordered set only
    const xs = letters.map(i => i.x)
    if (xs.some((x, k) => k > 0 && x - xs[k - 1] < minGapPt)) continue      // real separation
    const otherLatin = line.items.filter(i => !BARE_LETTER.test(i.str.trim()) && /[A-Za-z]/.test(i.str))
    if (otherLatin.length) continue                                         // markers only
    return letters.map((i, k) => ({ marker: seq[k], x: i.x, y: line.y, page: line.page, column: line.column, parts: [], itemIndex: line.items.indexOf(i), line, bare: true }))
  }
  return []
}

export const boundingBox = (lines) => {
  if (!lines.length) return null
  const byPage = new Map()
  for (const l of lines) {
    const b = byPage.get(l.page) || { page: l.page, x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }
    b.x0 = Math.min(b.x0, l.x); b.x1 = Math.max(b.x1, l.right)
    b.y0 = Math.min(b.y0, l.y - 6); b.y1 = Math.max(b.y1, l.y + 12)
    byPage.set(l.page, b)
  }
  return [...byPage.values()]
}

// ---------- figures ----------------------------------------------------------------
// Decoration = the same rectangle on many pages (logos, rules, headers).
export function findDecorationSignatures(pages, { pageShare = 0.5 } = {}) {
  const counts = new Map()
  for (const page of pages) {
    const seen = new Set()
    for (const im of page.images || []) {
      const sig = `${Math.round(im.x / 4)}:${Math.round(im.y / 4)}:${Math.round(im.w / 4)}:${Math.round(im.h / 4)}`
      if (!seen.has(sig)) { counts.set(sig, (counts.get(sig) || 0) + 1); seen.add(sig) }
    }
  }
  const threshold = Math.max(2, Math.ceil(pages.length * pageShare))
  return new Set([...counts.entries()].filter(([, n]) => n >= threshold).map(([sig]) => sig))
}

export function imageSignature(im) {
  return `${Math.round(im.x / 4)}:${Math.round(im.y / 4)}:${Math.round(im.w / 4)}:${Math.round(im.h / 4)}`
}

// This paper embeds no figure XObjects or vector paths (verified: the only image objects are
// an identical background on every page, and there are zero path operators). A figure is
// therefore detected geometrically: a tall vertical gap between consecutive text lines
// INSIDE a question block, in the same column. B4.3 will crop exactly this rectangle.
export function findFigureGaps(question, columns, { minGapPt = 28, lineHeight = 12 } = {}) {
  const gaps = []
  const byColumn = new Map()
  for (const line of question.lines) {
    const key = `${line.page}:${line.column}`
    if (!byColumn.has(key)) byColumn.set(key, [])
    byColumn.get(key).push(line)
  }
  for (const [key, lines] of byColumn) {
    const sorted = lines.slice().sort((a, b) => b.y - a.y)
    for (let i = 0; i + 1 < sorted.length; i++) {
      const gap = sorted[i].y - sorted[i + 1].y - lineHeight
      if (gap < minGapPt) continue
      const [page, column] = key.split(':').map(Number)
      const col = (columns || []).find(c => c.index === column)
      gaps.push({
        page,
        column,
        x: col ? col.from : Math.min(sorted[i].x, sorted[i + 1].x),
        y: sorted[i + 1].y + lineHeight,
        w: col ? (col.to - col.from) : Math.max(sorted[i].right, sorted[i + 1].right) - Math.min(sorted[i].x, sorted[i + 1].x),
        h: gap,
        between: [sorted[i].text.slice(0, 40), sorted[i + 1].text.slice(0, 40)],
      })
    }
  }
  return gaps
}

// A raster page is a page printed as a picture: full-width image strips (not decoration) that together
// cover most of the page, with the text layer on top. Its strips are the page itself, not figures.
const RASTER_STRIP_WIDTH = 0.85
const isPageStrip = (im, page) => im.w >= page.widthPt * RASTER_STRIP_WIDTH
export function findRasterPages(pages, decorations, { minCover = 0.8 } = {}) {
  const raster = []
  for (const page of pages) {
    const strips = (page.images || []).filter(im => !decorations.has(imageSignature(im)) && isPageStrip(im, page))
    if (!strips.length) continue
    const spans = strips.map(im => [Math.max(0, im.y), Math.min(page.heightPt, im.y + im.h)]).sort((a, b) => a[0] - b[0])
    let covered = 0, end = -Infinity
    for (const [from, to] of spans) { if (to > end) { covered += to - Math.max(from, end); end = to } }
    const width = Math.min(page.widthPt, ...strips.map(im => im.w))
    if ((covered * width) / (page.widthPt * page.heightPt) >= minCover) raster.push(page.page)
  }
  return raster
}

export function attachVisuals(question, pages, decorations, { minSize = 40, maxPageArea = 0.8, minContainment = 0.8, rasterPages = [] } = {}) {
  const boxes = boundingBox(question.lines) || []
  const attached = [], rejected = []
  for (const box of boxes) {
    const page = pages.find(p => p.page === box.page)
    for (const im of page?.images || []) {
      const sig = imageSignature(im)
      const area = im.w * im.h
      if (decorations.has(sig)) { rejected.push({ page: box.page, reason: 'DECORATION', im }); continue }
      if (rasterPages.includes(box.page) && isPageStrip(im, page)) { rejected.push({ page: box.page, reason: 'RASTER_PAGE_STRIP', im }); continue }
      if (im.w < minSize || im.h < minSize) { rejected.push({ page: box.page, reason: 'TOO_SMALL', im }); continue }
      if (area > page.widthPt * page.heightPt * maxPageArea) { rejected.push({ page: box.page, reason: 'PAGE_SIZED', im }); continue }
      const ox = Math.max(0, Math.min(im.x + im.w, box.x1) - Math.max(im.x, box.x0))
      const oy = Math.max(0, Math.min(im.y + im.h, box.y1) - Math.max(im.y, box.y0))
      const containment = area ? (ox * oy) / area : 0
      if (containment >= minContainment) attached.push({ page: box.page, containment, im })
      else if (containment > 0) rejected.push({ page: box.page, reason: 'PARTIAL_CONTAINMENT', containment, im })
    }
  }
  return { attached, rejected }
}

// ---------- shared material ------------------------------------------------------------
// segmentQuestions ends a question at a "Directions" line and gives the following lines to no
// question. Those unowned lines are SHARED MATERIAL (instructions, passages, data, figures)
// governing one or more following questions. They become explicit records here.
//
// Ownership is decided only from evidence in the heading:
//   HEADING_RANGE          "(Q. Nos. 31-33)", "(Q. No.s 11 and 12)", "(81-84 Q. No.s)"
//   SINGULAR_NEXT_QUESTION "In the question ...", "In the following question ..." -> the next one
// Anything else is left UNLINKED and routed to review; nothing is guessed.
const MATERIAL_TYPES = [
  [/\bpassage\b/i, 'PASSAGE'], [/\bpie[- ]?charts?\b|\bcharts?\b|\bgraphs?\b/i, 'CHART'],
  [/\bdiagram\b|\bfigure\b/i, 'DIAGRAM'], [/\btable\b/i, 'TABLE'],
  // "given data" / "information" blocks are text (rules, statements), not tables: typed OTHER.
  [/\bgiven data\b|\binformation\b/i, 'OTHER'],
]
const SINGULAR_QUESTION = /\b(?:the|following|this)\s+question\b(?!s)|\bquestion\s+(?:below|given below)\b/i

export function parseMaterialRange(heading) {
  const ranged = RANGED_MATERIAL.exec(heading)
  if (ranged) {
    const a=Number(ranged[1]),b=Number(ranged[2])
    if(a>=1&&b>=a&&b<=300&&b-a<=12)return {covers:Array.from({length:b-a+1},(_,i)=>a+i),rangeSource:'HEADING_RANGE'}
    return {covers:[],rangeSource:'UNKNOWN'}
  }
  const explicit = /^directions?\s*(?:Q\.?\s*)?(\d{1,3})\s*:/i.exec(heading)
  if (explicit) return { covers: [Number(explicit[1])], rangeSource: 'HEADING_RANGE' }
  const paren = /\(([^)]*\d[^)]*)\)/.exec(heading)
  if (paren) {
    const nums = (paren[1].match(/\d{1,3}/g) || []).map(Number)
    if (nums.length >= 2 && /-|–|\bto\b/i.test(paren[1])) {
      const [a, b] = [Math.min(...nums), Math.max(...nums)]
      if (b - a <= 12) return { covers: Array.from({ length: b - a + 1 }, (_, k) => a + k), rangeSource: 'HEADING_RANGE' }
    }
    if (nums.length >= 2) return { covers: [...new Set(nums)].sort((x, y) => x - y), rangeSource: 'HEADING_RANGE' }
    if (nums.length === 1) return { covers: nums, rangeSource: 'HEADING_RANGE' }
  }
  if (SINGULAR_QUESTION.test(heading)) return { covers: null, rangeSource: 'SINGULAR_NEXT_QUESTION' }
  return { covers: [], rangeSource: 'UNKNOWN' }
}

const LINE_TOP = 12        // a line's top above its baseline, as in boundingBox
const COLUMN_FOOT = 0.035  // below this share of the page height is the running footer
const COLUMN_HEAD = 0.965  // above this share is the running header (the limit buildLines uses)
const FIGURE_ROOM = 28     // the smallest gap that can hold a figure, as in findFigureGaps
export function extractMaterials(ordered, segments, fontScriptMap, pages = []) {
  const pageHeight = new Map(pages.map(p => [p.page, p.heightPt]))
  const owned = new Set(segments.flatMap(s => s.lines))
  const indexOf = new Map(ordered.map((l, i) => [l, i]))
  const blocks = []
  let cur = null
  const unowned = ordered.filter(l => !owned.has(l))
  // A heading that states which questions it governs always opens its own block.
  const statesRange = line => {
    const next = unowned[unowned.indexOf(line) + 1]
    const text = [line, ...(next && indexOf.get(next) === indexOf.get(line) + 1 ? [next] : [])].map(l => l.text).join(' ')
    return parseMaterialRange(text).rangeSource !== 'UNKNOWN'
  }
  let material = false
  for (const line of ordered) {
    if (owned.has(line)) { cur = null; continue }
    const heading = isMaterialHeading(line.text)
    // Text that is not material (a cover page, loose instructions) ends at the next heading and at a page
    // change, so it cannot swallow the material that follows it. A passage may run over a page break; inside
    // it only a heading with its own range starts a new material.
    const opens = !cur || (material ? heading && statesRange(line) : heading || line.page !== cur[cur.length - 1].page)
    if (opens) { cur = []; blocks.push(cur); material = heading }
    cur.push(line)
  }
  const materials = []
  for (const lines of blocks) {
    if (!isMaterialHeading(lines[0].text)) continue         // e.g. the cover page: not material
    const lastIndex = indexOf.get(lines[lines.length - 1])
    const next = segments.find(s => indexOf.get(s.lines[0]) > lastIndex)
    const heading = lines.slice(0, 2).map(l => l.text).join(' ')
    const { english, telugu } = splitLanguageRuns({ lines }, fontScriptMap)
    const clean = english.filter(l => !l.fromMixedLine)
    const englishItems = clean.flatMap(l => l.items.map(it => ({ str: it.str, x: it.x, y: it.y, width: it.width || 0, height: it.height || 10, page: l.page, column: l.column })))
    const byRegion = new Map()
    for (const l of lines) {
      const k = `${l.page}:${l.column}`
      const r = byRegion.get(k) || { page: l.page, column: l.column, x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }
      for (const it of l.items) {
        const h = it.height || 10
        r.x0 = Math.min(r.x0, it.x); r.x1 = Math.max(r.x1, it.x + (it.width || 0))
        r.y0 = Math.min(r.y0, it.y - h * 0.5); r.y1 = Math.max(r.y1, it.y + h * 1.05)
      }
      byRegion.set(k, r)
    }
    // A figure, table or diagram printed between the material's text and its first question has no text
    // of its own. Each part therefore reaches down to the next line below it in its column that belongs
    // to something else (the first question, another material). A part with nothing below it continues
    // in the next column: it reaches the foot of its column when there is room for a figure there.
    // The same holds at the head of the column the material continues into: a part there reaches up to
    // the head of the column, and when the material has no text there at all (only its figure, above the
    // first question) that space becomes a part of its own. A part never enters another question's or
    // material's lines, and the first part's top never moves.
    const own = new Set(lines)
    const foreign = (r, where) => ordered.filter(l => !own.has(l) && l.page === r.page && l.column === r.column && where(l))
    const parts = [...byRegion.values()]
    parts.forEach((r, i) => {
      const height = pageHeight.get(r.page)
      const below = foreign(r, l => l.y < r.y0)
      const foot = height ? height * COLUMN_FOOT : null
      r.y0 = Math.min(r.y0, below.length ? Math.max(...below.map(l => l.y + LINE_TOP)) : foot !== null && r.y0 - foot >= FIGURE_ROOM ? foot : r.y0)
      const head = height ? height * COLUMN_HEAD : null
      if (i > 0 && head !== null && head - r.y1 >= FIGURE_ROOM && !foreign(r, l => l.y > r.y1).length) r.y1 = head
    })
    const start = next?.lines[0], startHeight = start && pageHeight.get(start.page)
    if (start && startHeight && !byRegion.has(`${start.page}:${start.column}`)) {
      const top = start.y + LINE_TOP, head = startHeight * COLUMN_HEAD
      const above = ordered.some(l => l.page === start.page && l.column === start.column && l.y > start.y)
      const sameColumn = next.lines.filter(l => l.page === start.page && l.column === start.column)
      if (!above && head - top >= FIGURE_ROOM) byRegion.set(`${start.page}:${start.column}`, { page: start.page, column: start.column,
        x0: Math.min(...sameColumn.map(l => l.x)), x1: Math.max(...sameColumn.map(l => l.right)), y0: top, y1: head })
    }
    let range = parseMaterialRange(heading)
    // "Directions:" with no range, directly before a question the paper prints as an English part and then,
    // under the same number again, its Telugu part: the number restarts only because the directions are
    // for that one question, so they stay with it.
    if (range.rangeSource === 'UNKNOWN' && next?.teluguHalfMerged) range = { covers: null, rangeSource: 'SINGULAR_NEXT_QUESTION' }
    const reviewReasons = []
    let covers = range.covers
    if (range.rangeSource === 'SINGULAR_NEXT_QUESTION') covers = next ? [next.number] : []
    if (range.rangeSource === 'UNKNOWN') reviewReasons.push('MATERIAL_RANGE_UNKNOWN')
    // The stated range must start at the question that immediately follows the block.
    if (covers.length && next && covers[0] !== next.number) { reviewReasons.push(`MATERIAL_RANGE_NOT_ADJACENT(${covers.join(',')} vs next ${next.number})`); covers = [] }
    if (covers.length && !covers.every(n => segments.some(s => s.number === n))) { reviewReasons.push('MATERIAL_RANGE_QUESTION_MISSING'); covers = [] }
    if (telugu.length) reviewReasons.push('TELUGU_MATERIAL_TEXT_NOT_EXTRACTED')
    materials.push({
      index: materials.length,
      heading: heading.slice(0, 200),
      materialType: (MATERIAL_TYPES.find(([re]) => re.test(heading)) || [null, 'INSTRUCTIONS'])[1],
      pages: [...new Set(lines.map(l => l.page))],
      sourceRegions: [...byRegion.values()].map(r => ({ page: r.page, column: r.column, x: r.x0, y: r.y0, w: r.x1 - r.x0, h: r.y1 - r.y0 })),
      englishText: clean.map(l => l.text).join(' ').replace(/\s+/g, ' ').trim(),
      englishItems,
      teluguRegions: (boundingBox(telugu) || []).map(b => ({ page: b.page, x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0, lines: telugu.filter(l => l.page === b.page).length })),
      lineCount: lines.length,
      covers,
      rangeSource: covers.length ? range.rangeSource : 'UNLINKED',
      confidence: !covers.length ? 0 : range.rangeSource === 'HEADING_RANGE' ? 0.95 : 0.85,
      reviewReasons,
    })
  }
  // One question takes at most one shared material (draft_questions.shared_material_id).
  const claimed = new Map()
  for (const m of materials) for (const n of m.covers) {
    if (claimed.has(n)) { m.reviewReasons.push(`MATERIAL_OVERLAPS_Q${n}`); materials[claimed.get(n)].reviewReasons.push(`MATERIAL_OVERLAPS_Q${n}`) }
    else claimed.set(n, m.index)
  }
  return materials
}

// ---------- answer key ---------------------------------------------------------------
const KEY_PAIR = /(\d{1,3})\s*[).:\-]\s*([A-D])(?![A-Za-z])/g

export function findAnswerKeyPage(pages, linesByPage) {
  let best = null
  for (const page of pages) {
    const text = (linesByPage.get(page.page) || []).map(l => l.text).join(' ')
    const pairs = [...text.matchAll(KEY_PAIR)]
    const hasQuestions = /\b(A\)|B\)|C\)|D\))/.test(text) && pairs.length < 10
    if (pairs.length >= 20 && !hasQuestions && (!best || pairs.length > best.pairs.length)) {
      best = { page: page.page, pairs }
    }
  }
  return best
}

export function parseAnswerKey(keyPage) {
  if (!keyPage) return { entries: [], duplicates: [] }
  const entries = [], seen = new Map(), duplicates = []
  for (const m of keyPage.pairs) {
    const number = Number(m[1]); const letter = m[2].toUpperCase()
    if (seen.has(number)) { duplicates.push(number); continue }
    seen.set(number, letter)
    entries.push({ number, letter, position: 'ABCD'.indexOf(letter) })
  }
  return { entries: entries.sort((a, b) => a.number - b.number), duplicates }
}

// ---------- confidence ----------------------------------------------------------------
// ("map" is deliberately absent: it was never a trigger, and "a military secret service map" (Q23) is
// a direction-sense question, not a figure.)
export const FIGURE_WORDS = /\b(figures?|diagrams?|triangles?|graphs?|charts?|pie[- ]?charts?|bar[- ]?graphs?|venn)\b/i
export const FIGURE_PHRASES = /\b(images?|pictures?|(?:shown|given) below)\b/i

export function scoreQuestion(q, { expectedNumber, keyEntry, columnConfident }) {
  const reasons = []
  if (!columnConfident) reasons.push('COLUMN_MODEL_UNCERTAIN')
  if (expectedNumber !== undefined && q.number !== expectedNumber) reasons.push(`NUMBER_SEQUENCE_GAP(expected ${expectedNumber}, got ${q.number})`)
  const stemText = q.englishStem ?? q.englishText
  if (!stemText || stemText.length < 10) reasons.push('ENGLISH_STEM_MISSING_OR_SHORT')
  if (q.options.length === 0) reasons.push('NO_OPTIONS')
  else if (q.options.length < 4) reasons.push(`FEWER_THAN_4_OPTIONS(${q.options.length})`)
  else if (q.options.length > 4) reasons.push(`MORE_THAN_4_OPTIONS(${q.options.length})`)
  if (q.optionDuplicates > 0) reasons.push('DUPLICATE_OPTION_MARKERS')
  // B4.8.2 diagnostic: two options extracted with the same text (Q75 "70"/"70", Q50 "2 km"/"2 km") mean
  // notation was lost (radicals, fractions). A real question never offers the same answer twice.
  const texts = q.options.map(o => (o.text || '').trim().toLowerCase()).filter(Boolean)
  if (new Set(texts).size !== texts.length) reasons.push('DUPLICATE_OPTION_TEXT')
  if (q.unassignedEnglish) reasons.push('UNASSIGNED_TEXT_AFTER_OPTIONS')
  if (q.options.some(o => !o.text)) reasons.push('EMPTY_OPTION_TEXT')
  if (q.teluguRegions.length === 0) reasons.push('NO_TELUGU_REGION')
  if (!keyEntry) reasons.push('NO_ANSWER_KEY_ENTRY')
  if (q.visuals.rejected.some(r => r.reason === 'PARTIAL_CONTAINMENT')) reasons.push('VISUAL_PARTIALLY_CONTAINED')
  // B4.8.2: figure expectation from whole trigger WORDS in the question's own stem (option text such as
  // "Geographical Indications" is not a request for a figure). A strong word alone still flags a missing
  // figure; weak phrases ("images", "given below", "shown below") never do on their own — they only
  // count together with layout evidence (a figure gap), which is then confirmed by the teacher.
  const cueText = q.englishStem || q.englishText || ''
  const strongCue = FIGURE_WORDS.test(cueText)
  const weakCue = FIGURE_PHRASES.test(cueText)
  const hasVisualCandidate = q.visuals.attached.length > 0 || q.visuals.figureGaps.length > 0
  if (strongCue && !hasVisualCandidate) reasons.push('VISUAL_EXPECTED_BUT_NONE_FOUND')
  if ((strongCue || weakCue) && q.visuals.figureGaps.length > 0) reasons.push('VISUAL_FROM_LAYOUT_GAP_NEEDS_CONFIRMATION')
  // B4.8.3B: maths the text layer does not carry (bitmaps, lost equation objects, unprovable raised or
  // stacked digits) blocks the question even when ordinary text is present — never silently READY.
  reasons.push(...notationReasons(q.notation))
  // The page is a picture in the PDF: its strips say nothing about figures, so the teacher looks once.
  if (q.rasterPage) reasons.push('RASTER_PAGE')
  const blocking = reasons.filter(r => !r.startsWith('NO_TELUGU_REGION'))
  const status = blocking.length === 0 ? 'READY' : (q.options.length >= 2 ? 'NEEDS_REVIEW' : 'UNRESOLVED')
  return { status, reviewReasons: reasons }
}

// ---------- top level ------------------------------------------------------------------
export function analysePaper(pages, { expectedQuestions = null } = {}) {
  const fontScriptMap = buildFontScriptMap(pages)
  const decorations = findDecorationSignatures(pages)
  const rasterPages = findRasterPages(pages, decorations)
  // One column grid for the whole paper, from question-number x clusters.
  const paperColumns = detectColumnsFromNumbers(pages)
  const linesByPage = new Map()
  const columnByPage = new Map()
  let allLines = []
  for (const page of pages) {
    const columnModel = paperColumns || detectColumns(page)
    columnByPage.set(page.page, columnModel)
    const lines = buildLines(page, columnModel)
    linesByPage.set(page.page, lines)
    allLines = allLines.concat(lines)
  }
  const columns = (paperColumns || columnByPage.get(pages[0]?.page))?.columns || []

  const keyPage = findAnswerKeyPage(pages, linesByPage)
  const answerKey = parseAnswerKey(keyPage)
  const keyByNumber = new Map(answerKey.entries.map(e => [e.number, e]))

  // Questions are segmented over the whole paper in reading order, excluding the key page.
  const ordered = readingOrder(allLines.filter(l => !keyPage || l.page !== keyPage.page))
  const starts = findQuestionStarts(ordered, columns)
  const segments = mergeTeluguRepeats(segmentQuestions(ordered, starts), ordered, fontScriptMap)

  const questions = segments.map(seg => {
    const { english, telugu } = splitLanguageRuns(seg, fontScriptMap)
    const englishText = english.map(l => l.text).join(' ').replace(/^\d{1,3}\s*[.)]\s*/, '').trim()
    const startColumn = columns.find(c => c.index === seg.startLine?.column)
    const { options, markerSequence, duplicates, stemBoundary, unassignedAfterOptions, optionRepairs, optionSetSource } = parseOptions(english, { numberX: startColumn?.numberX ?? null, teluguLines: telugu })
    const glyphDigitMarkers = duplicates ? [] : recoverNeutralNumericOptions(options, seg.lines, fontScriptMap)
    if (glyphDigitMarkers.length) optionRepairs.push({ kind: TEXT_FROM_LEGACY_GLYPH_DIGITS, markers: glyphDigitMarkers })
    const notation = assignNotation(seg, options, stemBoundary, pages, columns)
    const englishStem = extractEnglishStem(english, stemBoundary, { numberX: startColumn?.numberX ?? null })
    const teluguRegions = (boundingBox(telugu) || []).map(b => ({
      page: b.page, x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0, lines: telugu.filter(l => l.page === b.page).length,
    }))
    const visuals = attachVisuals(seg, pages, decorations, { rasterPages })
    const figureGaps = findFigureGaps(seg, columns)
    const keyEntry = keyByNumber.get(seg.number) || null
    // Printed-source delivery must preserve reading order across columns. A
    // page-wide bounding box would include unrelated questions between them.
    const printedRegions = new Map()
    for (const line of seg.lines) {
      const key = `${line.page}:${line.column}`
      if (!printedRegions.has(key)) printedRegions.set(key, [])
      printedRegions.get(key).push(line)
    }
    const q = {
      number: seg.number,
      pages: seg.pages,
      columns: seg.columns,
      bbox: boundingBox(seg.lines) || [],
      sourceRegions: [...printedRegions.entries()].flatMap(([key, lines]) => (boundingBox(lines) || []).map(b => ({ ...b, column: Number(key.split(':')[1]) }))),
      crossColumn: seg.columns.length > 1,
      crossPage: seg.pages.length > 1,
      englishText,          // every English line incl. options (diagnostic; B4.3/B4.4 evidence)
      englishStem,          // the stem only — what the Draft stores as question content
      unassignedEnglish: unassignedAfterOptions,   // English after the options owned by no option
      options: options.map(o => ({ position: o.position, marker: o.marker, text: o.text, ...(o.textSource ? { textSource: o.textSource } : {}) })),
      markerSequence,
      optionRepairs,        // B4.8.2 provenance: SPLIT_AT_INLINE_MARKER / TEXT_FROM_LEGACY_GLYPH_DIGITS
      ...(optionSetSource ? { optionSetSource } : {}),   // which printed A-D set is the options, when a question prints more than one
      notation,             // B4.8.3B: math evidence of this question (reconstructed / bitmap / stub / unresolved)
      optionDuplicates: duplicates,
      teluguRegions,
      teluguLineCount: telugu.length,
      visuals: {
        attached: visuals.attached.map(v => ({ page: v.page, containment: Number(v.containment.toFixed(2)), rect: v.im })),
        rejected: visuals.rejected.map(v => ({ page: v.page, reason: v.reason, rect: v.im })),
        figureGaps: figureGaps.map(g => ({ page: g.page, column: g.column, x: Math.round(g.x), y: Math.round(g.y), w: Math.round(g.w), h: Math.round(g.h) })),
      },
      proposedAnswer: keyEntry ? { letter: keyEntry.letter, position: keyEntry.position, source: 'ANSWER_KEY_PAGE' } : null,
      ...(seg.pages.some(p => rasterPages.includes(p)) ? { rasterPage: true } : {}),
      ...(seg.teluguHalfMerged ? { teluguHalfMerged: true } : {}),   // English part and, under the same number again, the Telugu part
    }
    return q
  })

  // Shared material (Directions blocks) and the questions that reference it.
  const materials = extractMaterials(ordered, segments, fontScriptMap, pages)
  for (const m of materials) for (const n of m.covers) {
    const q = questions.find(x => x.number === n)
    if (q && q.sharedMaterialIndex === undefined && !m.reviewReasons.some(r => r.startsWith(`MATERIAL_OVERLAPS_Q${n}`))) q.sharedMaterialIndex = m.index
  }

  // Sequence expectations and duplicate numbers.
  const numbers = questions.map(q => q.number)
  const duplicateNumbers = numbers.filter((n, i) => numbers.indexOf(n) !== i)
  const maxNumber = numbers.length ? Math.max(...numbers) : 0
  const expected = expectedQuestions || Math.max(maxNumber, answerKey.entries.length)
  const missingNumbers = []
  for (let n = 1; n <= expected; n++) if (!numbers.includes(n)) missingNumbers.push(n)

  questions.forEach((q, i) => {
    const prev = i > 0 ? questions[i - 1].number : 0
    const verdict = scoreQuestion(q, {
      expectedNumber: prev + 1,
      keyEntry: q.proposedAnswer,
      columnConfident: columnByPage.get(q.pages[0])?.confident ?? false,
    })
    q.status = verdict.status
    q.reviewReasons = verdict.reviewReasons
  })

  const withFour = questions.filter(q => q.options.length === 4)
  const stats = {
    pages: pages.length,
    expectedQuestions: expected,
    questionsDetected: questions.length,
    duplicateNumbers: [...new Set(duplicateNumbers)],
    teluguHalvesMerged: questions.filter(q => q.teluguHalfMerged).map(q => q.number),
    missingNumbers,
    optionsExactlyFour: withFour.length,
    optionsNone: questions.filter(q => q.options.length === 0).length,
    optionsFewerThanFour: questions.filter(q => q.options.length > 0 && q.options.length < 4).length,
    optionsMoreThanFour: questions.filter(q => q.options.length > 4).length,
    teluguRegionsDetected: questions.reduce((n, q) => n + q.teluguRegions.length, 0),
    questionsWithTelugu: questions.filter(q => q.teluguRegions.length > 0).length,
    visualsAttached: questions.reduce((n, q) => n + q.visuals.attached.length, 0),
    figureGapCandidates: questions.reduce((n, q) => n + q.visuals.figureGaps.length, 0),
    questionsWithFigureGap: questions.filter(q => q.visuals.figureGaps.length > 0).length,
    visualsRejectedAsDecoration: questions.reduce((n, q) => n + q.visuals.rejected.filter(r => r.reason === 'DECORATION').length, 0),
    decorationSignatures: decorations.size,
    rasterPages,
    answerKeyPage: keyPage?.page ?? null,
    answerKeyEntries: answerKey.entries.length,
    answerKeyDuplicates: answerKey.duplicates,
    answerKeyUnmapped: answerKey.entries.filter(e => !numbers.includes(e.number)).map(e => e.number),
    crossColumnQuestions: questions.filter(q => q.crossColumn).length,
    sharedMaterials: materials.length,
    sharedMaterialsLinked: materials.filter(m => m.covers.length).length,
    questionsWithSharedMaterial: questions.filter(q => q.sharedMaterialIndex !== undefined).length,
    crossPageQuestions: questions.filter(q => q.crossPage).length,
    ready: questions.filter(q => q.status === 'READY').length,
    needsReview: questions.filter(q => q.status === 'NEEDS_REVIEW').length,
    unresolved: questions.filter(q => q.status === 'UNRESOLVED').length,
  }
  stats.autoRatio = questions.length ? Number((stats.ready / questions.length).toFixed(3)) : 0

  return { stats, questions, materials, answerKey: { page: keyPage?.page ?? null, ...answerKey }, columns: [...columnByPage.entries()].map(([page, m]) => ({ page, ...m })), fontScripts: [...fontScriptMap.entries()] }
}
