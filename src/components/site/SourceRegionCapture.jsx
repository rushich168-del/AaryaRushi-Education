import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { loadSourcePdf, renderPageToCanvas, cropCanvasToPng } from '../../services/pdfPageRenderer.js'
import {
  DRAFT_MEDIA_KINDS, DRAFT_MEDIA_RENDER_SCALE, normalizeRegion, isUsableRegion, regionToPixels,
} from '../../services/draftPaperMapping.js'

const KIND_LABELS = { DIAGRAM: 'Diagram', FIGURE: 'Figure', IMAGE: 'Image', TABLE: 'Table', CHART: 'Chart', MAP: 'Map', TEXT_REGION: 'Text region', OTHER: 'Other' }

// P0-B2: teacher draws a rectangle on the ORIGINAL source page. The crop is taken
// from a 2x pdf.js render (never from the browser PDF iframe). Nothing is detected,
// generated or recreated: the stored image is exactly the selected source pixels.
export default function SourceRegionCapture({ storagePath, initialPage, targetLabel, onAttach, onClose, allowedKinds = DRAFT_MEDIA_KINDS }) {
  const canvasRef = useRef(null)
  const [pdf, setPdf] = useState(null)
  const [pageNum, setPageNum] = useState(Math.max(1, initialPage || 1))
  const [pageInfo, setPageInfo] = useState(null)
  const [rendering, setRendering] = useState(true)
  const [drag, setDrag] = useState(null)       // canvas-pixel drag while selecting
  const [region, setRegion] = useState(null)   // normalized selection
  const [preview, setPreview] = useState(null) // { url, blob, width, height }
  // A single allowed kind (the language workflow's TEXT_REGION) is preselected.
  const [kind, setKind] = useState(allowedKinds.length === 1 ? allowedKinds[0] : '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    let alive = true
    loadSourcePdf(storagePath)
      .then(doc => { if (alive) { setPdf(doc); setPageNum(p => Math.min(p, doc.numPages)) } })
      .catch(e => { if (alive) { setError('Could not open the source PDF.'); setRendering(false); console.error(e) } })
    return () => { alive = false }
  }, [storagePath])

  useEffect(() => {
    if (!pdf || !canvasRef.current) return
    let alive = true
    setRendering(true)
    setRegion(null)
    setDrag(null)
    clearPreview()
    renderPageToCanvas(pdf, pageNum, canvasRef.current, DRAFT_MEDIA_RENDER_SCALE)
      .then(info => { if (alive) setPageInfo(info) })
      .catch(e => { if (alive) { setError('Could not render this page.'); console.error(e) } })
      .finally(() => { if (alive) setRendering(false) })
    return () => { alive = false }
  }, [pdf, pageNum])

  useEffect(() => () => { if (preview?.url) URL.revokeObjectURL(preview.url) }, [preview])

  function clearPreview() {
    setPreview(prev => { if (prev?.url) URL.revokeObjectURL(prev.url); return null })
  }

  const toCanvasPoint = (e) => {
    const canvas = canvasRef.current
    const rect = canvas.getBoundingClientRect()
    return {
      x: (e.clientX - rect.left) * (canvas.width / rect.width),
      y: (e.clientY - rect.top) * (canvas.height / rect.height),
    }
  }

  const onPointerDown = (e) => {
    if (rendering || busy) return
    e.currentTarget.setPointerCapture?.(e.pointerId)
    const p = toCanvasPoint(e)
    setError(null)
    clearPreview()
    setRegion(null)
    setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y })
  }

  const onPointerMove = (e) => {
    if (!drag) return
    const p = toCanvasPoint(e)
    setDrag(d => ({ ...d, x1: p.x, y1: p.y }))
  }

  const onPointerUp = async () => {
    if (!drag) return
    const canvas = canvasRef.current
    const r = normalizeRegion(drag, canvas)
    setDrag(null)
    if (!isUsableRegion(r)) {
      setRegion(null)
      setError('Selection is too small. Drag a rectangle around the whole visual.')
      return
    }
    setRegion(r)
    try {
      const crop = await cropCanvasToPng(canvas, regionToPixels(r, canvas))
      setPreview({ ...crop, url: URL.createObjectURL(crop.blob) })
    } catch (e) {
      setError('Could not create the preview.')
      console.error(e)
    }
  }

  const handleAttach = async () => {
    if (!preview || !region || !kind || !pageInfo) return
    setBusy(true)
    setError(null)
    try {
      await onAttach({
        blob: preview.blob, widthPx: preview.width, heightPx: preview.height,
        region, sourcePage: pageNum, mediaKind: kind,
        pageWidthPt: pageInfo.pageWidthPt, pageHeightPt: pageInfo.pageHeightPt, renderScale: pageInfo.scale,
      })
    } catch (e) {
      console.error(e)
      setError('The visual could not be saved. Nothing was attached. Please try again.')
      setBusy(false)
    }
  }

  const live = drag && canvasRef.current ? normalizeRegion(drag, canvasRef.current) : region
  const pct = v => `${(v * 100).toFixed(3)}%`

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-5xl max-h-[95vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-3 border-b">
          <div>
            <div className="font-bold">Add visual from source</div>
            <div className="text-xs text-slate-500">Attach to: <span className="font-semibold">{targetLabel}</span></div>
          </div>
          <button onClick={onClose} disabled={busy} className="p-1 rounded hover:bg-slate-100" aria-label="Close"><X size={18} /></button>
        </div>

        <div className="flex flex-wrap items-center gap-3 px-5 py-2 border-b text-sm">
          <button disabled={rendering || busy || pageNum <= 1} onClick={() => setPageNum(p => p - 1)} className="px-2 py-1 border rounded disabled:opacity-40">‹ Prev</button>
          <span>Page {pageNum}{pdf ? ` of ${pdf.numPages}` : ''}</span>
          <button disabled={rendering || busy || !pdf || pageNum >= pdf.numPages} onClick={() => setPageNum(p => p + 1)} className="px-2 py-1 border rounded disabled:opacity-40">Next ›</button>
          <span className="text-slate-500">Drag a rectangle around the visual on the original page.</span>
        </div>

        <div className="flex-1 overflow-auto grid md:grid-cols-[1fr_260px] gap-4 p-4">
          <div className="relative border rounded bg-slate-50 select-none touch-none"
            onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
            style={{ cursor: rendering ? 'wait' : 'crosshair' }}>
            <canvas ref={canvasRef} className="block w-full h-auto" />
            {live && live.w > 0 && live.h > 0 && (
              <div className="absolute border-2 border-blue-600 bg-blue-500/10 pointer-events-none"
                style={{ left: pct(live.x), top: pct(live.y), width: pct(live.w), height: pct(live.h) }} />
            )}
            {rendering && <div className="absolute inset-0 flex items-center justify-center text-sm text-slate-500">Rendering page…</div>}
          </div>

          <div className="space-y-3 text-sm">
            <div>
              <div className="text-xs font-bold text-slate-500 uppercase mb-1">Preview</div>
              {preview
                ? <img src={preview.url} alt="Selected source region" className="border rounded max-w-full" />
                : <div className="border rounded p-3 text-slate-400 text-xs">No region selected yet.</div>}
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-500 uppercase mb-1">
                {allowedKinds.length === 1 ? 'Capture kind' : 'Visual kind'}
              </label>
              {allowedKinds.length === 1 ? (
                <div className="border rounded p-1.5 bg-slate-50 text-slate-700">{KIND_LABELS[allowedKinds[0]] || allowedKinds[0]}</div>
              ) : (
                <select value={kind} onChange={e => setKind(e.target.value)} className="w-full border rounded p-1.5">
                  <option value="">Choose kind…</option>
                  {allowedKinds.map(k => <option key={k} value={k}>{KIND_LABELS[k] || k}</option>)}
                </select>
              )}
            </div>
            {error && <div className="p-2 rounded bg-red-50 text-red-700 border border-red-200 text-xs">{error}</div>}
            <div className="flex justify-end gap-2 pt-2 border-t">
              <button onClick={onClose} disabled={busy} className="px-3 py-1.5 text-slate-600 hover:bg-slate-100 rounded">Cancel</button>
              <button onClick={handleAttach} disabled={busy || !preview || !kind}
                className="px-3 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50">
                {busy ? 'Attaching…' : 'Attach'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
