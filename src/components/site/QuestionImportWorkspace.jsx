import { useState } from 'react'
import AcademicContext from './AcademicContext.jsx'
import { contextFromUrl } from '../../services/programService.js'
import { importCandidate, reviseImportCandidate, validateImportCandidate, readyForDraft } from '../../services/questionImportContract.js'
import PdfImportWorkspace from './PdfImportWorkspace.jsx'
import PrintedPaperWorkspace from './PrintedPaperWorkspace.jsx'

const sources = [['PRINTED', 'PDF / Word → Online test'], ['PDF', 'Editable PDF extraction'], ['EXCEL_CSV', 'Excel / CSV'], ['PASTE', 'Paste Text']]

export default function QuestionImportWorkspace({ onBack, initialItems = [] }) {
  const [context, setContext] = useState(contextFromUrl)
  const [kind, setKind] = useState('PRINTED')
  const [files, setFiles] = useState({})
  const [text, setText] = useState('')
  // Future adapters supply normalized candidates here. No sample/extracted data is invented.
  const [items, setItems] = useState(() => initialItems.map(item => importCandidate(item, context)))
  function revise(id, changes) {
    setItems(current => current.map(item => item.id === id ? reviseImportCandidate(item, changes) : item))
  }
  function back() {
    if ((items.length || text || Object.values(files).some(Boolean)) && !window.confirm('Discard this unsaved import workspace?')) return
    onBack()
  }

  if (kind === 'PDF' || kind === 'PRINTED') {
    return (
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Import source">
          {sources.map(([value, label]) => <button key={value} aria-pressed={kind===value} onClick={()=>setKind(value)} className={`rounded-lg border px-4 py-2 ${kind===value?'bg-blue-700 text-white':'bg-white'}`}>{label}</button>)}
        </div>
        {kind === 'PRINTED' ? <PrintedPaperWorkspace /> : <PdfImportWorkspace onBack={onBack} />}
      </div>
    )
  }

  return <div className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-2xl font-bold">Import Questions</h2><button onClick={back} className="text-blue-700 underline">Back to Question Bank</button></div>
    <p className="text-sm text-slate-600">Choose shared academic context for a future import. Each question will be reviewed and saved as a draft before separate teacher approval.</p>
    <AcademicContext value={context} onChange={setContext} authoring syncUrl={false}/>
    <div className="flex flex-wrap gap-2" role="group" aria-label="Import source">
      {sources.map(([value, label]) => <button key={value} aria-pressed={kind===value} onClick={()=>setKind(value)} className={`rounded-lg border px-4 py-2 ${kind===value?'bg-blue-700 text-white':'bg-white'}`}>{label}</button>)}
    </div>
    <section className="space-y-3 rounded-xl border bg-white p-4" aria-label="Import source input">
      {kind==='PASTE' ? <label className="block">Source text<textarea className="mt-2 block w-full rounded-lg border p-3" rows={6} value={text} onChange={e=>setText(e.target.value)} placeholder="Paste source questions here. Parsing is not connected yet."/></label>
        : <label className="block">{kind==='PDF'?'Source PDF':'Source spreadsheet'}<input key={kind} type="file" accept={kind==='PDF'?'.pdf':'.xlsx,.xls,.csv'} className="mt-2 block w-full" onChange={e=>setFiles(current=>({...current,[kind]:e.target.files?.[0] || null}))}/></label>}
      {kind!=='PASTE' && files[kind] && <p className="break-all text-sm">Selected locally: {files[kind].name}</p>}
      <p role="status" className="text-sm text-amber-800">{kind==='PDF'?'PDF extraction':kind==='EXCEL_CSV'?'Excel / CSV parsing':'Text parsing'} is not connected in this milestone. Nothing is uploaded or extracted. This workspace is not saved when you leave or reload.</p>
    </section>
    <section aria-label="Import review" className="space-y-4">
      <h3 className="text-lg font-semibold">Review questions</h3>
      {!items.length && <p className="rounded-xl border border-dashed p-6 text-slate-600">No parsed questions yet. Future parsers will send questions here for correction and confirmation.</p>}
      {items.map((item, index) => {
        const validation = validateImportCandidate(item)
        return <article key={item.id} className="space-y-3 rounded-xl border bg-white p-4" aria-label={`Imported question ${index+1}`}>
          <label className="flex gap-2"><input type="checkbox" checked={item.included} onChange={e=>revise(item.id,{included:e.target.checked})}/>Include question {index+1}</label>
          <label className="block">Question text<textarea aria-label="Question text" className="block w-full rounded border p-2" value={item.content} onChange={e=>revise(item.id,{content:e.target.value})}/></label>
          {item.options.map((option,i)=><div key={i} className="flex items-center gap-2">
            <input type="radio" name={`answer-${item.id}`} aria-label={`Correct answer ${i+1}`} checked={item.correctAnswerIndex===i} onChange={()=>revise(item.id,{correctAnswerIndex:i})}/>
            <input aria-label={`Option ${i+1}`} className="min-w-0 flex-1 rounded border p-2" value={option} onChange={e=>revise(item.id,{options:item.options.map((old,j)=>i===j?e.target.value:old)})}/>
            <button disabled={item.options.length<=2} aria-label={`Remove option ${i+1}`} onClick={()=>revise(item.id,{options:item.options.filter((_,j)=>i!==j),correctAnswerIndex:null})}>×</button>
          </div>)}
          <button disabled={item.options.length>=6} className="text-blue-700 disabled:opacity-40" onClick={()=>revise(item.id,{options:[...item.options,'']})}>Add option</button>
          <label className="block">Explanation<textarea className="block w-full rounded border p-2" value={item.explanation} onChange={e=>revise(item.id,{explanation:e.target.value})}/></label>
          <label className="block">Difficulty<select className="ml-2 rounded border p-2" value={item.difficulty} onChange={e=>revise(item.id,{difficulty:e.target.value})}>{['EASY','MEDIUM','HARD'].map(value=><option key={value}>{value}</option>)}</select></label>
          <AcademicContext value={item.academic} onChange={academic=>revise(item.id,{academic})} authoring syncUrl={false}/>
          <p className="break-all text-sm text-slate-500">Source: {item.source.kind} · {item.source.name || 'Unnamed source'}{item.source.page!=null?` · Page ${item.source.page}`:''}{item.source.row!=null?` · Row ${item.source.row}`:''} {item.source.reference}</p>
          {validation.errors.length>0 && <ul className="list-inside list-disc text-sm text-red-700">{validation.errors.map(error=><li key={error}>{error}</li>)}</ul>}
          <label className="flex gap-2"><input type="checkbox" checked={item.confirmed} disabled={!item.included||validation.state!=='VALID'} onChange={e=>setItems(current=>current.map(row=>row.id===item.id?{...row,confirmed:e.target.checked,validation}:row))}/>I reviewed this question for draft import</label>
        </article>
      })}
      <p className="text-sm">{items.filter(readyForDraft).length} valid, included and teacher-confirmed questions. Confirmation is not approval.</p>
      <button disabled className="rounded-lg bg-slate-200 px-4 py-2 text-slate-500">Save drafts — not connected yet</button>
      <p className="text-sm text-slate-500">Import persistence and source tracking will be connected with the parser adapters. No questions are written by this shell.</p>
    </section>
  </div>
}
