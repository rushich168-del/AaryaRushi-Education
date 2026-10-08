import {useEffect,useState} from 'react'
import {examLibraryService} from '../../services/examLibraryService.js'

export default function CreatorSharedLibrary({refresh=0,onLoaded=()=>{},onBringBack=null,onDeleted=null}) {
 const [papers,setPapers]=useState([]),[loading,setLoading]=useState(true),[error,setError]=useState(''),[retry,setRetry]=useState(0)
 const [search,setSearch]=useState(''),[program,setProgram]=useState('')
 const [deleting,setDeleting]=useState('')
 async function back(p){if(deleting)return;setDeleting(p.id);setError('');try{await onBringBack(p.id);setRetry(x=>x+1)}catch(e){setError(e.message)}finally{setDeleting('')}}
 async function remove(p){if(deleting||!window.confirm('Delete '+p.title+'? Your draft and already-published student tests and results are kept.'))return;setDeleting(p.id);setError('');try{await examLibraryService.archive(p.id);if(onDeleted)await onDeleted(p);setRetry(x=>x+1)}catch(e){setError(e.message)}finally{setDeleting('')}}
 useEffect(()=>{let active=true;setLoading(true);setError('');examLibraryService.list().then(rows=>{if(active){setPapers(rows);onLoaded(rows)}}).catch(e=>{if(active)setError(e.message)}).finally(()=>{if(active)setLoading(false)});return()=>{active=false}},[refresh,retry])
 const count=(n,word)=>String(n)+' '+word+(Number(n)===1?'':'s')
 const visible=papers.filter(p=>(!program||p.exam_id===program)&&`${p.title} ${p.exam_name} ${(p.subjects||[]).join(' ')}`.toLowerCase().includes(search.trim().toLowerCase()))
 return <section className="lp-panel" aria-label="Shared institute library">
  <div className="lp-panel-title"><h2>Shared papers</h2><button disabled={loading} onClick={()=>setRetry(x=>x+1)}>Refresh shared library</button></div>
  <p>Finished papers your institute can publish. Admins and teachers publish them to a program’s students.</p>
  {loading?<p role="status">Loading shared papers…</p>:error?<p role="alert">{error} <button onClick={()=>setRetry(x=>x+1)}>Retry shared library</button></p>:!papers.length?<p>No shared papers available. Save a finished paper to an assigned institute program.</p>:<>
   {(papers.length>1||!!search||!!program)&&<div className="lp-toolbar"><label>Find a shared paper<input aria-label="Find a shared paper" type="search" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Title, subject or program…"/></label><label>Shared program<select aria-label="Shared program" value={program} onChange={e=>setProgram(e.target.value)}><option value="">All shared programs</option>{[...new Map(papers.map(p=>[p.exam_id,p])).values()].map(p=><option key={p.exam_id} value={p.exam_id}>{p.exam_name}</option>)}</select></label></div>}
   {visible.length?visible.map(p=><article className="lp-lib-row" key={p.id}><div className="lp-lib-info"><div className="lp-lib-text"><strong className="lp-lib-title" title={p.title}>{p.title}</strong><p>{p.exam_name} · {count(p.question_count,'question')} · {count(p.duration,'minute')} · {count(Number(p.question_count)*Number(p.marks),'mark')}</p>{!p.can_delete&&!p.can_bring_back&&<p className="lp-management-note">Shared by another account. Only that creator or an admin can bring back or delete it.</p>}</div></div><div className="lp-lib-actions"><span className="lp-lib-badge is-shared">Shared · v{p.version}</span>{onBringBack&&p.can_bring_back&&<button className="lp-lib-bring-back" disabled={!!deleting} aria-label={'Bring back '+p.title} onClick={()=>back(p)}>{deleting===p.id?'Bringing back…':'Bring back'}</button>}{p.can_delete&&<button className="lp-lib-delete" disabled={!!deleting} aria-label={'Delete shared paper '+p.title} onClick={()=>remove(p)}>Delete</button>}</div></article>):<p>No matching shared papers. Change the search or program filter.</p>}
  </>}
 </section>
}
