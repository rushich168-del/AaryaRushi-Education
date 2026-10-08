import {useEffect,useMemo,useState} from 'react'
import {ArrowLeft,ArrowRight,BadgeCheck,Check,CircleAlert,CreditCard,Landmark,Loader2,LockKeyhole,Printer,ReceiptText,Smartphone,UserRound} from 'lucide-react'
import SiteLayout from '../../components/site/SiteLayout.jsx'
import {usePublicPlans} from '../../components/site/FeeCard.jsx'
import {useAuth} from '../../context/AuthContext.jsx'
import {payWithRazorpay,paymentService,rememberReturnPath,rupees} from '../../services/paymentService.js'
import './payments.css'
import brand from '../../config/brand.js'

function Steps({at}){
 return <ol className="pay-steps" aria-label="Checkout progress">{['Course','Payment','Enrolled'].map((s,i)=><li key={s} className={i<at?'done':i===at?'now':''} aria-current={i===at?'step':undefined}><span>{i<at?<Check size={14}/>:i+1}</span>{s}</li>)}</ol>
}

export function Receipt({payment,plan,track}){
 const date=payment.paid_at?new Date(payment.paid_at):new Date()
 return <section className="pay-receipt" aria-labelledby="receipt-title">
  <div className="pay-receipt-top"><span className="pay-ok"><BadgeCheck size={34}/></span><div><h1 id="receipt-title">Payment successful</h1><p>You are enrolled. Your course is now in your student portal.</p></div></div>
  <dl className="pay-receipt-rows">
   <div><dt>Receipt no.</dt><dd>{payment.receipt}</dd></div>
   <div><dt>Course</dt><dd>{payment.title||plan?.title}</dd></div>
   {track&&<div><dt>Class / track</dt><dd>{track}</dd></div>}
   <div><dt>Amount paid</dt><dd className="pay-strong">{rupees(payment.amount_paise,{decimals:true})}</dd></div>
   <div><dt>Payment ID</dt><dd className="pay-mono">{payment.razorpay_payment_id}</dd></div>
   <div><dt>Date</dt><dd>{date.toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short'})}</dd></div>
  </dl>
  <div className="pay-receipt-actions"><a className="ks-btn ks-btn-yellow" href="/dashboard/student">Go to my dashboard <ArrowRight size={16}/></a><button type="button" className="ks-btn ks-btn-ghost" onClick={()=>window.print()}><Printer size={16}/> Print receipt</button><a className="ks-btn ks-btn-ghost" href="/dashboard/student/payments">My payments</a></div>
 </section>
}

export default function CheckoutPage(){
 const planId=new URLSearchParams(window.location.search).get('plan')||''
 const {plans,error:loadError,retry}=usePublicPlans()
 const {user,loading}=useAuth()
 const plan=useMemo(()=>(plans||[]).find(p=>p.id===planId),[plans,planId])
 const tracks=plan?(plan.level_id?[{id:plan.level_id,name:plan.track}]:plan.tracks||[]):[]
 const [level,setLevel]=useState('')
 const [busy,setBusy]=useState(''),[error,setError]=useState(''),[done,setDone]=useState(null)
 useEffect(()=>{if(tracks.length===1)setLevel(tracks[0].id)},[plan?.id])
 const here='/dashboard/student/checkout?plan='+encodeURIComponent(planId)

 async function pay(){
  if(busy)return;setError('')
  if(!level){setError('Choose your class / track first.');return}
  setBusy('order')
  try{
   const order=await paymentService.createOrder(plan.id,plan.level_id?null:level)
   setBusy('paying')
   const result=await payWithRazorpay(order)
   setDone(result)
  }catch(e){setError(e.message||'Payment could not be completed.')}
  finally{setBusy('')}
 }

 const trackName=tracks.find(t=>t.id===level)?.name
 if(done)return <SiteLayout><div className="pay-page"><div className="ks-wrap pay-narrow"><Steps at={3}/><Receipt payment={done} plan={plan} track={trackName}/></div></div></SiteLayout>

 return <SiteLayout><div className="pay-page"><div className="ks-wrap">
  <a href="/courses" className="pay-back"><ArrowLeft size={16}/> All courses</a>
  <Steps at={user?1:0}/>
  {plans===null||loading?<p className="pay-status" role="status"><Loader2 className="pay-spin" size={18}/> Loading your course…</p>
  :!plan?<div className="pay-card pay-missing"><CircleAlert size={26}/><div><h1>{loadError?'Could not load this course':'This course is not available'}</h1><p>{loadError?'Please check your connection and try again.':'It may have been updated or closed for enrollment. Please choose a course again.'}</p></div>{loadError?<button className="ks-btn ks-btn-navy" onClick={retry}>Try again</button>:<a className="ks-btn ks-btn-navy" href="/courses">View courses</a>}</div>
  :<div className="pay-grid">
   <section className="pay-card pay-main" aria-labelledby="pay-title">
    <p className="pay-kicker">{plan.category}</p>
    <h1 id="pay-title">{plan.title}</h1>
    <p className="pay-sub">{plan.program}{plan.duration_label?' · '+plan.duration_label:''}</p>
    {plan.description&&<p className="pay-desc">{plan.description}</p>}
    {plan.features?.length>0&&<ul className="pay-features">{plan.features.map(f=><li key={f}><Check size={15}/>{f}</li>)}</ul>}

    {tracks.length>1&&<fieldset className="pay-tracks"><legend>Choose your class / track</legend><div>{tracks.map(t=><label key={t.id} className={level===t.id?'is-on':''}><input type="radio" name="track" value={t.id} checked={level===t.id} onChange={()=>{setLevel(t.id);setError('')}}/>{t.name}</label>)}</div></fieldset>}
    {tracks.length===1&&<p className="pay-one-track">Class / track: <b>{tracks[0].name}</b></p>}

    {!user&&<div className="pay-signin"><UserRound size={22}/><div><h2>Sign in to pay</h2><p>Your course is added to your student account, so please sign in or create a free account first. You will come straight back here.</p></div>
     <div className="pay-signin-actions"><a className="ks-btn ks-btn-navy" href="/login" onClick={()=>rememberReturnPath(here)}>Student login</a><a className="ks-btn ks-btn-ghost" href={'/signup?program='+encodeURIComponent(plan.program_slug||'')} onClick={()=>rememberReturnPath(here)}>Create account</a></div></div>}
   </section>

   <aside className="pay-card pay-summary" aria-label="Order summary">
    <h2>Order summary</h2>
    <dl>
     <div><dt>{plan.title}</dt><dd>{rupees(plan.original_amount_paise||plan.amount_paise)}</dd></div>
     {plan.original_amount_paise&&<div className="pay-discount"><dt>Discount</dt><dd>− {rupees(plan.original_amount_paise-plan.amount_paise)}</dd></div>}
     {trackName&&<div className="pay-muted"><dt>Class / track</dt><dd>{trackName}</dd></div>}
     <div className="pay-total"><dt>Total</dt><dd>{rupees(plan.amount_paise)}</dd></div>
    </dl>
    {user&&<p className="pay-account">Paying as <b>{user.email}</b></p>}
    {error&&<p className="pay-error" role="alert"><CircleAlert size={16}/> {error}</p>}
    <button type="button" className="ks-btn ks-btn-yellow ks-btn-lg pay-button" disabled={!user||!!busy} onClick={pay}>
     {busy==='order'?<><Loader2 className="pay-spin" size={18}/> Preparing secure payment…</>:busy==='paying'?<><Loader2 className="pay-spin" size={18}/> Complete payment in the window…</>:<><LockKeyhole size={17}/> Pay {rupees(plan.amount_paise)} securely</>}
    </button>
    {!user&&<p className="pay-hint">Sign in first to continue to payment.</p>}
    <div className="pay-methods"><span><Smartphone size={15}/> UPI</span><span><CreditCard size={15}/> Cards</span><span><Landmark size={15}/> Net banking</span></div>
    <p className="pay-secure"><LockKeyhole size={13}/> Payments are processed by Razorpay. {brand.shortName} never sees your card or UPI PIN.</p>
    <p className="pay-secure"><ReceiptText size={13}/> You get a receipt instantly after payment.</p>
   </aside>
  </div>}
 </div></div></SiteLayout>
}
