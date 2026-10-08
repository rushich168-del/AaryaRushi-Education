import {useEffect,useState} from 'react'
import {ArrowRight,Check,Sparkles} from 'lucide-react'
import {paymentService,rupees} from '../../services/paymentService.js'

export function usePublicPlans(){
 const [state,setState]=useState({plans:null,error:'',setup:false})
 const [retry,setRetry]=useState(0)
 useEffect(()=>{let live=true;setState(s=>({...s,error:''}))
  paymentService.publicPlans().then(plans=>{if(live)setState({plans:plans||[],error:'',setup:false})})
   .catch(e=>{if(live)setState({plans:[],error:e.setupRequired?'':e.message,setup:!!e.setupRequired})})
  return()=>{live=false}},[retry])
 return {...state,retry:()=>setRetry(x=>x+1)}
}

export const checkoutHref=plan=>'/dashboard/student/checkout?plan='+encodeURIComponent(plan.id)

export default function FeeCard({plan,compact=false}){
 const off=plan.original_amount_paise?Math.round((1-plan.amount_paise/plan.original_amount_paise)*100):0
 const tracks=plan.track?[plan.track]:(plan.tracks||[]).map(t=>t.name)
 return <article className={'ks-fee'+(plan.is_featured?' is-featured':'')}>
  {plan.is_featured&&<span className="ks-fee-flag"><Sparkles size={13}/> Most chosen</span>}
  <p className="ks-fee-cat">{plan.category}</p>
  <h3>{plan.title}</h3>
  <p className="ks-fee-program">{plan.program}{tracks.length?<> · <span>{tracks.length>3?tracks.slice(0,3).join(', ')+' +'+(tracks.length-3):tracks.join(', ')}</span></>:null}</p>
  <div className="ks-fee-price"><strong>{rupees(plan.amount_paise)}</strong>{plan.original_amount_paise&&<><s>{rupees(plan.original_amount_paise)}</s><em>Save {off}%</em></>}</div>
  {plan.duration_label&&<p className="ks-fee-duration">{plan.duration_label}</p>}
  {!compact&&plan.description&&<p className="ks-fee-desc">{plan.description}</p>}
  {plan.features?.length>0&&<ul>{plan.features.slice(0,compact?4:8).map(f=><li key={f}><Check size={15}/>{f}</li>)}</ul>}
  <a className="ks-btn ks-btn-navy ks-fee-cta" href={checkoutHref(plan)}>Enroll &amp; pay <ArrowRight size={16}/></a>
 </article>
}
