import {useEffect,useMemo,useState} from 'react'
import {ArrowRight,BookOpen,GraduationCap,Landmark,Phone,ShieldCheck} from 'lucide-react'
import SiteLayout from '../../components/site/SiteLayout.jsx'
import {studentProgramService} from '../../services/studentProgramService.js'
import {paymentService,rupees} from '../../services/paymentService.js'
import './home-v2.css'
import './pages-v2.css'
import brand from '../../config/brand.js'

const iconFor=cat=>/military|entrance/i.test(cat)?ShieldCheck:/iit|neet/i.test(cat)?GraduationCap:/competitive|government/i.test(cat)?Landmark:BookOpen

export default function ExamsListingPage(){
 const [data,setData]=useState(null),[error,setError]=useState(''),[retry,setRetry]=useState(0),[plans,setPlans]=useState([])
 useEffect(()=>{let active=true;setData(null);setError('');studentProgramService.catalogue().then(d=>{if(active)setData(d)}).catch(e=>{if(active)setError(e.message)});return()=>{active=false}},[retry])
 useEffect(()=>{let active=true;paymentService.publicPlans().then(p=>{if(active)setPlans(p||[])}).catch(()=>{});return()=>{active=false}},[])
 const fromPrice=useMemo(()=>{const m=new Map();for(const p of plans){const c=m.get(p.program_id);if(!c||p.amount_paise<c)m.set(p.program_id,p.amount_paise)}return m},[plans])
 const groups=[...new Set((data?.programs||[]).map(p=>p.category))]
 return <SiteLayout><div className="ksc-home2">
  <section className="pg-hero"><div className="ks-wrap">
   <p className="h2-eyebrow on-dark">Exams we prepare for</p>
   <h1>{brand.shortName} Programs</h1>
   <p className="pg-lead">School foundation, military school entrance, IIT / NEET and government exam coaching. Choose a program and class to create your student account, or see fees and enroll online.</p>
   <div className="h2-cta"><a className="ks-btn ks-btn-yellow" href="/courses">See courses &amp; fees <ArrowRight size={17}/></a><a className="ks-btn ks-btn-outline-light" href="/demo/tests/foundation-practice-test-1">Try a free sample test</a></div>
  </div></section>
  <section className="ks-wrap pg-body">
   {error?<div role="alert" className="pg-alert"><span>{error}</span><button className="ks-btn ks-btn-navy" onClick={()=>setRetry(x=>x+1)}>Retry programs</button></div>
   :!data?<p role="status" className="pg-status">Loading available programs…</p>
   :!data.programs.length?<p className="pg-status">No programs are open for registration yet. Contact {brand.name} for help.</p>
   :groups.map(group=>{const list=data.programs.filter(p=>p.category===group),Icon=iconFor(group)
    return <section key={group} className="pg-group" aria-labelledby={'g-'+group}><h2 id={'g-'+group} className="pg-section-title">{group}<span>{list.length}</span></h2>
     <div className="pg-grid">{list.map(p=><article key={p.id} className="pg-card">
      <span className="pg-card-icon"><Icon size={22}/></span>
      <h3>{p.name}</h3>
      <ul className="pg-tracks" aria-label="Classes and tracks">{p.tracks.map(t=><li key={t.id}>{t.name}</li>)}</ul>
      {fromPrice.has(p.id)&&<p className="pg-fee">Fees from <b>{rupees(fromPrice.get(p.id))}</b></p>}
      <div className="pg-card-actions">
       <a className="ks-btn ks-btn-navy" href={'/signup?program='+encodeURIComponent(p.slug)}>Choose this program <ArrowRight size={15}/></a>
       {fromPrice.has(p.id)&&<a className="ks-btn ks-btn-ghost" href="/courses">View fees</a>}
      </div>
     </article>)}</div>
    </section>})}
   <div className="pg-note"><div><h2>Already a student?</h2><p>Sign in to continue lessons, take tests and review your results. Your saved program stays with your account.</p></div><div className="pg-note-actions"><a className="ks-btn ks-btn-navy" href="/login">Student login</a><a className="ks-btn ks-btn-ghost" href={brand.contact.phoneHref}><Phone size={16}/> {brand.contact.phone}</a></div></div>
  </section>
 </div></SiteLayout>
}
