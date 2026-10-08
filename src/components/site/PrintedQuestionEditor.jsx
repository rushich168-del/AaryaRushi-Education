import { useState } from 'react'
import { printedContent, readPrintedContent } from '../../services/printedPaperContract.js'
import PrintedQuestionContent from './PrintedQuestionContent.jsx'
import SourcePagePicker from './SourcePagePicker.jsx'

const input = 'w-full rounded-lg border border-slate-300 p-2'
const button = 'rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold disabled:opacity-40'

export default function PrintedQuestionEditor({ question, sourceFile, answerKeyPage, onSave, onClose }) {
  const [blocks, setBlocks] = useState(() => readPrintedContent(question.content)?.blocks || [{type:'text',text:question.content}])
  const [number, setNumber] = useState(question.number)
  const [labels, setLabels] = useState(question.options)
  const [error, setError] = useState('')
  return <div className="space-y-4 rounded-xl border border-blue-200 bg-blue-50 p-4" aria-label="Edit question">
    <div className="flex justify-between gap-3"><h4 className="font-bold">Edit question {question.number}</h4><button type="button" className={button} onClick={onClose}>Cancel editing</button></div>
    <p className="text-sm">Edit text, remove an incorrect image, or select the correct region from the PDF. Include the complete question, all four choices and any shared directions. Changes need a fresh review.</p>
    <label className="block text-sm">Printed question number<input className={input} type="number" min="1" max="500" value={number} onChange={e=>setNumber(e.target.value)}/></label>
    {blocks.map((block,i)=><div key={i} className="space-y-2 rounded-lg border bg-white p-3">
      {block.type==='text' ? <label className="block text-sm">Text block {i+1}<textarea rows={6} className={input} value={block.text} onChange={e=>setBlocks(old=>old.map((b,j)=>j===i?{...b,text:e.target.value}:b))}/></label> : <img src={block.src} alt={block.alt || 'Current question image'} className="max-h-80 max-w-full"/>}
      <div className="flex flex-wrap gap-2"><button type="button" className={button} onClick={()=>setBlocks(old=>old.filter((_,j)=>j!==i))}>Remove block {i+1}</button><button type="button" className={button} disabled={i===0} onClick={()=>setBlocks(old=>{const next=[...old];[next[i-1],next[i]]=[next[i],next[i-1]];return next})}>Move up</button></div>
    </div>)}
    <button type="button" className={button} onClick={()=>setBlocks(old=>[...old,{type:'text',text:''}])}>Add text block</button>
    <details><summary className="cursor-pointer font-semibold">Select a corrected image from PDF</summary>
      <SourcePagePicker sourceFile={sourceFile} initialPage={question.sourcePages?.[0] || 1} answerKeyPage={answerKeyPage} onCrop={(src,page)=>{setBlocks(old=>[...old,{type:'image',src,alt:`Teacher-selected source, page ${page}`}]);setError('')}}/>
    </details>
    <div className="grid gap-2 sm:grid-cols-4">{labels.map((label,i)=><label key={i} className="text-sm">Answer button {i+1}<input className={input} value={label} onChange={e=>setLabels(old=>old.map((v,j)=>j===i?e.target.value:v))}/></label>)}</div>
    {blocks.length>0 && <details><summary className="cursor-pointer font-semibold">Preview changes</summary><PrintedQuestionContent text={printedContent(blocks)}/></details>}
    {error && <p role="alert" className="text-red-800">{error}</p>}
    <button type="button" className="rounded-lg bg-blue-700 px-4 py-2 font-semibold text-white" onClick={()=>{try{
      if(!Number.isInteger(Number(number)) || Number(number)<1 || Number(number)>500)throw new Error('Enter a question number from 1 to 500.')
      if(!blocks.length || blocks.some(b=>b.type==='text'&&!b.text.trim()) || labels.some(l=>!l.trim()))throw new Error('Add question content and fill all four answer labels. Remove empty text blocks.')
      onSave({...question,number:Number(number),content:printedContent(blocks),options:labels,reviewConfirmed:false,edited:true})
    }catch(e){setError(e.message)}}}>Apply question changes</button>
  </div>
}

