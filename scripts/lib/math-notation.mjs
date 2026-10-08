// B4.8.3B — deterministic math notation from the PDF's own text geometry (pure; platform-neutral).
//
// Validated as the B4.8.3A prototype (reports/b483a, docs/ksc/B4.8.3A-MATH-EXTRACTION-INVESTIGATION.md).
// Runs ONCE on the page model, before any stem/option parsing, so every stage (B4.1 layout, B4.3 figures,
// B4.4 Telugu) sees the same text. It never guesses: a value is written only when the evidence is exact.
//
// Reconstructed (rewritten into the host text item as \( … \), which the app's MathText/KaTeX renders):
//   SUPERSCRIPT  a smaller item (≤ 0.8 × host height) raised 3–8 pt that starts where EXACTLY ONE host ends
//                (±1.5 pt). Content: a digit run (Latin, or legacy-font glyphs of the atlas-proven digit class).
//                Host: a number, or a standalone letter (a³); a legacy-font host only when it is entirely
//                proven digits (") 10" -> 10¹⁰). st/nd/rd/th after a digit is typography: "22nd", no maths.
//   STACKED      a numeric item 5–11.5 pt above and one below the same text baseline, centres within 3 pt,
//                each alone on its row (other stacks' parts excepted), AND enclosed together by one
//                equation frame (a path box ≤ 40 pt tall). A digit run ending ≤ 4 pt before the stack makes a
//                mixed number.
// Located, never read (evidence for review; no value is inferred):
//   IMAGE        a non-background image XObject on a text baseline (fractions/radicals drawn as bitmaps).
//   STUB         a ≥ 30 pt whitespace-only item (an equation object's text stub); "covered" when an image
//                sits flush with it on the same line.
//   UNRESOLVED   a raised digit run with no provable host, or a numeric stack part that failed a check,
//                or a raised digit after a Telugu word (the Telugu row comes from OCR, not from items).
// Unicode vulgar fractions (½ ¼ ¾ …) are already exact text and are left as printed.
//
// Output: pages whose `items` carry the rewritten text (consumed parts removed; each rewritten item has
// `math: [{ rule, latex }]`), `inkItems` = the original items (pixel masks must still see every glyph), and
// `notation` = the evidence list. Nothing here reads pixels, writes anything or calls a network.

import { decodeNeutralNumeric } from './telugu-glyph-hybrid.mjs'

export const MATH_NOTATION = 'ksc-math-notation'
export const MATH_NOTATION_VERSION = '1.0.0'
export const MATH_FONT = 'ksc-math'           // synthetic items that carry reconstructed maths

const LEGACY_CHARS = /[-]/
const PAREN = '', SPACE = ''
const ORDINAL = /^(st|nd|rd|th)$/
export const isMathItem = it => it?.fontName === MATH_FONT
// Blank = only whitespace, including the legacy font's space glyph U+F020 (equation stubs are runs of it).
export const isBlank = it => !String(it?.str ?? '').replace(/[\s]/g, '')

// Tunables — the B4.8.3A values; every threshold is a refusal boundary, never a guess.
export const MATH_RULES = Object.freeze({ band: 1.5, supRaise: [3, 8], supRatio: 0.8, flush: 1.5,
  stackOffset: [5, 11.5], stackCentre: 3, stackMaxWidth: 22, mixedGap: 4, frameMaxH: 40 })

// Mathematical content of an item's text: a plain digit run (Latin) or proven legacy digits.
function digitsOf(it, legacy) {
  if (isMathItem(it)) return null
  if (!legacy(it)) return /^\s*\d+(\.\d+)?\s*$/.test(it.str) ? it.str.trim() : null
  const v = decodeNeutralNumeric(it.str, { dropLeadingParen: false })
  return v && /^\d+$/.test(v) ? v : null
}
// A legacy-font run that is entirely proven digits after an optional leading ")" (the bare-marker paren).
function legacyNumeric(it) {
  const paren = it.str.startsWith(PAREN)
  const rest = paren ? it.str.slice(1) : it.str
  const v = decodeNeutralNumeric(rest, { dropLeadingParen: false })
  return v && /^\d+(\.\d+)?$/.test(v) ? { paren, value: v } : null
}
// Does a Telugu (legacy) run END in proven digit glyphs after a space? ("… 45" before a raised 0)
function legacyTrailingDigits(it) {
  const m = new RegExp(`[${SPACE}\\s]([\\uF030-\\uF039\\uF02E]+)$`).exec(it.str)
  return m ? decodeNeutralNumeric(m[1], { dropLeadingParen: false }) : null
}

// pages: page models ({ page, heightPt, items, images, frames }). legacyFonts: Set of legacy font ids.
// columnsOf(page) -> [{ from, to }] (the paper's column grid).
export function applyMathNotation(pages, { legacyFonts, columnsOf, marginTop = 0.965, marginBottom = 0.035 } = {}) {
  const legacy = it => legacyFonts.has(it.fontName) || LEGACY_CHARS.test(it.str)
  return pages.map(page => {
    const cols = columnsOf(page) || [{ from: 0, to: Infinity }]
    const remove = new Set(), rewrite = new Map(), inserted = [], notation = []
    for (const col of cols) {
      const inCol = it => it.x + (it.width || 0) / 2 >= col.from && it.x + (it.width || 0) / 2 < col.to
      const items = page.items.filter(it => !isBlank(it) && inCol(it) && it.y <= page.heightPt * marginTop && it.y >= page.heightPt * marginBottom)
      const stubs = page.items.filter(it => isBlank(it) && (it.height || 0) >= 30 && inCol(it))
      const images = (page.images || []).filter(im => im.w < 300 && im.h < 80 && im.x + im.w / 2 >= col.from && im.x + im.w / 2 < col.to)
      const frames = (page.frames || []).filter(f => f.x + f.w / 2 >= col.from && f.x + f.w / 2 < col.to)
      regionPass({ page, items, images, frames, stubs, legacy, remove, rewrite, inserted, notation })
    }
    if (!remove.size && !rewrite.size && !inserted.length && !notation.length) return page
    const items = []
    for (const it of page.items) {
      if (remove.has(it)) continue
      const r = rewrite.get(it)
      if (r) items.push(...r); else items.push(it)
    }
    items.push(...inserted)
    return { ...page, items, inkItems: page.items, notation }
  })
}

function regionPass({ page, items, images, frames, stubs, legacy, remove, rewrite, inserted, notation }) {
  const R = MATH_RULES
  const bodyH = it => (legacy(it) ? 16 : 12)
  const isBody = it => it.height >= 0.85 * bodyH(it)
  const baselines = []
  for (const it of items.filter(isBody).sort((a, b) => b.y - a.y)) {
    const l = baselines.find(b => Math.abs(b.y - it.y) <= R.band)
    if (l) l.items.push(it); else baselines.push({ y: it.y, items: [it] })
  }
  const lineOf = y => baselines.find(b => Math.abs(b.y - y) <= R.band)
  const teLine = b => b.items.some(legacy)
  const ev = (kind, o) => notation.push({ kind, page: page.page, ...o })
  const used = new Set()

  // ---- superscripts ---------------------------------------------------------------------------
  const supsByHost = new Map()
  for (const s of items.filter(it => !isBody(it))) {
    const d = digitsOf(s, legacy), txt = s.str.trim()
    const hosts = items.filter(h => h !== s && isBody(h) && s.y - h.y >= R.supRaise[0] && s.y - h.y <= R.supRaise[1] && Math.abs(h.x + h.width - s.x) <= R.flush)
    const onLine = baselines.find(b => s.y - b.y >= R.supRaise[0] && s.y - b.y <= R.supRaise[1] && b.items.some(h => h.x <= s.x && h.x + h.width >= s.x - 12))
    if (!hosts.length) { if (d !== null && onLine) ev('UNRESOLVED', { rule: 'SUPERSCRIPT', why: 'NO_HOST', x: s.x, y: s.y, lineY: onLine.y, te: teLine(onLine), text: d }); continue }
    if (hosts.length > 1 || s.height > R.supRatio * hosts[0].height) { if (d !== null) ev('UNRESOLVED', { rule: 'SUPERSCRIPT', why: 'AMBIGUOUS_HOST', x: s.x, y: s.y, lineY: hosts[0].y, te: hosts.some(legacy), text: d }); continue }
    const host = hosts[0]
    if (ORDINAL.test(txt) && !legacy(host) && /\d$/.test(host.str.trim())) { (supsByHost.get(host) || supsByHost.set(host, []).get(host)).push({ s, ordinal: txt }); continue }
    if (d === null) continue                      // not maths (letters, symbols): left untouched
    ;(supsByHost.get(host) || supsByHost.set(host, []).get(host)).push({ s, d })
  }
  for (const [host, sups] of supsByHost) {
    if (sups.length !== 1) { for (const { s, d } of sups) if (d) ev('UNRESOLVED', { rule: 'SUPERSCRIPT', why: 'SEVERAL_ON_ONE_HOST', x: s.x, y: s.y, lineY: host.y, te: legacy(host), text: d }); continue }
    const { s, d, ordinal } = sups[0]
    if (ordinal) { rewrite.set(host, [{ ...host, str: `${host.str.replace(/\s+$/, '')}${ordinal}`, width: s.x + s.width - host.x }]); used.add(s); remove.add(s); continue }
    if (legacy(host)) {
      const n = legacyNumeric(host)
      if (!n) { ev('UNRESOLVED', { rule: 'SUPERSCRIPT', why: legacyTrailingDigits(host) ? 'TELUGU_TEXT_HOST' : 'HOST_NOT_NUMERIC', x: s.x, y: s.y, lineY: host.y, te: true, text: d }); continue }
      const latex = `${n.value}^{${d}}`
      const parts = []
      const w = n.paren ? Math.min(host.width, host.height * 0.45) : 0
      if (n.paren) parts.push({ ...host, str: `${PAREN}${SPACE}`, width: w })
      parts.push({ str: `\\(${latex}\\)`, x: host.x + w, y: host.y, width: s.x + s.width - host.x - w, height: 12, fontName: MATH_FONT, dir: host.dir, math: [{ rule: 'SUPERSCRIPT', latex }] })
      rewrite.set(host, parts)
      used.add(s); remove.add(s)
      ev('RECONSTRUCTED', { rule: 'SUPERSCRIPT', latex, x: host.x, y: host.y, lineY: host.y, te: false, legacyDigits: true })
      continue
    }
    const text = host.str.replace(/\s+$/, '')
    const m = /(\d+(?:\.\d+)?)$/.exec(text) || /(?:^|[\s+\-−×·(=])([A-Za-z])$/.exec(text)
    if (!m) { ev('UNRESOLVED', { rule: 'SUPERSCRIPT', why: 'HOST_NOT_NUMBER_OR_LETTER', x: s.x, y: s.y, lineY: host.y, te: false, text: d }); continue }
    const start = m.index + m[0].lastIndexOf(m[1])
    const latex = `${m[1]}^{${d}}`
    rewrite.set(host, [{ ...host, str: `${text.slice(0, start)}\\(${latex}\\)`, width: s.x + s.width - host.x, math: [...(host.math || []), { rule: 'SUPERSCRIPT', latex }] }])
    used.add(s); remove.add(s)
    ev('RECONSTRUCTED', { rule: 'SUPERSCRIPT', latex, x: host.x, y: host.y, lineY: host.y, te: teLine(lineOf(host.y) || { items: [host] }) })
  }

  // ---- stacked fractions ------------------------------------------------------------------------
  const shortNumeric = o => o.width < R.stackMaxWidth && digitsOf(o, legacy) !== null
  const textBaseline = b => b.items.some(o => !shortNumeric(o))
  const offBaseline = it => !baselines.some(b => Math.abs(b.y - it.y) <= R.band && textBaseline(b))
  const aloneOnY = it => items.filter(o => o !== it && Math.abs(o.y - it.y) <= R.band).every(o => shortNumeric(o) && offBaseline(o))
  const cx = it => it.x + it.width / 2
  const nums = items.filter(it => !used.has(it) && shortNumeric(it))
  const stacked = new Set()
  for (const top of nums) for (const bot of nums) {
    if (top === bot || stacked.has(top) || stacked.has(bot) || Math.abs(cx(top) - cx(bot)) > R.stackCentre) continue
    const line = baselines.find(b => textBaseline(b) && top.y - b.y >= R.stackOffset[0] && top.y - b.y <= R.stackOffset[1] && b.y - bot.y >= R.stackOffset[0] && b.y - bot.y <= R.stackOffset[1])
    if (!line) continue
    const why = !aloneOnY(top) || !aloneOnY(bot) ? 'SHARES_ROW_WITH_TEXT'
      : !frames.some(f => f.h <= R.frameMaxH && f.x <= Math.min(top.x, bot.x) + 0.5 && f.x + f.w >= Math.max(top.x + top.width, bot.x + bot.width) - 0.5 && f.y <= bot.y + 0.5 && f.y + f.h >= top.y + 0.5) ? 'NO_EQUATION_FRAME' : null
    if (why) { ev('UNRESOLVED', { rule: 'STACKED', why, x: top.x, y: top.y, lineY: line.y, te: teLine(line), text: `${digitsOf(top, legacy)}/${digitsOf(bot, legacy)}` }); stacked.add(top); stacked.add(bot); continue }
    stacked.add(top); stacked.add(bot); used.add(top); used.add(bot); remove.add(top); remove.add(bot)
    const n = digitsOf(top, legacy), d = digitsOf(bot, legacy), x = Math.min(top.x, bot.x)
    // Mixed number: a Latin digit run ending flush before the stack, on the same baseline.
    const prev = line.items.filter(o => !remove.has(o) && !legacy(o) && o.x < x).sort((a, b) => b.x - a.x)[0]
    const pv = prev && (rewrite.get(prev)?.[0] || prev)
    const whole = pv && x - (prev.x + prev.width) <= R.mixedGap && /(\d+)\s*$/.exec(pv.str)
    if (whole) {
      const latex = `${whole[1]}\\frac{${n}}{${d}}`
      rewrite.set(prev, [{ ...pv, str: `${pv.str.slice(0, whole.index)}\\(${latex}\\)`, width: Math.max(top.x + top.width, bot.x + bot.width) - prev.x, math: [...(pv.math || []), { rule: 'STACKED', latex }] }])
      ev('RECONSTRUCTED', { rule: 'STACKED', latex, x, y: line.y, lineY: line.y, te: teLine(line), mixed: true })
    } else {
      const latex = `\\frac{${n}}{${d}}`
      inserted.push({ str: `\\(${latex}\\)`, x, y: line.y, width: Math.max(top.width, bot.width), height: 12, fontName: MATH_FONT, dir: 'ltr', math: [{ rule: 'STACKED', latex }] })
      ev('RECONSTRUCTED', { rule: 'STACKED', latex, x, y: line.y, lineY: line.y, te: teLine(line) })
    }
  }
  // A lone numeric part next to a text line that no stack consumed (e.g. its partner is missing).
  for (const it of nums.filter(o => !stacked.has(o) && !used.has(o) && aloneOnY(o) && offBaseline(o))) {
    const line = baselines.find(b => textBaseline(b) && Math.abs(it.y - b.y) >= R.stackOffset[0] && Math.abs(it.y - b.y) <= R.stackOffset[1]
      && b.items.some(h => h.x <= it.x + it.width && h.x + h.width >= it.x - 30))
    if (line && frames.some(f => f.h <= R.frameMaxH && f.x <= it.x + 0.5 && f.x + f.w >= it.x + it.width - 0.5 && f.y <= it.y + 0.5 && f.y + f.h >= it.y + 0.5))
      ev('UNRESOLVED', { rule: 'STACKED', why: 'LONE_PART', x: it.x, y: it.y, lineY: line.y, te: teLine(line), text: digitsOf(it, legacy) })
  }

  // ---- bitmaps and equation stubs (located, never read) -------------------------------------------
  const imgOn = []
  for (const im of images) {
    const line = baselines.find(b => textBaseline(b) && im.y <= b.y + 4 && im.y + im.h >= b.y + 2)
    if (!line) continue
    const box = { x: +im.x.toFixed(1), y: +im.y.toFixed(1), w: +im.w.toFixed(1), h: +im.h.toFixed(1) }
    imgOn.push({ line, box })
    ev('IMAGE', { x: box.x, y: box.y, box, lineY: line.y, te: teLine(line), obj: im.obj ?? null,
      ...(im.fp !== undefined ? { fp: im.fp, px: im.px ?? null } : {}) })
  }
  for (const st of stubs) {
    const line = lineOf(st.y)
    if (!line) continue
    const covered = imgOn.some(({ line: l, box }) => l === line && box.x <= st.x + st.width + 2 && box.x + box.w >= st.x - 2)
    ev('STUB', { x: st.x, y: st.y, w: st.width, lineY: line.y, te: teLine(line), covered })
  }
}

// ---- consumers ------------------------------------------------------------------------------
// Value of an option span made of legacy digit glyphs and/or reconstructed maths items (Q124: the bare
// marker's ")" + \(10^{10}\)). Null unless EVERY piece is proven (legacy digits or maths); ")" alone is
// structure. Used by the English option recovery and by the Telugu script-neutral check alike.
export function neutralSpanValue(span, legacy) {
  const parts = []
  for (const it of [...span].sort((a, b) => a.x - b.x)) {
    if (isMathItem(it)) { parts.push(it.str.trim()); continue }
    if (!legacy(it)) return null
    const rest = it.str.replace(new RegExp(`^[\\s${SPACE}]*${PAREN}`), '').replace(new RegExp(`[${SPACE}\\s]+`, 'g'), ' ').trim()
    if (!rest) continue
    const v = decodeNeutralNumeric(rest, { dropLeadingParen: false })
    if (v === null) return null
    parts.push(v)
  }
  return parts.length ? parts.join(' ') : null
}

// Linear, plain form of a serialized string (digit cross-checks, search): \(12\frac{4}{11}\) -> 12 4/11.
export const linearMath = s => String(s ?? '').replace(/\\\(([\s\S]*?)\\\)/g, (_, m) => m
  .replace(/\\frac\{([^}]*)\}\{([^}]*)\}/g, ' $1/$2').replace(/\^\{([^}]*)\}/g, '^$1').trim())
