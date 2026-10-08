import {useEffect,useMemo,useState} from 'react'
import {CircleAlert,IndianRupee,Pencil,Plus,ReceiptText,Search,Sparkles,Users,X} from 'lucide-react'
import StaffWorkspace from './StaffWorkspace.jsx'
import {paymentService,rupees} from '../../services/paymentService.js'
import './admin-fees.css'

const blank={id:'',exam_id:'',level_id:'',title:'',description:'',features:'',duration_label:'',amount:'',original:'',is_active:true,is_featured:false,sort_order:100}
const toForm=p=>({...blank,...p,level_id:p.level_id||'',features:(p.features||[]).join('\n'),amount:String(p.amount_paise/100),original:p.original_amount_paise?String(p.original_amount_paise/100):''})
const paise=v=>Math.round(Number(String(v).replace(/[,₹\s]/g,''))*100)

function PlanEditor({form,setForm,programs,onClose,onSaved}){
 const [busy,setBusy]=useState(false),[error,setError]=useState('')
 const program=programs.find(p=>p.id===form.exam_id)
 const set=(k,v)=>setForm(f=>({...f,[k]:v}))
 async function save(e){
  e.preventDefault();if(busy)return;setError('')
  const amount=paise(form.amount),original=form.original?paise(form.original):null
  if(!form.exam_id)return setError('Choose a program.')
  if(form.title.trim().length<2)return setError('Enter a course name.')
  if(!(amount>=100))return setError('Enter a fee of at least ₹1.')
  if(original!==null&&!(original>amount))return setError('The original price must be higher than the fee.')
  setBusy(true)
  try{await paymentService.savePlan({id:form.id||'',exam_id:form.exam_id,level_id:form.level_id||'',title:form.title.trim(),description:form.description.trim(),
   features:form.features.split('\n').map(x=>x.trim()).filter(Boolean).slice(0,8),duration_label:form.duration_label.trim(),amount_paise:amount,original_amount_paise:original??'',
   is_active:form.is_active,is_featured:form.is_featured,sort_order:Number(form.sort_order)||100});onSaved()}
  catch(e2){setError(e2.message||'Could not save. Please retry.')}finally{setBusy(false)}
 }
 return <div className="af-drawer-back" onMouseDown={e=>{if(e.target===e.currentTarget&&!busy)onClose()}}>
  <form className="af-drawer" role="dialog" aria-modal="true" aria-labelledby="af-edit-title" onSubmit={save} onKeyDown={e=>{if(e.key==='Escape'&&!busy)onClose()}}>
   <header><h2 id="af-edit-title">{form.id?'Edit course fee':'Add course fee'}</h2><button type="button" className="af-icon-btn" aria-label="Close" disabled={busy} onClick={onClose}><X size={20}/></button></header>
   <div className="af-drawer-body">
    <label>Program<select value={form.exam_id} onChange={e=>setForm(f=>({...f,exam_id:e.target.value,level_id:''}))} autoFocus><option value="">Choose a program</option>{programs.map(p=><option key={p.id} value={p.id}>{p.name}{p.open?'':' (closed for sign-up)'}</option>)}</select></label>
    {program&&<label>Class / track<select value={form.level_id} onChange={e=>set('level_id',e.target.value)}><option value="">Any class — student chooses at checkout</option>{program.tracks.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></label>}
    {program&&!program.open&&<p className="af-warn"><CircleAlert size={15}/> This program is closed for sign-up, so the fee will not be shown publicly until it is opened.</p>}
    <label>Course name<input value={form.title} maxLength={120} onChange={e=>set('title',e.target.value)} placeholder="e.g. SI & Constable Complete Course"/></label>
    <div className="af-row2"><label>Fee (₹)<input inputMode="decimal" value={form.amount} onChange={e=>set('amount',e.target.value)} placeholder="14999"/></label><label>Original price (₹) <small>optional, shows a discount</small><input inputMode="decimal" value={form.original} onChange={e=>set('original',e.target.value)} placeholder="18000"/></label></div>
    <label>Duration / batch note<input value={form.duration_label} maxLength={60} onChange={e=>set('duration_label',e.target.value)} placeholder="6 months · Morning & evening batches"/></label>
    <label>Short description<textarea rows={3} maxLength={600} value={form.description} onChange={e=>set('description',e.target.value)}/></label>
    <label>What's included <small>one per line, up to 8</small><textarea rows={4} value={form.features} onChange={e=>set('features',e.target.value)} placeholder={'Daily classes\nWeekly tests\nStudy material'}/></label>
    <div className="af-checks"><label><input type="checkbox" checked={form.is_active} onChange={e=>set('is_active',e.target.checked)}/> Show on website and allow payment</label><label><input type="checkbox" checked={form.is_featured} onChange={e=>set('is_featured',e.target.checked)}/> Highlight as “Most chosen”</label></div>
    <label className="af-small">Display order<input type="number" value={form.sort_order} onChange={e=>set('sort_order',e.target.value)}/></label>
    {form.id&&<p className="af-note">Changing the fee affects new payments only. Past receipts keep the amount that was paid.</p>}
    {error&&<p className="af-error" role="alert"><CircleAlert size={15}/> {error}</p>}
   </div>
   <footer><button type="button" className="af-btn af-btn-light" disabled={busy} onClick={onClose}>Cancel</button><button className="af-btn af-btn-yellow" disabled={busy}>{busy?'Saving…':form.id?'Save changes':'Add course fee'}</button></footer>
  </form>
 </div>
}

export default function AdminFeesPage(){
 const tab=new URLSearchParams(window.location.search).get('view')==='payments'?'payments':'fees'
 const [view,setView]=useState(tab)
 const [data,setData]=useState(null),[payments,setPayments]=useState(null),[error,setError]=useState(''),[retry,setRetry]=useState(0)
 const [form,setForm]=useState(null),[q,setQ]=useState(''),[status,setStatus]=useState('all')
 useEffect(()=>{let live=true;setError('')
  Promise.all([paymentService.adminPlans(),paymentService.adminPayments(500)]).then(([d,p])=>{if(live){setData(d);setPayments(p||[])}})
   .catch(e=>{if(live){setError(e.setupRequired?'Fees & payments are not set up in the database yet (migration 0049).':e.message);setData({plans:[],programs:[]});setPayments([])}})
  return()=>{live=false}},[retry])
 function go(v){setView(v);const u=new URL(window.location.href);v==='payments'?u.searchParams.set('view','payments'):u.searchParams.delete('view');window.history.replaceState(null,'',u)}
 const paid=(payments||[]).filter(p=>p.status==='paid')
 const total=paid.reduce((s,p)=>s+p.amount_paise,0)
 const month=paid.filter(p=>new Date(p.paid_at).getMonth()===new Date().getMonth()&&new Date(p.paid_at).getFullYear()===new Date().getFullYear()).reduce((s,p)=>s+p.amount_paise,0)
 const rows=useMemo(()=>(payments||[]).filter(p=>(status==='all'||p.status===status)&&(!q.trim()||[p.student,p.email,p.plan,p.receipt,p.razorpay_payment_id].join(' ').toLowerCase().includes(q.trim().toLowerCase()))),[payments,q,status])
 return <StaffWorkspace role="admin"><div className="af">
  <div className="af-head"><div><p className="staff-eyebrow">ONLINE ENROLLMENT</p><h2>Fees &amp; payments</h2><p className="af-lead">Set course fees shown on the website. Students who pay online are enrolled in their program automatically.</p></div>
   {view==='fees'&&<button className="af-btn af-btn-yellow" disabled={!data||!!error} onClick={()=>setForm({...blank})}><Plus size={17}/> Add course fee</button>}</div>
  <div className="af-tiles">
   <div><span><IndianRupee size={18}/></span><small>Collected online</small><strong>{payments?rupees(total):'—'}</strong></div>
   <div><span><IndianRupee size={18}/></span><small>This month</small><strong>{payments?rupees(month):'—'}</strong></div>
   <div><span><Users size={18}/></span><small>Paid enrollments</small><strong>{payments?paid.length:'—'}</strong></div>
   <div><span><ReceiptText size={18}/></span><small>Courses with fees</small><strong>{data?data.plans.filter(p=>p.is_active).length:'—'}</strong></div>
  </div>
  <div className="af-tabs" role="tablist"><button role="tab" aria-selected={view==='fees'} onClick={()=>go('fees')}>Course fees</button><button role="tab" aria-selected={view==='payments'} onClick={()=>go('payments')}>Payments{payments?.length?<span>{payments.length}</span>:null}</button></div>
  {error&&<div className="af-alert" role="alert"><CircleAlert size={18}/><span>{error}</span><button className="af-btn af-btn-light" onClick={()=>setRetry(x=>x+1)}>Retry</button></div>}
  {!data?<p role="status" className="af-muted">Loading…</p>:view==='fees'?
   (data.plans.length?<ul className="af-plans">{data.plans.map(p=><li key={p.id} className={p.is_active?'':'is-off'}>
     <div className="af-plan-main"><p className="af-plan-prog">{p.program}{p.track?' · '+p.track:' · any class'}</p><h3>{p.title}{p.is_featured&&<span className="af-tag"><Sparkles size={12}/> Most chosen</span>}{!p.is_active&&<span className="af-tag af-tag-off">Hidden</span>}</h3><p className="af-muted">{p.duration_label||'—'} · {p.paid_count} paid</p></div>
     <div className="af-plan-price"><strong>{rupees(p.amount_paise)}</strong>{p.original_amount_paise&&<s>{rupees(p.original_amount_paise)}</s>}</div>
     <button className="af-btn af-btn-light" onClick={()=>setForm(toForm(p))}><Pencil size={15}/> Edit</button></li>)}</ul>
   :!error&&<div className="af-empty"><IndianRupee size={28}/><h3>No course fees yet</h3><p>Add a fee for a program and it appears on the homepage and Courses &amp; fees page with an “Enroll &amp; pay” button.</p><button className="af-btn af-btn-yellow" onClick={()=>setForm({...blank})}><Plus size={17}/> Add your first course fee</button></div>)
  :<>
   <div className="af-tools"><div className="af-chips">{[['all','All'],['paid','Paid'],['failed','Failed'],['created','Not completed']].map(([k,l])=><button key={k} aria-pressed={status===k} onClick={()=>setStatus(k)}>{l}</button>)}</div><label className="af-search"><Search size={16}/><input type="search" aria-label="Search payments" placeholder="Student, receipt or payment ID" value={q} onChange={e=>setQ(e.target.value)}/></label></div>
   {rows.length?<div className="af-table-wrap"><table className="af-table"><thead><tr><th>Student</th><th>Course</th><th>Amount</th><th>Status</th><th>Receipt</th><th>Date</th></tr></thead><tbody>{rows.map(p=><tr key={p.id}>
     <td><b>{p.student}</b><small>{p.email}</small></td><td>{p.plan}<small>{p.program} · {p.track}</small></td><td className="af-amt">{rupees(p.amount_paise)}</td>
     <td><span className={'af-pill s-'+p.status}>{p.status==='paid'?(p.enrolled?'Paid · enrolled':'Paid'):p.status==='failed'?'Failed':'Not completed'}</span></td>
     <td className="af-mono">{p.receipt}{p.razorpay_payment_id&&<small>{p.razorpay_payment_id}</small>}</td><td>{new Date(p.paid_at||p.created_at).toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short'})}</td></tr>)}</tbody></table></div>
   :<div className="af-empty"><ReceiptText size={28}/><h3>{payments.length?'No payments match':'No payments yet'}</h3><p>{payments.length?'Try another filter or search.':'Online payments from students will appear here.'}</p></div>}
  </>}
  {form&&<PlanEditor form={form} setForm={setForm} programs={data?.programs||[]} onClose={()=>setForm(null)} onSaved={()=>{setForm(null);setRetry(x=>x+1)}}/>}
 </div></StaffWorkspace>
}
