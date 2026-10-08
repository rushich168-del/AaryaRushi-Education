import * as pdfjsLib from 'pdfjs-dist'
import { supabase } from '../lib/supabaseClient.js'

// P0-B2: render pages of the PRIVATE source PDF to a canvas and crop regions.
// Separate from text extraction (pdfAnalyzer); it never parses or reorders text.

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url
).toString()

const SOURCE_BUCKET = 'ksc-source-documents'
const docCache = new Map() // storagePath -> Promise<PDFDocumentProxy>

// Load the source PDF through a short-lived signed URL (same mechanism as analysis).
export function loadSourcePdf(storagePath) {
  if (!docCache.has(storagePath)) {
    const loading = (async () => {
      const { data, error } = await supabase.storage.from(SOURCE_BUCKET).createSignedUrl(storagePath, 300)
      if (error) throw error
      if (!data?.signedUrl) throw new Error('Could not access the source document.')
      return pdfjsLib.getDocument({ url: data.signedUrl }).promise
    })()
    loading.catch(() => docCache.delete(storagePath))
    docCache.set(storagePath, loading)
  }
  return docCache.get(storagePath)
}

// Render one page at `scale` into `canvas`. Returns the source page size in PDF
// points (scale 1) so screen selections can be normalized to the source page.
export async function renderPageToCanvas(pdf, pageNumber, canvas, scale) {
  const page = await pdf.getPage(pageNumber)
  const base = page.getViewport({ scale: 1 })
  const viewport = page.getViewport({ scale })
  canvas.width = Math.floor(viewport.width)
  canvas.height = Math.floor(viewport.height)
  const context = canvas.getContext('2d')
  await page.render({ canvasContext: context, viewport }).promise
  return { pageWidthPt: base.width, pageHeightPt: base.height, scale }
}

// Copy a pixel rectangle of a rendered canvas into a PNG Blob.
export function cropCanvasToPng(canvas, { sx, sy, sw, sh }) {
  const out = document.createElement('canvas')
  out.width = sw
  out.height = sh
  out.getContext('2d').drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh)
  return new Promise((resolve, reject) => {
    out.toBlob(blob => (blob ? resolve({ blob, width: sw, height: sh }) : reject(new Error('Could not create the image.'))), 'image/png')
  })
}
