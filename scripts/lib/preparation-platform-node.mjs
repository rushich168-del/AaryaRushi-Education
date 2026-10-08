// B4.7 — Node platform for the shared preparation pipeline (offline CLIs, the local backend and
// the tests). The browser platform (src/services/preparation/browserPlatform.js) implements the
// same interface; the pipeline itself is identical.
//
// Interface: openPdf(bytes) · createCanvas(w,h) · encodePng(canvas) · sha256(bytes) · ocrInput(canvas)
//            · createOcrPool({ model, workers }) · engineVersion · now()

import crypto from 'crypto'
import { createRequire } from 'module'
import { openPdf as openNodePdf } from './pdf-page-model.mjs'
import { createTeluguOcr, OCR_ENGINE_VERSION } from './telugu-ocr.mjs'

const require = createRequire(import.meta.url)
const napi = require('@napi-rs/canvas')   // pdf.js's own Node canvas (already a dependency of pdfjs-dist)

export function createNodePlatform() {
  return {
    name: 'node',
    engineVersion: OCR_ENGINE_VERSION,
    async openPdf(bytes) { return openNodePdf(bytes) },
    createCanvas(w, h) { const canvas = napi.createCanvas(w, h); return { canvas, context: canvas.getContext('2d') } },
    async encodePng(canvas) { return new Uint8Array(canvas.toBuffer('image/png')) },
    async sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex') },
    ocrInput(canvas) { return canvas.toBuffer('image/png') },
    async createOcrPool({ model = 'int', workers = 4, psm = '7' } = {}) {
      const pool = await Promise.all(Array.from({ length: workers }, () => createTeluguOcr({ model, psm })))
      return { workers: pool, terminate: () => Promise.all(pool.map(w => w.terminate())) }
    },
    async modelSha256(model) {
      const fs = await import('fs'); const path = await import('path')
      const { MODEL_DIRS } = await import('./telugu-ocr.mjs')
      return crypto.createHash('sha256').update(fs.readFileSync(path.join(MODEL_DIRS[model], 'tel.traineddata'))).digest('hex')
    },
    now: () => Date.now(),
  }
}
