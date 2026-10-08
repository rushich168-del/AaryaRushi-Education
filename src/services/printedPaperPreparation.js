import JSZip from 'jszip'
import { printedContent } from './printedPaperContract.js'
import { analysePaper } from '../../scripts/lib/paper-layout.mjs'
import { buildPageModelsFromPdf, renderPageWith, cropCanvas } from '../../scripts/lib/pdf-page-model-core.mjs'
import {sourceSubjectHeading,importedSubjectSections} from './sourceSubjectHeadings.js'

// No OCR and no answer-key page is sent to students. Only individual question
// regions (plus their linked directions) become immutable publication content.
export async function preparePrintedPdf(bytes, platform, onProgress = () => {}) {
  const opened = await platform.openPdf(bytes)
  try {
    onProgress('Finding questions…')
    const { pages } = await buildPageModelsFromPdf(opened.geometryPdf || opened.pdf, opened.pdfjs.OPS)
    const model = analysePaper(pages)
    if (!model.questions.length) throw new Error('No numbered questions were found. Scanned papers need a text layer; use a text-based PDF or Word file.')
    const questions = []
    let cachedPage, rendered
    const image = async r => {
      if (r.page === model.stats.answerKeyPage) throw new Error('A question overlaps the answer-key page. Check the source paper.')
      if (cachedPage !== r.page) {
        rendered = await renderPageWith(platform.createCanvas, opened.pdf, r.page, 2, { gray: false })
        cachedPage = r.page
      }
      const x = Math.max(0, r.x - 3), top = Math.max(0, rendered.pageHeightPt - r.y - r.h)
      const rect = { sx: Math.floor(x * 2), sy: Math.floor(top * 2), sw: Math.min(Math.ceil((r.w + 6) * 2), rendered.width - Math.floor(x * 2)), sh: Math.min(Math.ceil(r.h * 2), rendered.height - Math.floor(top * 2)) }
      if (rect.sw <= 0 || rect.sh <= 0) throw new Error('Invalid question boundary. Check the source paper.')
      const canvas = cropCanvas(platform.createCanvas, rendered.canvas, rect)
      return { type: 'image', src: canvas.toDataURL('image/jpeg', 0.9), alt: `Printed source, page ${r.page}` }
    }
    for (const q of model.questions) {
      onProgress(`Preparing question ${questions.length + 1} of ${model.questions.length}…`)
      const blocks = []
      const material = model.materials.find(m => m.index === q.sharedMaterialIndex)
      for (const r of material?.sourceRegions || []) {
        // A table border can extend left of its text, especially when the
        // translated half starts in the next column. Preserve the column's
        // content width without expanding across the gutter or another column.
        const column=model.columns.find(c=>c.page===r.page)?.columns.find(c=>c.index===r.column)
        const peers=model.questions.flatMap(other=>other.sourceRegions||[]).filter(b=>b.page===r.page&&b.column===r.column)
        const x=Math.min(r.x,column?.numberX??r.x)
        const right=Math.max(r.x+r.w,...peers.map(b=>b.x1))
        const below=peers.filter(b=>b.y0<r.y&&b.y1<r.y+r.h)
        const lowerLimit=below.length?Math.max(...below.map(b=>b.y1))+1:-Infinity
        const bottom=Math.max(r.y-4,Math.min(r.y,lowerLimit))
        blocks.push(await image({...r,x,y:bottom,w:right-x,h:r.y+r.h-bottom}))
      }
      for (const [regionIndex,b] of (q.sourceRegions || []).entries()) {
        // Font bounding boxes can overlap the next question by a few points.
        // Stop before its top rather than including a strip of the next stem.
        const starts = model.questions.filter(other => other !== q).flatMap(other => other.sourceRegions || [])
          .filter(other => other.page === b.page && other.column === b.column && other.y1 < b.y1 - 1)
          .map(other => other.y1 + 1)
        starts.push(...model.materials.flatMap(m => m.sourceRegions || [])
          .filter(r => r.page === b.page && r.column === b.column && r.y + r.h < b.y1 - 1).map(r => r.y + r.h + 1))
        const nextTop = starts.length ? Math.max(...starts) : b.y0 - 4
        // These are padded font extents, not ink edges. When adjacent extents
        // overlap, clamping at the next top cuts descenders off the last choices.
        // Split that overlap, retaining a small lower margin for the current row.
        const bottom = nextTop>b.y0 ? (b.y0+nextTop)/2-1 : Math.max(b.y0 - 4, nextTop)
        const peers=model.questions.filter(other=>other!==q).flatMap(other=>other.sourceRegions||[]).filter(r=>r.page===b.page&&r.column===b.column)
        const precedingMaterial=model.materials.flatMap(m=>m.sourceRegions||[]).some(r=>r.page===b.page&&r.column===b.column&&r.y+r.h>b.y1)
        // A continuation can begin with a vector diagram before the first text
        // line. At a new column/page, retain that leading source area when no
        // other question or shared material owns it.
        const leadingContinuation=regionIndex>0&&!precedingMaterial&&!peers.some(r=>r.y1>b.y1+1)
        const column=model.columns.find(c=>c.page===b.page)?.columns.find(c=>c.index===b.column)
        const top=leadingContinuation?Math.max(b.y1,pages.find(p=>p.page===b.page).heightPt*0.97):b.y1
        const x=leadingContinuation?Math.min(b.x0,column?.numberX??b.x0):b.x0
        const right=leadingContinuation?Math.max(b.x1,...peers.map(r=>r.x1)):b.x1
        blocks.push(await image({ page: b.page, x, y: bottom, w: right-x, h: top - bottom }))
      }
      questions.push({ number: q.number, content: printedContent(blocks), correct: q.proposedAnswer?.position ?? null, options: ['A', 'B', 'C', 'D'], sourcePages: q.pages, warnings: q.reviewReasons || [], reviewConfirmed: false })
    }
    return { questions, sourceType: 'PDF', expectedCount: model.stats.expectedQuestions, answerKeyCount: model.stats.answerKeyEntries, answerKeyPage: model.stats.answerKeyPage, warnings: [...(model.stats.missingNumbers?.length ? [`Missing question numbers: ${model.stats.missingNumbers.join(', ')}. Check the paper before publishing.`] : []), ...(model.stats.duplicateNumbers?.length ? [`Repeated question numbers: ${model.stats.duplicateNumbers.join(', ')}. Check the paper.`] : [])] }
  } finally { await opened.geometryPdf?.loadingTask?.destroy(); await opened.pdf.loadingTask?.destroy() }
}

const ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const elements = (node, name) => [...node.getElementsByTagNameNS(ns, name)]
const xml = text => {
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  if (doc.querySelector('parsererror')) throw new Error('The Word document is damaged.')
  return doc
}

export async function preparePrintedDocx(bytes, onProgress = () => {}, exam) {
  const zip = await JSZip.loadAsync(bytes)
  const document = zip.file('word/document.xml')
  if (!document) throw new Error('Choose a valid .docx Word document.')
  const doc = xml(await document.async('string'))
  const relFile = zip.file('word/_rels/document.xml.rels')
  const relations = relFile ? [...xml(await relFile.async('string')).getElementsByTagName('Relationship')] : []
  const questions = [], warnings = []
  let current = null,subject=null,subjectHeading=null
  for (const p of elements(doc, 'p')) {
    if (p.parentElement?.closest('txbxContent')) continue
    const text = [...p.getElementsByTagName('*')].filter(n => n.namespaceURI === ns)
      .map(n => n.localName === 't' ? n.textContent : n.localName === 'tab' ? '    ' : ['br', 'cr'].includes(n.localName) ? '\n' : '').join('')
    const heading=sourceSubjectHeading(text,exam)
    if(heading){subject=heading;subjectHeading=text.trim();current=null;continue}
    const number = Number(text.trim().match(/^(\d+)\s*[.)]/)?.[1])
    const bold = elements(p, 'b').some(b => !['0', 'false'].includes(b.getAttributeNS(ns, 'val')))
    if (number === questions.length + 1 && bold) {
      current = { number, blocks: [], correct: null, options: ['1', '2', '3', '4'], warnings: [],...(subject?{subject,subjectSource:'source-heading',subjectHeading}:{}) }
      questions.push(current)
      onProgress(`Reading Word question ${number}…`)
    }
    if (!current) continue
    if (text.trim()) current.blocks.push({ type: 'text', text, bold })
    const blips = [...p.getElementsByTagNameNS('http://schemas.openxmlformats.org/drawingml/2006/main', 'blip')]
    for (const blip of blips) {
      const id = blip.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed')
      const rel = relations.find(r => r.getAttribute('Id') === id)
      const target = rel?.getAttribute('Target') || ''
      if (!rel || rel.getAttribute('TargetMode') === 'External' || !/^media\/[^/]+\.(png|jpe?g|webp)$/i.test(target)) { current.warnings.push('A Word image cannot be displayed. Export this document as PDF to preserve it.'); continue }
      const file = zip.file(`word/${target}`)
      if (!file) throw new Error('A picture is missing from the Word document.')
      const type = /\.png$/i.test(target) ? 'png' : /\.webp$/i.test(target) ? 'webp' : 'jpeg'
      current.blocks.push({ type: 'image', src: `data:image/${type};base64,${await file.async('base64')}`, alt: 'Picture from the Word paper' })
    }
    for (const pict of elements(p, 'pict')) {
      const lines = [...pict.getElementsByTagNameNS('urn:schemas-microsoft-com:vml', 'line')]
      // The DSC document uses legacy VML horizontal separator lines. Preserve
      // these locally; refuse other legacy drawings rather than dropping them.
      let supported = lines.length > 0
      for (const line of lines) {
        const point = s => String(s).split(',').map(v => Number(v.replace(/pt$/, '')))
        const from = point(line.getAttribute('from')), to = point(line.getAttribute('to'))
        // Long, almost vertical margin/column rules are page furniture, not
        // question figures. Reflowed Word delivery intentionally omits them.
        const pageHeight = Number(elements(doc, 'pgSz')[0]?.getAttributeNS(ns, 'h') || 16840) / 20
        if ([...from, ...to].every(Number.isFinite) && Math.abs(from[0] - to[0]) < 4 && Math.abs(from[1] - to[1]) > pageHeight * (from[0] < 0 && to[0] < 0 ? 0.6 : 0.8)) continue
        if (from.length !== 2 || to.length !== 2 || ![...from, ...to].every(Number.isFinite) || Math.abs(from[1] - to[1]) > 0.1) { supported = false; continue }
        const canvas = window.document.createElement('canvas'); canvas.width = Math.min(1200, Math.max(2, Math.ceil(Math.abs(to[0] - from[0]) * 2))); canvas.height = 6
        const ctx = canvas.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0, 0, canvas.width, 6); ctx.strokeStyle = 'black'; ctx.beginPath(); ctx.moveTo(0, 3); ctx.lineTo(canvas.width, 3); ctx.stroke()
        current.blocks.push({ type: 'image', src: canvas.toDataURL('image/png'), alt: 'Line from the Word paper' })
      }
      if (!supported) current.warnings.push('A Word drawing cannot be displayed. Export as PDF to preserve it.')
    }
    if (p.getElementsByTagNameNS('http://schemas.openxmlformats.org/officeDocument/2006/math', 'oMath').length) current.warnings.push('This question uses a Word equation. Export as PDF to preserve its appearance.')
  }
  if (!questions.length) throw new Error('No numbered, bold question headings were found. Export this Word paper as PDF and upload it to preserve its layout.')
  warnings.push('Word text and pictures are preserved in reading order. Page layout may differ. Check every question; export as PDF if a table, equation or layout is important.')
  const prepared=questions.map(({ blocks, ...q }) => ({ ...q, content: printedContent(blocks) }))
  return { sourceType: 'DOCX', warnings, questions: prepared,sections:importedSubjectSections(prepared) }
}
