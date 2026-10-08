// Node-side pdf.js loader for the offline B4 tools (B4.1 analysis, B4.3 visuals, B4.4 OCR).
//
// The page model and rendering live in ./pdf-page-model-core.mjs (shared with the in-browser
// B4.7 preparation pipeline); this file only adds what is Node-specific: reading a LOCAL file,
// the pdf.js legacy build + worker path, and PNG encoding through pdf.js's own @napi-rs/canvas.
// No network, no writes.

import fs from 'fs'
import { createRequire } from 'module'
import { pathToFileURL } from 'url'
import { parsePages, buildPageModelsFromPdf, renderPageWith, cropCanvas } from './pdf-page-model-core.mjs'

const require = createRequire(import.meta.url)
export { parsePages }

export async function openPdf(fileOrBytes) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  try {
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')).href
  } catch { /* fake worker */ }
  const data = typeof fileOrBytes === 'string' ? new Uint8Array(fs.readFileSync(fileOrBytes)) : new Uint8Array(fileOrBytes)
  // fontExtraProperties (B4.8.4B): keeps each font's widths/program for the legacy-decoder font gate.
  // It only retains data pdf.js would otherwise discard; drawing is unchanged.
  const pdf = await pdfjs.getDocument({ data, useSystemFonts: true, fontExtraProperties: true }).promise
  return { pdf, pdfjs }
}

export const nodeCanvasFactory = pdf => (w, h) => pdf.canvasFactory.create(w, h)

export async function buildPageModels(file, pageSpec, opened = null) {
  const { pdf, pdfjs } = opened || await openPdf(file)
  return buildPageModelsFromPdf(pdf, pdfjs.OPS, { pageSpec })
}

// Render one page at `scale`. Returns the canvas (for cropping) plus a grayscale raster.
export function renderPage(pdf, pageNumber, scale) {
  return renderPageWith(nodeCanvasFactory(pdf), pdf, pageNumber, scale)
}

// Copy a pixel rectangle of a rendered canvas into PNG bytes (Node).
export function cropToPng(pdf, canvas, rect) {
  return cropCanvas(nodeCanvasFactory(pdf), canvas, rect).toBuffer('image/png')
}
