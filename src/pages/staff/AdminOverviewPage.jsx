import {useEffect,useState} from 'react'
import {BookOpen,FileText,LibraryBig,ClipboardList,Users,ArrowRight,Send,CheckCircle2} from 'lucide-react'
import StaffWorkspace from './StaffWorkspace.jsx'
import {adminDashboardService} from '../../services/adminDashboardService.js'
import {publishedDate,resultsLink} from './publishing/paperFormat.js'

const coursesPath='/dashboard/admin/teaching/courses'
const libraryPath='/dashboard/admin/teaching/library'
const DASHBOARD_PAPERS=4
// Papers still waiting to be published come first; the dashboard shows a few, the library has all.
export function dashboardPapers(papers=[],published=[]){
 const done=new Set(published.filter(t=>t.version_id).map(t=>t.version_id+':'+t.exam_id))
 const rows=papers.map(p=>({...p,published:done.has(p.id+':'+p.exam_id)}))
 return [...rows.filter(p=>!p.published),...rows.filter(p=>p.published)]
}
function paperMeta(p){return [p.exam_name,p.question_count!=null&&p.question_count+' questions',p.duration!=null&&p.duration+' min'].filter(Boolean).join(' · ')}
function PaperRows({papers}){
 const shown=papers.slice(0,DASHBOARD_PAPERS),waiting=papers.filter(p=>!p.published).length
 return <><p className="admin-section-note admin-papers-summary">{waiting?`${waiting} ${waiting===1?'paper is':'papers are'} ready to publish`:'Every ready paper is published'}{papers.length>shown.length?` · Showing ${shown.length} of ${papers.length}`:''}</p>
 <ul className="admin-paper-list" aria-label="Ready papers">{shown.map(p=><li className={'admin-paper-row'+(p.published?' is-published':'')} key={p.id}><span className="admin-icon admin-paper-icon"><FileText size={20}/></span><div className="admin-paper-main"><h3>{p.title}</h3><p>{paperMeta(p)}</p></div><span className={'admin-status'+(p.published?' is-muted':'')}>{p.published?<><CheckCircle2 size={12}/>Published</>:'Ready · v'+p.version}</span>{p.published?<a className="admin-paper-action is-quiet" href={libraryPath+'?paper='+encodeURIComponent(p.id)} aria-label={'View '+p.title+' in the library'}>View →</a>:<a className="admin-paper-action" href={libraryPath+'?paper='+encodeURIComponent(p.id)+'&publish=1'} aria-label={'Publish '+p.title}><Send size={14}/>Publish</a>}</li>)}</ul></>
}
export function publishedStatus(p,now=Date.now()){
 if(p.closes_at&&Date.parse(p.closes_at)<=now)return 'Closed'
 if(p.opens_at&&Date.parse(p.opens_at)>now)return 'Scheduled'
 return 'Available now'
}
function Section({title,icon:Icon,action,href,section,loading,retry,children,empty}){
 return <section className="admin-panel" aria-label={title}><div className="admin-section-heading"><h2><Icon size={21}/>{title}</h2><a href={href}>{action}<ArrowRight size={16}/></a></div>{loading?<p role="status">Loading {title.toLowerCase()}…</p>:section?.error?<div role="alert" className="staff-error">{section.error} <button className="staff-link" onClick={retry}>Retry {title.toLowerCase()}</button></div>:section?.data?.length?children:<div className="admin-empty">{empty}</div>}</section>
}
export default function AdminOverviewPage({api=adminDashboardService}){
 const [data,setData]=useState({}),[loading,setLoading]=useState(true),[retry,setRetry]=useState(0)
 useEffect(()=>{let active=true;setLoading(true);api.load().then(result=>{if(active)setData(result)}).catch(e=>{if(active)setData(Object.fromEntries(['courses','materials','papers','published','people'].map(key=>[key,{error:e.message||'Dashboard unavailable. Please retry.'}])))}).finally(()=>{if(active)setLoading(false)});return()=>{active=false}},[api,retry])
 const props=key=>({section:data[key],loading,retry:()=>setRetry(x=>x+1)})
 return <StaffWorkspace role="admin"><div className="admin-dashboard"><div className="admin-dashboard-heading"><div><p className="staff-eyebrow">YOUR INSTITUTE. ONE WORKSPACE.</p><h2>Dashboard</h2></div><button className="staff-button staff-button-light" disabled={loading} onClick={()=>setRetry(x=>x+1)}>Refresh dashboard</button></div>
 <Section title="Courses & batches" icon={BookOpen} action="Manage courses" href="/dashboard/admin/assignments" {...props('courses')} empty={<><strong>No courses yet</strong><p>Create a course, then set up its batches and teaching access.</p><a href={coursesPath}>Create your first course →</a></>}><div className="admin-card-grid">{data.courses?.data?.slice(0,4).map(c=><article className="admin-summary-card" key={c.id}><span className="admin-icon"><BookOpen/></span><div><h3>{c.name}</h3><p>{c.batches.length} {c.batches.length===1?'batch':'batches'}</p><a href={'/dashboard/admin/assignments?course='+encodeURIComponent(c.id)}>Manage course →</a></div></article>)}</div></Section>
 <Section title="Study materials" icon={FileText} action="Manage materials" href={coursesPath} {...props('materials')} empty={<><strong>No lesson materials yet</strong><p>Add lesson content within a course. Standalone PDF uploads are not available in this workspace yet.</p><a href={coursesPath}>Open course lessons →</a></>}><p className="admin-section-note">Course lesson content. Manage draft and published materials within each course.</p>{data.materials?.data?.slice(0,4).map(m=><article className="admin-row" key={m.id}><span className="admin-icon"><FileText/></span><div><h3>{m.title}</h3><p>{m.course} · {m.is_published?'Published lesson':'Draft lesson'}</p></div><a href={coursesPath+'?course='+encodeURIComponent(m.course_id)+'&lesson='+encodeURIComponent(m.id)}>Manage material →</a></article>)}</Section>
 <Section title="Ready papers in library" icon={LibraryBig} action="Open paper library" href={libraryPath} {...props('papers')} empty={<><strong>No ready papers yet</strong><p>A creator completes paper checks and saves a ready version before it enters the shared library.</p></>}><PaperRows papers={dashboardPapers(data.papers?.data,data.published?.data||[])}/></Section>
 <Section title="Published tests" icon={ClipboardList} action="View published tests" href={libraryPath+'?view=published'} {...props('published')} empty={<><strong>No published tests yet</strong><p>Select a program and test name in the paper library, then publish to its students.</p></>}>{data.published?.data?.slice(0,4).map(p=><article className="admin-row" key={p.id}><div><h3>{p.title}</h3><p>{[p.program||p.course,p.program?'Program students':(p.batches||[]).join(', ')||'Batch details unavailable',publishedDate(p)&&'Published '+publishedDate(p)].filter(Boolean).join(' · ')}</p></div><span className="admin-status">{publishedStatus(p)}</span><a href={resultsLink('/dashboard/admin/teaching/results',p)} aria-label={'Student results for '+p.title}>Student results →</a></article>)}</Section>
 <section className="admin-panel" aria-label="People & access"><div className="admin-section-heading"><h2><Users size={21}/>People & access</h2></div><div className="admin-card-grid"><a className="admin-summary-card" href="/dashboard/admin/teaching/students"><span className="admin-icon"><Users/></span><div><h3>Students</h3><p>Institute roster and learning progress</p><span>Manage students →</span></div></a><a className="admin-summary-card" href="/dashboard/admin"><span className="admin-icon"><Users/></span><div><h3>Staff & access</h3><p>Teachers and test creators</p><span>Manage staff →</span></div></a></div>{loading?<p role="status">Loading staff access…</p>:data.people?.error?<p role="alert">{data.people.error} <button className="staff-link" onClick={()=>setRetry(x=>x+1)}>Retry staff access</button></p>:<p className="admin-section-note">{data.people?.data?.length||0} staff accounts · Check assignments and account status in Staff & access.</p>}</section>
 </div></StaffWorkspace>
}
