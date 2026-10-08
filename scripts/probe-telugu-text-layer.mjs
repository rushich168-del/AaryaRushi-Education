// READ-ONLY PDF text-layer diagnostic for the KSC bilingual (English/Telugu) audit.
//
// It opens a LOCAL PDF file with pdf.js and reports, per text item: page, str, fontName,
// font family, dir, transform/x/y, code points, and a script classification. It also counts
// image-drawing operators per page so "absent from the text layer" can be distinguished
// from "garbled text".
//
// It never writes to the PDF, the database, or storage, and it does not change extraction.
//
// Usage:
//   node scripts/probe-telugu-text-layer.mjs "C:\path\to\SI-Constable.pdf"
//   node scripts/probe-telugu-text-layer.mjs file.pdf --pages 1-3
//   node scripts/probe-telugu-text-layer.mjs file.pdf --pages 2 --grep "Assertion"
//   node scripts/probe-telugu-text-layer.mjs file.pdf --pages 1-4 --json probe.json
//   node scripts/probe-telugu-text-layer.mjs file.pdf --items 40      (items shown per page)

import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { pathToFileURL } from 'url'

const require = createRequire(import.meta.url)

// Font families historically used for non-Unicode Telugu typesetting. A hit here plus
// Latin-looking text is strong evidence of legacy (non-Unicode) encoding.
const LEGACY_TELUGU_FONT_HINTS = [
  'anu', 'shree', 'hemalatha', 'priyanka', 'godavari', 'akshar', 'eenadu', 'vaartha',
  'suprabhat', 'telugufont', 'tlwg', 'dhurjati', 'bhaskar', 'ramabhadra', 'amma',
]

const TELUGU = /[\u0C00-\u0C7F]/
const DEVANAGARI_OR_OTHER_INDIC = /[\u0900-\u0BFF\u0C80-\u0DFF]/
const PUA = /[\uE000-\uF8FF]/
const REPLACEMENT = /\uFFFD/
const LATIN_LETTER = /[A-Za-z]/
const SCRIPT_NEUTRAL_ONLY = /^[\s\d\p{P}\p{S}]*$/u

// Pure classifier (exported for unit tests).
export function classifyText(str = '') {
  const chars = [...str]
  const counts = { telugu: 0, latin: 0, digit: 0, pua: 0, replacement: 0, otherNonAscii: 0, punctSpace: 0 }
  for (const ch of chars) {
    const cp = ch.codePointAt(0)
    if (TELUGU.test(ch)) counts.telugu++
    else if (PUA.test(ch)) counts.pua++
    else if (REPLACEMENT.test(ch)) counts.replacement++
    else if (LATIN_LETTER.test(ch)) counts.latin++
    else if (/\d/.test(ch)) counts.digit++
    else if (cp < 128) counts.punctSpace++
    else counts.otherNonAscii++
  }
  let verdict
  if (!str.trim()) verdict = 'EMPTY'
  else if (counts.replacement > 0) verdict = 'GARBLED_REPLACEMENT_CHARS'
  else if (counts.pua > 0) verdict = 'GARBLED_PRIVATE_USE'
  else if (counts.telugu > 0) verdict = 'TELUGU_UNICODE'
  else if (SCRIPT_NEUTRAL_ONLY.test(str)) verdict = 'SCRIPT_NEUTRAL'
  else if (counts.otherNonAscii > 0 && DEVANAGARI_OR_OTHER_INDIC.test(str)) verdict = 'OTHER_INDIC_UNICODE'
  else if (counts.latin > 0 && counts.otherNonAscii === 0) verdict = 'LATIN'
  else verdict = 'OTHER_NON_ASCII'
  return { verdict, counts }
}

export function fontLooksLegacyTelugu(fontFamily = '', fontName = '') {
  const hay = `${fontFamily} ${fontName}`.toLowerCase()
  return LEGACY_TELUGU_FONT_HINTS.some(h => hay.includes(h))
}

const codePoints = (str, max = 24) => [...str].slice(0, max)
  .map(c => 'U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')).join(' ')
  + ([...str].length > max ? ' …' : '')

function parsePages(spec, numPages) {
  if (!spec) return Array.from({ length: Math.min(numPages, 3) }, (_, i) => i + 1)
  const out = new Set()
  for (const part of String(spec).split(',')) {
    const m = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/)
    if (!m) continue
    const from = Number(m[1]); const to = Number(m[2] || m[1])
    for (let p = from; p <= Math.min(to, numPages); p++) if (p >= 1) out.add(p)
  }
  return [...out].sort((a, b) => a - b)
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

async function main() {
  const file = process.argv[2]
  if (!file || file.startsWith('--')) {
    console.error('Usage: node scripts/probe-telugu-text-layer.mjs <file.pdf> [--pages 1-3] [--grep text] [--items 40] [--json out.json]')
    process.exit(2)
  }
  if (!fs.existsSync(file)) {
    console.error(`File not found: ${path.resolve(file)}`)
    process.exit(2)
  }

  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  try {
    // Must be a file:// URL on Windows for the ESM loader.
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')).href
  } catch { /* fall back to the built-in fake worker */ }

  const data = new Uint8Array(fs.readFileSync(file))
  const pdf = await pdfjs.getDocument({ data, useSystemFonts: true }).promise
  const pages = parsePages(arg('pages'), pdf.numPages)
  const grep = arg('grep')
  const itemLimit = Number(arg('items', 25))
  const report = { file: path.resolve(file), numPages: pdf.numPages, pages: [] }

  console.log(`PDF: ${path.resolve(file)}`)
  console.log(`Pages in document: ${pdf.numPages} · probing: ${pages.join(', ')}${grep ? ` · grep: "${grep}"` : ''}\n`)

  for (const pageNum of pages) {
    const page = await pdf.getPage(pageNum)
    const viewport = page.getViewport({ scale: 1 })
    const content = await page.getTextContent()
    const styles = content.styles || {}

    // Image operators tell us when content exists only as pixels.
    let imageOps = 0
    try {
      const ops = await page.getOperatorList()
      const imageFns = new Set([pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintInlineImageXObject, pdfjs.OPS.paintImageMaskXObject])
      imageOps = ops.fnArray.filter(fn => imageFns.has(fn)).length
    } catch { /* operator list is optional for this report */ }

    const fonts = new Map()
    const verdictTotals = {}
    const rows = []
    for (const item of content.items) {
      if (item.str === undefined) continue
      const { verdict, counts } = classifyText(item.str)
      verdictTotals[verdict] = (verdictTotals[verdict] || 0) + 1
      const family = styles[item.fontName]?.fontFamily || ''
      if (!fonts.has(item.fontName)) fonts.set(item.fontName, { family, items: 0, verdicts: {}, sample: item.str.slice(0, 40) })
      const f = fonts.get(item.fontName)
      f.items++
      f.verdicts[verdict] = (f.verdicts[verdict] || 0) + 1
      rows.push({
        page: pageNum, str: item.str, fontName: item.fontName, fontFamily: family, dir: item.dir,
        x: Math.round(item.transform[4] * 10) / 10, y: Math.round(item.transform[5] * 10) / 10,
        width: item.width, height: item.height, hasEOL: item.hasEOL,
        transform: item.transform, verdict, counts, codePoints: codePoints(item.str),
        legacyFontSuspect: fontLooksLegacyTelugu(family, item.fontName),
      })
    }

    const shown = (grep ? rows.filter(r => r.str.toLowerCase().includes(grep.toLowerCase())) : rows).slice(0, itemLimit)
    console.log(`── Page ${pageNum} — ${viewport.width}x${viewport.height}pt · ${content.items.length} text items · ${imageOps} image draw op(s)`)
    console.log(`   verdicts: ${Object.entries(verdictTotals).map(([k, v]) => `${k}=${v}`).join(', ') || 'none (no text layer)'}`)
    console.log('   fonts:')
    for (const [name, f] of fonts) {
      console.log(`     ${name}  family="${f.family}"  items=${f.items}  ${fontLooksLegacyTelugu(f.family, name) ? '*** LEGACY-TELUGU-FONT SUSPECT ***' : ''}`)
      console.log(`        verdicts: ${Object.entries(f.verdicts).map(([k, v]) => `${k}=${v}`).join(', ')}  sample: ${JSON.stringify(f.sample)}`)
    }
    console.log(`   items${grep ? ' matching grep' : ''} (first ${shown.length}):`)
    for (const r of shown) {
      console.log(`     [${r.verdict}${r.legacyFontSuspect ? '/legacy-font' : ''}] x=${r.x} y=${r.y} dir=${r.dir} font=${r.fontName}("${r.fontFamily}")`)
      console.log(`        str: ${JSON.stringify(r.str)}`)
      console.log(`        cps: ${r.codePoints}`)
    }
    console.log('')
    report.pages.push({ page: pageNum, widthPt: viewport.width, heightPt: viewport.height, textItems: content.items.length, imageOps, verdictTotals, fonts: [...fonts.entries()].map(([name, f]) => ({ fontName: name, ...f })), items: rows })
  }

  // Overall reading, to answer "is Telugu real Unicode, legacy-encoded, or missing?"
  const all = report.pages.flatMap(p => p.items)
  const telugu = all.filter(i => i.verdict === 'TELUGU_UNICODE').length
  const garbled = all.filter(i => i.verdict.startsWith('GARBLED')).length
  const legacyFont = all.filter(i => i.legacyFontSuspect).length
  const noTextPages = report.pages.filter(p => p.textItems === 0).length
  console.log('══ SUMMARY ══')
  console.log(`items with Telugu Unicode: ${telugu}`)
  console.log(`items with replacement/private-use characters: ${garbled}`)
  console.log(`items in legacy-Telugu-font suspects: ${legacyFont}`)
  console.log(`probed pages with NO text layer at all: ${noTextPages}`)
  console.log(
    telugu > 0 && garbled === 0 && legacyFont === 0 ? 'READING: Telugu appears to be genuine Unicode — direct extraction is viable.'
      : garbled > 0 || legacyFont > 0 ? 'READING: Telugu appears legacy-encoded/garbled — treat as UNRELIABLE and keep the source region instead.'
        : noTextPages > 0 ? 'READING: some probed pages have no text layer — that content is image-only.'
          : 'READING: no Telugu code points found in the probed pages — check the page range, or the Telugu may be image-only.')

  const jsonOut = arg('json')
  if (jsonOut) {
    fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2))
    console.log(`\nFull JSON written to ${path.resolve(jsonOut)}`)
  }
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch(e => { console.error('Probe failed:', e); process.exit(1) })
}
