import {useRef,useState} from 'react'
import {Upload,FileText} from 'lucide-react'

export default function CreatorPaperUpload({file,busy,progress,onChoose,onPrepare}){
 const input=useRef(null),[dragging,setDragging]=useState(false)
 return <div className={'lp-upload'+(dragging?' is-dragging':'')} onDragOver={e=>{e.preventDefault();if(!busy)setDragging(true)}} onDragLeave={()=>setDragging(false)} onDrop={e=>{e.preventDefault();setDragging(false);if(!busy)onChoose(e.dataTransfer.files?.[0])}}>
  <Upload size={30} aria-hidden="true"/>
  <div className="lp-upload-copy"><strong>Upload your question paper</strong><p>Drag a PDF or DOCX here, or choose a file.</p><small>Text-based PDF or Word (.docx) · up to 30 MB</small>
   <input ref={input} className="lp-file-input" aria-label="Source paper" type="file" accept=".pdf,.docx" disabled={busy} onChange={e=>{onChoose(e.target.files?.[0]);e.target.value=''}}/>
   {file&&<p className="lp-selected-file"><FileText size={16} aria-hidden="true"/>{file.name} · {(file.size/1024/1024).toFixed(1)} MB</p>}
  </div>
  <div className="lp-upload-actions"><button disabled={busy} onClick={()=>input.current.click()}>Choose file</button><button className="lp-primary" disabled={busy||!file} onClick={onPrepare}>{busy&&progress?'Preparing…':'Prepare paper'}</button></div>
  {progress&&<div className="lp-preparation-progress" role="status"><span className="lp-progress-dot" aria-hidden="true"/>{progress}</div>}
 </div>
}
