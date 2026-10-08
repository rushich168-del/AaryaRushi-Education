// EXPERIMENT — glyph atlas of the paper's legacy Telugu fonts (glyph-map feasibility test).
//
// pdf.js (fontExtraProperties) exposes each embedded font's converted program (`data`), its
// CID -> converted-char map (`toFontChar`) and CID -> text-layer code map (`toUnicode`, here the
// legacy U+F0xx codes). Registering the program with @napi-rs/canvas lets us draw every glyph
// ALONE, labelled with the F0xx code the text layer reports — the input a glyph map would consume.
// Writes reports/ocr-bench/glyph-atlas-<n>.png and glyph-atlas.json. Read-only on the PDF.
//
// Usage: node scripts/ocr-bench/glyph-atlas.mjs "<paper>.pdf" [--pages 2,12,20]
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { pathToFileURL } from 'url'

const require = createRequire(import.meta.url)
const { createCanvas, GlobalFonts } = require('@napi-rs/canvas')
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')).href

const file = process.argv[2]
const pi = process.argv.indexOf('--pages')
const pagesArg = (pi > -1 ? process.argv[pi + 1] : '2,8,12,20,27').split(',').map(Number)
const OUT = 'reports/ocr-bench'
const pdf = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), fontExtraProperties: true, useSystemFonts: true }).promise
const toUni = tu => { const m = new Map(); const arr = tu?._map || tu?.map || []; arr.forEach((v, cid) => { if (v != null) m.set(cid, String(v)) }); return m }

const fonts = new Map()   // signature -> { family, glyphs: Map(code -> fontChar) }
for (const n of pagesArg) {
  const page = await pdf.getPage(n)
  const vp = page.getViewport({ scale: 1 })
  const { canvas, context } = pdf.canvasFactory.create(Math.floor(vp.width), Math.floor(vp.height))
  await page.render({ canvasContext: context, canvas, viewport: vp }).promise
  for (const [id, obj] of page.commonObjs) {
    if (!obj?.data || !obj.toFontChar) continue
    const tu = toUni(obj.toUnicode)
    const legacy = [...tu].filter(([, u]) => u.length === 1 && u.codePointAt(0) >= 0xF020 && u.codePointAt(0) <= 0xF0FF)
    if (legacy.length < 20) continue
    const sig = `${obj.name}:${obj.data.length}`
    if (fonts.has(sig)) continue
    const family = `legacyte${fonts.size}`
    GlobalFonts.register(Buffer.from(obj.data), family)
    const glyphs = new Map(), widths = {}
    for (const [cid, u] of legacy) if (obj.toFontChar[cid] != null) {
      glyphs.set(u.codePointAt(0), String.fromCodePoint(obj.toFontChar[cid]))
      widths[u.codePointAt(0).toString(16)] = obj.widths?.[cid] ?? null
    }
    fonts.set(sig, { family, page: n, id, glyphs, widths })
  }
}

const summary = []
let k = 0
for (const [sig, f] of fonts) {
  const codes = [...f.glyphs.keys()].sort((a, b) => a - b)
  const cols = 16, tw = 70, th = 90
  const cv = createCanvas(cols * tw, Math.ceil(codes.length / cols) * th)
  const ctx = cv.getContext('2d')
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height)
  codes.forEach((c, i) => {
    const x = (i % cols) * tw, y = Math.floor(i / cols) * th
    ctx.strokeStyle = '#ddd'; ctx.strokeRect(x, y, tw, th)
    ctx.fillStyle = '#c00'; ctx.font = '12px sans-serif'; ctx.fillText(c.toString(16).toUpperCase(), x + 3, y + 13)
    ctx.fillStyle = '#000'; ctx.font = `44px ${f.family}`; ctx.fillText(f.glyphs.get(c), x + 18, y + 64)
  })
  const png = path.join(OUT, `glyph-atlas-${k}.png`)
  fs.writeFileSync(png, cv.toBuffer('image/png'))
  summary.push({ atlas: png, font: sig, firstSeenOnPage: f.page, renderId: f.id, codes: codes.map(c => c.toString(16)), widths: f.widths })
  k++
}
fs.writeFileSync(path.join(OUT, 'glyph-atlas.json'), JSON.stringify(summary, null, 1))
console.log(summary.map(s => `${s.atlas} ${s.font} ${s.codes.length} glyphs`).join('\n'))
