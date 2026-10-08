import * as pdfjsLib from 'pdfjs-dist'
import { createWorker, OEM } from 'tesseract.js'
import tesseractPkg from 'tesseract.js/package.json'

// B4.7 — browser platform for the shared preparation pipeline (scripts/lib/paper-preparation.mjs).
// Same interface as scripts/lib/preparation-platform-node.mjs: the pipeline code is identical; only
// canvas, PNG encoding, hashing, PDF loading and the OCR worker are provided by the browser.
// OCR assets are self-hosted (vite.config.js: /ocr/...), never fetched from a CDN.

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.mjs', import.meta.url).toString()

const OCR_BASE = '/ocr'
const MODEL_URL = `${OCR_BASE}/tessdata/tel.traineddata`

const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')

// Lossless PNG (8-bit RGBA, Sub filter, zlib via CompressionStream). canvas.toBlob/convertToBlob
// wait for browser idle time (about 1 s per image when the tab gets none, measured) and tesseract.js's
// own canvas path hangs if toBlob yields no blob; encoding here avoids both with identical pixels.
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 } return t })()
const crc32 = (bytes, crc = 0xffffffff) => { for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8); return crc }
function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length), view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  view.setUint32(8 + data.length, (crc32(out.subarray(4, 8 + data.length)) ^ 0xffffffff) >>> 0)
  return out
}
export async function encodePngRgba(canvas) {
  const { width, height } = canvas
  if (!width || !height) throw new Error('Could not encode an empty image')
  const rgba = canvas.getContext('2d').getImageData(0, 0, width, height).data
  const stride = width * 4, raw = new Uint8Array((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    const row = y * stride, o = y * (stride + 1)
    raw[o] = 1 // Sub filter
    for (let x = 0; x < stride; x++) raw[o + 1 + x] = (rgba[row + x] - (x >= 4 ? rgba[row + x - 4] : 0)) & 0xff
  }
  const zlib = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer())
  const ihdr = new Uint8Array(13), v = new DataView(ihdr.buffer)
  v.setUint32(0, width); v.setUint32(4, height); ihdr[8] = 8; ihdr[9] = 6
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib), pngChunk('IEND', new Uint8Array())]
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0; for (const p of parts) { png.set(p, at); at += p.length }
  return png
}

// A recognize job that never settles (e.g. a crashed OCR worker, which tesseract.js does not report
// after start-up) fails the stage instead of hanging the preparation.
const OCR_JOB_TIMEOUT_MS = 60_000
const withTimeout = (p, ms) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`KSC_OCR_TIMEOUT: a Telugu line was not read within ${ms / 1000} s`)), ms)
  p.then(v => { clearTimeout(t); resolve(v) }, e => { clearTimeout(t); reject(e) })
})

export function createBrowserPlatform({ ocrWorkers } = {}) {
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4
  return {
    name: 'browser',
    engineVersion: tesseractPkg.version,
    ocrWorkers: ocrWorkers ?? Math.max(1, Math.min(4, cores - 1)),
    async openPdf(bytes) {
      // Same document options pdf.js uses in Node (scripts/lib/pdf-page-model.mjs): glyphs are drawn
      // as paths, not through the browser's font rasterizer, so the OCR sees the pixels the B4.4/B4.5
      // benchmark was validated on.
      // B4.8.3C: a second handle on the same bytes for geometry only, with OffscreenCanvas off so image
      // objects arrive as raw decoded pixels (math-bitmap fingerprints must equal Node's; a canvas
      // readback of an ImageBitmap is not exact). Rendering and OCR keep using `pdf`. Each handle gets
      // its own copy: pdf.js transfers the buffer to its worker.
      const geometryBytes = new Uint8Array(bytes).slice()
      // fontExtraProperties (B4.8.4B): the legacy-decoder font gate reads each font's widths from THIS
      // handle (text-item font names belong to it). Retains data only; drawing is unchanged.
      const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(bytes).slice(), useSystemFonts: true, disableFontFace: true, fontExtraProperties: true }).promise
      const geometryPdf = await pdfjsLib.getDocument({ data: geometryBytes, useSystemFonts: true, disableFontFace: true,
        isOffscreenCanvasSupported: false, isImageDecoderSupported: false }).promise
      return { pdf, pdfjs: pdfjsLib, geometryPdf }
    },
    createCanvas(w, h) {
      const canvas = document.createElement('canvas')
      canvas.width = w; canvas.height = h
      return { canvas, context: canvas.getContext('2d', { willReadFrequently: true }) }
    },
    encodePng: encodePngRgba,
    async sha256(bytes) { return hex(await crypto.subtle.digest('SHA-256', bytes)) },
    // PNG bytes, like the Node platform (never tesseract.js's toBlob-based canvas input).
    ocrInput: canvas => encodePngRgba(canvas),
    async modelSha256() {
      const res = await fetch(MODEL_URL, { cache: 'no-store' })
      if (!res.ok) throw new Error(`Telugu model unavailable (${res.status})`)
      return hex(await crypto.subtle.digest('SHA-256', await res.arrayBuffer()))
    },
    async createOcrPool({ workers = 3, psm = '7' } = {}) {
      const pool = await Promise.all(Array.from({ length: workers }, async () => {
        const w = await createWorker('tel', OEM.LSTM_ONLY, {
          langPath: `${OCR_BASE}/tessdata`, workerPath: `${OCR_BASE}/tesseract/worker.min.js`, corePath: `${OCR_BASE}/core/`,
          gzip: false, cacheMethod: 'none', logger: () => {}, errorHandler: () => {},
          // Same-origin worker script (no blob: worker), so the staging CSP needs only worker-src 'self'.
          workerBlobURL: false,
        })
        await w.setParameters({ tessedit_pageseg_mode: psm, preserve_interword_spaces: '1' })
        return {
          async recognize(input) {
            const { data } = await withTimeout(Promise.resolve(input).then(img => w.recognize(img)), OCR_JOB_TIMEOUT_MS)
            return { text: data.text || '', confidence: Number.isFinite(data.confidence) ? data.confidence : 0 }
          },
          terminate: () => w.terminate(),
        }
      }))
      return { workers: pool, terminate: () => Promise.all(pool.map(w => w.terminate())) }
    },
    now: () => performance.now(),
  }
}
