// B4.4 — Telugu OCR over RENDERED PIXELS, Node side (offline tools).
//
// The OCR rules live in ./telugu-ocr-core.mjs (shared with the in-browser B4.7 pipeline). This
// file adds what is Node-specific: the self-hosted model directories (vendor/tessdata/{int,fast,best},
// read from disk, never fetched), the tesseract.js worker and PNG encoding via @napi-rs/canvas.
// Production (B4.5R) uses the integer model 'int' plus the glyph-layer hybrid
// (./telugu-glyph-hybrid.mjs); 'fast' is the previous B4.4 baseline, kept for comparison.

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import { prepareCropCanvas } from './telugu-ocr-core.mjs'

export * from './telugu-ocr-core.mjs'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

export const OCR_ENGINE_VERSION = require('tesseract.js/package.json').version
export const MODEL_DIRS = { best: path.join(ROOT, 'vendor/tessdata/best'), fast: path.join(ROOT, 'vendor/tessdata/fast'), int: path.join(ROOT, 'vendor/tessdata/int') }

// ---------- worker ----------------------------------------------------------------------
export async function createTeluguOcr({ model = 'best', psm = '6' } = {}) {
  const langPath = MODEL_DIRS[model]
  if (!langPath || !path.isAbsolute(langPath) || !fs.existsSync(path.join(langPath, 'tel.traineddata'))) {
    throw new Error(`Telugu model "${model}" not found at ${langPath}`)
  }
  const { createWorker, OEM } = await import('tesseract.js')
  const worker = await createWorker('tel', OEM.LSTM_ONLY, {
    langPath,              // local directory => read from disk, never fetched
    gzip: false,
    cacheMethod: 'none',
    logger: () => {},
    errorHandler: () => {},
  })
  await worker.setParameters({ tessedit_pageseg_mode: psm, preserve_interword_spaces: '1' })
  return {
    model,
    async recognize(png, { psm: unitPsm } = {}) {
      if (unitPsm) await worker.setParameters({ tessedit_pageseg_mode: unitPsm })
      const { data } = await worker.recognize(png)
      if (unitPsm && unitPsm !== psm) await worker.setParameters({ tessedit_pageseg_mode: psm })
      return { text: data.text || '', confidence: Number.isFinite(data.confidence) ? data.confidence : 0 }
    },
    terminate: () => worker.terminate(),
  }
}


// Node wrapper: the shared crop preparation, encoded to PNG bytes (napi canvas).
export function prepareCrop(pdf, canvas, rect, opts) {
  const r = prepareCropCanvas((w, h) => pdf.canvasFactory.create(w, h), canvas, rect, opts)
  return r.empty ? { png: null, pixel: null, empty: true } : { png: r.canvas.toBuffer('image/png'), pixel: r.pixel }
}
