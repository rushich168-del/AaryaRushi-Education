import {useState} from 'react'
import {ArrowRight,Atom,BookOpen,Briefcase,Check,GraduationCap,Search,Shield} from 'lucide-react'
import './program-onboarding.css'
import brand from '../../config/brand.js'

// One icon per family so the grid is easy to scan.
function familyIcon(group=''){
 const g=group.toLowerCase()
 if(/military|entrance/.test(g))return Shield
 if(/foundation|school/.test(g))return BookOpen
 if(/iit|neet|engineering|medical/.test(g))return Atom
 if(/competitive|government/.test(g))return Briefcase
 return GraduationCap
}
const trackSummary=tracks=>{
 const names=tracks.map(t=>t.name)
 if(names.length===1)return names[0]
 return names.length<=3?names.join(' · '):`${names[0]} – ${names[names.length-1]}`
}

export default function ProgramChoice({programs,value,onChange,onContinue,busy=false}){
 const [group,setGroup]=useState('')
 const [query,setQuery]=useState('')
 const selected=programs.find(p=>p.id===value.exam)
 const groups=[...new Set(programs.map(p=>p.category||'Other programs'))]
 const q=query.trim().toLowerCase()
 const shown=programs.filter(p=>(!group||(p.category||'Other programs')===group)&&(!q||p.name.toLowerCase().includes(q)||p.tracks.some(t=>t.name.toLowerCase().includes(q))))
 const visibleGroups=groups.filter(g=>shown.some(p=>(p.category||'Other programs')===g))

 if(selected){
  const Icon=familyIcon(selected.category)
  return <div className="program-choice">
   <div className="program-selected"><span className="program-selected-icon"><Icon size={24}/></span><div><small>YOUR PROGRAM</small><h2>{selected.name}</h2>{selected.category&&<p>{selected.category}</p>}</div><button type="button" disabled={busy} className="program-text-button" onClick={()=>onChange({exam:'',level:''})}>Change program</button></div>
   <h3 className="program-step-title">Choose your preparation track</h3>
   <p className="program-step-note">These are the institute’s configured learning tracks. Your course enrollment is managed separately.</p>
   <fieldset className="program-tracks"><legend className="sr-only">Preparation track</legend>{selected.tracks.map(track=><label key={track.id} className={value.level===track.id?'is-selected':''}><input type="radio" disabled={busy} name="preparation-track" value={track.id} checked={value.level===track.id} onChange={()=>onChange({...value,level:track.id})}/><span>{track.name}</span>{value.level===track.id&&<Check size={18}/>}</label>)}</fieldset>
   <button type="button" className="program-primary" disabled={!selected.tracks.some(t=>t.id===value.level)||busy} onClick={onContinue}>{busy?'Saving your program…':'Continue'}<ArrowRight size={17}/></button>
  </div>
 }

 return <div className="program-choice">
  <h2>What are you preparing for?</h2>
  <p>Choose your program. Your preparation track comes next.</p>
  {!programs.length?<div className="program-notice">No programs are open for registration yet. Contact {brand.name} for help.</div>:<>
   <div className="program-tools">
    {groups.length>1&&<div className="program-families" role="group" aria-label="Program families">
     <button type="button" aria-pressed={!group} onClick={()=>setGroup('')}>All <span>{programs.length}</span></button>
     {groups.map(g=><button type="button" key={g} aria-pressed={group===g} onClick={()=>setGroup(g)}>{g} <span>{programs.filter(p=>(p.category||'Other programs')===g).length}</span></button>)}
    </div>}
    {programs.length>8&&<label className="program-search"><Search size={17} aria-hidden="true"/><span className="sr-only">Search programs</span><input type="search" placeholder="Search a program or class" value={query} onChange={e=>setQuery(e.target.value)}/></label>}
   </div>
   {visibleGroups.map(g=>{const Icon=familyIcon(g);return <section key={g} aria-label={g}>
    <h3><span className="program-family-icon"><Icon size={15}/></span>{g}</h3>
    <div className="program-options">{shown.filter(p=>(p.category||'Other programs')===g).map(p=><button type="button" disabled={busy} key={p.id} onClick={()=>onChange({exam:p.id,level:''})}>
     <span className="program-option-icon"><Icon size={20}/></span>
     <span className="program-option-text"><strong>{p.name}</strong><small>{trackSummary(p.tracks)}</small></span>
     <ArrowRight size={17} className="program-option-arrow"/>
    </button>)}</div>
   </section>})}
   {!shown.length&&<div className="program-notice" role="status">No programs match “{query.trim()}”.</div>}
  </>}
 </div>
}
