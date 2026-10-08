import { useEffect, useState } from 'react'
import { loadSourcePdf, renderPageToCanvas } from '../../../services/pdfPageRenderer.js'

// Renders a region of the PRIVATE source PDF (signed URL, same path as the Draft workspace) so a
// teacher can see the printed question behind a structural/answer/figure item. Read-only.
// box: { x0, x1, y0, y1 } in PDF points (y up), or null for the whole page.
// scale: render resolution (B4.8.3C: tiny maths bitmaps use 4 so they stay sharp when enlarged).
export default function SourceRegion({ storagePath, page, box = null, label, pad = 6, scale = 2, imgClassName = '' }) {
  const [state, setState] = useState({ url: null, error: null })
  const key = `${storagePath}|${page}|${pad}|${scale}|${box ? [box.x0, box.x1, box.y0, box.y1].join(',') : 'page'}`
  useEffect(() => {
    let active = true
    setState({ url: null, error: null })
    if (!storagePath || !page) { setState({ url: null, error: 'No source page recorded for this item.' }); return () => { active = false } }
    ;(async () => {
      try {
        const pdf = await loadSourcePdf(storagePath)
        const canvas = document.createElement('canvas')
        const { pageWidthPt, pageHeightPt } = await renderPageToCanvas(pdf, page, canvas, scale)
        let out = canvas
        if (box) {
          const x0 = Math.max(0, box.x0 - pad), x1 = Math.min(pageWidthPt, box.x1 + pad)
          const y0 = Math.max(0, box.y0 - pad), y1 = Math.min(pageHeightPt, box.y1 + pad)
          out = document.createElement('canvas')
          out.width = Math.max(1, Math.round((x1 - x0) * scale)); out.height = Math.max(1, Math.round((y1 - y0) * scale))
          out.getContext('2d').drawImage(canvas, x0 * scale, (pageHeightPt - y1) * scale, out.width, out.height, 0, 0, out.width, out.height)
        }
        // A blob: URL (not data:) so "Open larger" works as a new tab.
        const blob = await new Promise(res => out.toBlob(res, 'image/png'))
        if (active && blob) setState({ url: URL.createObjectURL(blob), error: null })
      } catch {
        if (active) setState({ url: null, error: 'The source page could not be displayed.' })
      }
    })()
    return () => { active = false }
  }, [key])
  useEffect(() => () => { if (state.url?.startsWith('blob:')) URL.revokeObjectURL(state.url) }, [state.url]) // eslint-disable-line react-hooks/exhaustive-deps

  return <figure className="space-y-1">
    {state.url
      ? <a href={state.url} target="_blank" rel="noreferrer" title="Open larger"><img src={state.url} alt={label || `Source page ${page}`} className={imgClassName || 'max-h-[36rem] w-full rounded border border-slate-200 bg-white object-contain object-top'} /></a>
      : <div className="flex min-h-24 items-center justify-center rounded border border-dashed border-slate-300 bg-slate-50 p-3 text-sm text-slate-500">{state.error || `Rendering source page ${page}…`}</div>}
    <figcaption className="flex flex-wrap justify-between gap-2 text-xs text-slate-500"><span>{label || `Source page ${page}`}</span>{state.url && <a href={state.url} target="_blank" rel="noreferrer" className="font-semibold text-blue-700">Open larger</a>}</figcaption>
  </figure>
}
