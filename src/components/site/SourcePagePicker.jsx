import { useEffect, useRef, useState } from 'react'

const input = 'w-full rounded-lg border border-slate-300 p-2'
const button = 'rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold disabled:opacity-40'

// Shows one page of the source PDF and lets the user drag a rectangle on it. onCrop receives the
// selected region as a JPEG data URL and the page number. Without a source file it asks for the PDF.
export default function SourcePagePicker({ sourceFile, initialPage = 1, answerKeyPage, onCrop, actionLabel = 'Add selected region', actionClassName = `${button} mt-2`, hint = 'Drag around only the content to add. For a question across columns, add each part in reading order.', tooSmall = 'Draw a larger rectangle around the question.' }) {
  const [pdfFile, setPdfFile] = useState(sourceFile?.name?.toLowerCase().endsWith('.pdf') ? sourceFile : null)
  const [page, setPage] = useState(initialPage)
  const [pageCount, setPageCount] = useState(0)
  const [rendered, setRendered] = useState(null)
  const [busy, setBusy] = useState(false)
  const [rect, setRect] = useState(null)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState('')
  const imageRef = useRef(null)
  useEffect(() => {
    let alive = true, opened
    setRendered(null); setRect(null)
    if (!pdfFile) { setBusy(false); setError(''); return }
    setBusy(true); setError('')
    ;(async () => {
      const {createBrowserPlatform} = await import('../../services/preparation/browserPlatform.js')
      const {renderPageWith} = await import('../../../scripts/lib/pdf-page-model-core.mjs')
      const platform = createBrowserPlatform()
      opened = await platform.openPdf(new Uint8Array(await pdfFile.arrayBuffer()))
      if (!alive) return
      setPageCount(opened.pdf.numPages)
      if (page > opened.pdf.numPages) throw new Error('That page is outside this PDF.')
      if (page === answerKeyPage) throw new Error('This is the detected answer-key page. Choose a question page.')
      const result = await renderPageWith(platform.createCanvas, opened.pdf, page, 2, {gray:false})
      if (alive) setRendered({canvas:result.canvas,src:result.canvas.toDataURL('image/jpeg',0.9)})
    })().catch(e => {if(alive)setError(e.message || 'Could not open this page.')})
      .finally(async () => {await opened?.geometryPdf?.loadingTask?.destroy(); await opened?.pdf?.loadingTask?.destroy(); if(alive)setBusy(false)})
    return () => {alive=false}
  }, [pdfFile, page, answerKeyPage])
  const point = e => {
    const box = imageRef.current.getBoundingClientRect()
    return {x:Math.max(0,Math.min(1,(e.clientX-box.left)/box.width)),y:Math.max(0,Math.min(1,(e.clientY-box.top)/box.height))}
  }
  const crop = () => {
    if (!rect || !rendered) return
    const x=Math.min(rect.x0,rect.x1), y=Math.min(rect.y0,rect.y1), w=Math.abs(rect.x1-rect.x0), h=Math.abs(rect.y1-rect.y0)
    if(w<0.02 || h<0.01) return setError(tooSmall)
    const canvas=document.createElement('canvas'); canvas.width=Math.ceil(w*rendered.canvas.width);canvas.height=Math.ceil(h*rendered.canvas.height)
    canvas.getContext('2d').drawImage(rendered.canvas,x*rendered.canvas.width,y*rendered.canvas.height,w*rendered.canvas.width,h*rendered.canvas.height,0,0,canvas.width,canvas.height)
    setRect(null);setError('');onCrop(canvas.toDataURL('image/jpeg',0.9),page)
  }
  return <>
    <label className="mt-3 block text-sm">Original PDF<input type="file" accept=".pdf" className={input} onChange={e=>{const f=e.target.files?.[0];if(f && (!/\.pdf$/i.test(f.name)||f.size>30*1024*1024)){setError('Choose a PDF up to 30 MB.');return}setPdfFile(f || null);setPageCount(0)}}/></label>
    <label className="mt-3 block text-sm">PDF page{pageCount ? ` (1–${pageCount})` : ''}<input type="number" min="1" max={pageCount || 500} value={page} className={input} onChange={e=>setPage(Math.max(1,Number(e.target.value)||1))}/></label>
    {busy && <p role="status">Opening source page…</p>}
    {rendered && <><p className="my-2 text-sm">{hint}</p><div className="relative touch-none select-none" onPointerDown={e=>{e.currentTarget.setPointerCapture(e.pointerId);const p=point(e);setRect({x0:p.x,y0:p.y,x1:p.x,y1:p.y});setDragging(true)}} onPointerMove={e=>{if(dragging){const p=point(e);setRect(r=>({...r,x1:p.x,y1:p.y}))}}} onPointerUp={()=>setDragging(false)} onPointerCancel={()=>setDragging(false)}>
      <img ref={imageRef} src={rendered.src} alt={`Source PDF page ${page}`} draggable={false} className="block w-full"/>
      {rect && <div className="pointer-events-none absolute border-2 border-blue-700 bg-blue-300/20" style={{left:`${Math.min(rect.x0,rect.x1)*100}%`,top:`${Math.min(rect.y0,rect.y1)*100}%`,width:`${Math.abs(rect.x1-rect.x0)*100}%`,height:`${Math.abs(rect.y1-rect.y0)*100}%`}}/>}
    </div><button type="button" className={actionClassName} disabled={!rect||dragging} onClick={crop}>{actionLabel}</button></>}
    {error && <p role="alert" className="text-red-800">{error}</p>}
  </>
}
