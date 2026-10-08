import {useMemo,useState} from 'react'
import {LockKeyhole,Phone,ReceiptText,Search,Smartphone,CreditCard,Landmark} from 'lucide-react'
import SiteLayout from '../../components/site/SiteLayout.jsx'
import FeeCard,{usePublicPlans} from '../../components/site/FeeCard.jsx'
import './home-v2.css'
import './courses.css'
import brand from '../../config/brand.js'

export default function CoursesPage(){
 const {plans,error,setup,retry}=usePublicPlans()
 const [cat,setCat]=useState('All'),[q,setQ]=useState('')
 const cats=useMemo(()=>{const m=new Map();for(const p of plans||[])m.set(p.category,(m.get(p.category)||0)+1);return [...m]},[plans])
 const list=(plans||[]).filter(p=>(cat==='All'||p.category===cat)&&(!q.trim()||(p.title+' '+p.program+' '+(p.tracks||[]).map(t=>t.name).join(' ')+' '+(p.track||'')).toLowerCase().includes(q.trim().toLowerCase())))
 return <SiteLayout><div className="ksc-home2">
  <section className="cr-hero"><div className="ks-wrap">
   <p className="h2-eyebrow on-dark">Courses &amp; fees</p>
   <h1>Choose your course. Enroll online.</h1>
   <p>Transparent fees for every program. Pay securely with UPI, card or net banking — your course opens in your student portal right after payment.</p>
   <div className="cr-badges"><span><LockKeyhole size={15}/> Secured by Razorpay</span><span><Smartphone size={15}/> UPI</span><span><CreditCard size={15}/> Cards</span><span><Landmark size={15}/> Net banking</span><span><ReceiptText size={15}/> Instant receipt</span></div>
  </div></section>
  <section className="ks-wrap cr-body">
   {plans===null?<div className="h2-fee-grid">{[0,1,2].map(i=><div key={i} className="ks-fee is-loading" aria-hidden="true"/>)}<span className="ks-sr" role="status">Loading courses…</span></div>
   :!plans.length?<div className="h2-fee-empty"><ReceiptText size={28}/><div><h3>{error?'Courses could not be loaded':'Online fees are being updated'}</h3><p>{error?'Please check your connection and try again.':setup?'Fees will appear here once the institute publishes them.':'Call us for the latest fees and batch timings.'}</p></div>{error?<button type="button" className="ks-btn ks-btn-navy" onClick={retry}>Try again</button>:<a className="ks-btn ks-btn-navy" href={brand.contact.phoneHref}><Phone size={16}/> {brand.contact.phone}</a>}</div>
   :<>
    <div className="cr-tools">
     <div className="cr-chips" role="group" aria-label="Filter by program family">{[['All',plans.length],...cats].map(([c,n])=><button key={c} type="button" aria-pressed={cat===c} onClick={()=>setCat(c)}>{c}<span>{n}</span></button>)}</div>
     <label className="cr-search"><Search size={17}/><span className="ks-sr">Search courses</span><input type="search" placeholder="Search course or class" value={q} onChange={e=>setQ(e.target.value)}/></label>
    </div>
    {list.length?<div className="h2-fee-grid cr-grid">{list.map(p=><FeeCard key={p.id} plan={p}/>)}</div>:<p className="cr-none">No course matches “{q}”. <button type="button" onClick={()=>{setQ('');setCat('All')}}>Show all courses</button></p>}
   </>}
   <div className="cr-help"><div><h2>Not sure which course fits?</h2><p>Talk to our team or visit for a free demo class at our {brand.contact.city} centre.</p></div><div className="cr-help-actions"><a className="ks-btn ks-btn-yellow" href={brand.contact.phoneHref}><Phone size={16}/> {brand.contact.phone}</a><a className="ks-btn ks-btn-ghost" href="/contact">Send an enquiry</a></div></div>
  </section>
 </div></SiteLayout>
}
