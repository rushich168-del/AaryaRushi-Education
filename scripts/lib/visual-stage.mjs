// B4.3 visual stage — the ONE implementation used by the offline CLI (scripts/b43-detect-visuals.mjs)
// and the B4.7 in-browser preparation pipeline. Platform-neutral: the caller supplies the opened
// pdf.js document, a canvas factory and a PNG encoder.
//
// Renders every page, runs the pure detector, crops accepted figures, and crops the Telugu source
// regions of shared materials (untouched 2x crops, no OCR). Returns the manifest (same shape as
// reports/b43/b43-manifest.json) and the crop bytes keyed by manifest file name.

import { renderPageWith, cropCanvas } from './pdf-page-model-core.mjs'
import { detectVisuals, summarise, toPixelRect, B43_DETECTOR, B43_DETECTOR_VERSION, DEFAULTS } from './visual-detection.mjs'

// Source context for review previews: the crop grown by 40pt, clamped to the page.
export function contextRect(row, page) {
  const c = row.cropPt || { x0: row.inkBoxPt.x0 - 6, y0: row.inkBoxPt.y0 - 6, x1: row.inkBoxPt.x1 + 6, y1: row.inkBoxPt.y1 + 6 }
  return { x0: Math.max(0, c.x0 - 40), y0: Math.max(0, c.y0 - 40), x1: Math.min(page.widthPt, c.x1 + 40), y1: Math.min(page.heightPt, c.y1 + 40) }
}

// platform: { createCanvas(w,h), encodePng(canvas) -> Promise<Uint8Array>, sha256(bytes) -> Promise<hex> }
export async function runVisualStage({ pdf, pages, model, platform, withContext = false, onProgress = null }) {
  const scale = DEFAULTS.scale
  const rasters = new Map()
  for (const p of pages) {
    const r = await renderPageWith(platform.createCanvas, pdf, p.page, scale)
    rasters.set(p.page, { gray: r.gray, width: r.width, height: r.height, scale: r.scale })
    if (onProgress) await onProgress({ step: 'render', page: p.page, pages: pages.length })
  }
  const detection = detectVisuals(pages, model, rasters)
  rasters.clear()

  // Crops come from a fresh render of the page (the grayscale raster is analysis-only).
  const crops = new Map()
  const byPage = new Map()
  for (const r of detection.rows.filter(r => !r.noise)) {
    if (!byPage.has(r.page)) byPage.set(r.page, [])
    byPage.get(r.page).push(r)
  }
  for (const [pageNum, rows] of byPage) {
    const rendered = await renderPageWith(platform.createCanvas, pdf, pageNum, scale, { gray: false })
    const page = pages.find(p => p.page === pageNum)
    for (const r of rows) {
      if (r.status === 'ACCEPTED') {
        r.file = `crops/${r.id}.png`
        const png = await platform.encodePng(cropCanvas(platform.createCanvas, rendered.canvas, r.pixel))
        crops.set(r.file, png)
        r.sha256 = await platform.sha256(png)
        r.widthPx = r.pixel.sw; r.heightPx = r.pixel.sh
      }
      if (withContext) {
        const ctx = toPixelRect(contextRect(r, page), page.heightPt, scale, rendered.width, rendered.height)
        r.contextFile = `crops/${r.id}-context.png`
        crops.set(r.contextFile, await platform.encodePng(cropCanvas(platform.createCanvas, rendered.canvas, ctx)))
      }
    }
  }

  // Shared-material Telugu source regions (B4.1 geometry): untouched 2x crops, no OCR.
  const materialSources = []
  for (const m of model.materials || []) {
    for (const [k, t] of m.teluguRegions.entries()) {
      const page = pages.find(p => p.page === t.page)
      const rendered = await renderPageWith(platform.createCanvas, pdf, t.page, scale, { gray: false })
      const rect = { x0: Math.max(0, t.x - 2), y0: Math.max(0, t.y), x1: Math.min(page.widthPt, t.x + t.w + 2), y1: Math.min(page.heightPt, t.y + t.h) }
      const pixel = toPixelRect(rect, page.heightPt, scale, rendered.width, rendered.height)
      const png = await platform.encodePng(cropCanvas(platform.createCanvas, rendered.canvas, pixel))
      const file = `materials/m${m.index}-te-${k}.png`
      crops.set(file, png)
      materialSources.push({ materialIndex: m.index, regionIndex: k, kind: 'TEXT_REGION', page: t.page, file, sha256: await platform.sha256(png),
        pixel, widthPx: pixel.sw, heightPx: pixel.sh, renderScale: scale, pageWidthPt: page.widthPt, pageHeightPt: page.heightPt,
        region: { x: +(rect.x0 / page.widthPt).toFixed(4), y: +((page.heightPt - rect.y1) / page.heightPt).toFixed(4), w: +((rect.x1 - rect.x0) / page.widthPt).toFixed(4), h: +((rect.y1 - rect.y0) / page.heightPt).toFixed(4) } })
    }
  }

  const summary = summarise(model, detection)
  const manifest = {
    meta: { detector: B43_DETECTOR, detectorVersion: B43_DETECTOR_VERSION, renderScale: scale, pages: pdf.numPages, questions: model.questions.length },
    summary: { ...summary, perQuestion: undefined },
    accepted: detection.rows.filter(r => r.status === 'ACCEPTED'),
    materialSources,
    rejected: detection.rows.filter(r => r.status !== 'ACCEPTED' && !r.noise),
    noise: detection.rows.filter(r => r.noise).map(r => ({ id: r.id, page: r.page, questionNumber: r.questionNumber, inkBoxPt: r.inkBoxPt, reasons: r.reasons })),
    decorationRejected: detection.decorationRejected,
    perQuestion: summary.perQuestion,
    options: detection.options,
  }
  return { manifest, crops, detection, summary }
}
