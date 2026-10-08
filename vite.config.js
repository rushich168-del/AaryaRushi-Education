import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'
import brand from './src/config/brand.js'

// B4.7: self-hosted OCR assets for "Prepare Paper Automatically" (in-browser Telugu OCR).
// tesseract.js would otherwise fetch its WASM core from a CDN; the integer Telugu model is the
// sha-pinned vendor file. Served in dev and emitted into the build under fixed same-origin paths:
//   /ocr/tessdata/tel.traineddata · /ocr/tesseract/worker.min.js · /ocr/core/<variant>-lstm.wasm.js
const OCR_ASSETS = {
  'ocr/tessdata/tel.traineddata': 'vendor/tessdata/int/tel.traineddata',
  'ocr/tesseract/worker.min.js': 'node_modules/tesseract.js/dist/worker.min.js',
  'ocr/core/tesseract-core-lstm.wasm.js': 'node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js',
  'ocr/core/tesseract-core-simd-lstm.wasm.js': 'node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js',
  'ocr/core/tesseract-core-relaxedsimd-lstm.wasm.js': 'node_modules/tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js',
}
function ocrAssets() {
  const type = f => (f.endsWith('.js') ? 'text/javascript' : 'application/octet-stream')
  return {
    name: 'ocr-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const key = decodeURIComponent((req.url || '').split('?')[0]).replace(/^\//, '')
        const src = OCR_ASSETS[key]
        if (!src) return next()
        res.setHeader('Content-Type', type(src))
        res.setHeader('Cache-Control', 'no-cache')
        fs.createReadStream(path.resolve(src)).pipe(res)
      })
    },
    generateBundle() {
      for (const [fileName, src] of Object.entries(OCR_ASSETS)) this.emitFile({ type: 'asset', fileName, source: fs.readFileSync(path.resolve(src)) })
    },
  }
}

// Fills %BRAND_*% placeholders in index.html from src/config/brand.js.
function brandHtml() {
  const esc = v => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
  const values = {
    BRAND_NAME: brand.name,
    BRAND_TAGLINE: brand.tagline,
    BRAND_DESCRIPTION: brand.description,
    BRAND_LOGO: brand.logo.mark,
    BRAND_PRIMARY: brand.colors.primary,
  }
  return {
    name: 'brand-html',
    transformIndexHtml: html => html.replace(/%(BRAND_[A-Z_]+)%/g, (m, key) => (key in values ? esc(values[key]) : m)),
  }
}

export default defineConfig({
  plugins: [
    react({
      jsxRuntime: 'automatic',
    }),
    ocrAssets(),
    brandHtml(),
  ],
})
