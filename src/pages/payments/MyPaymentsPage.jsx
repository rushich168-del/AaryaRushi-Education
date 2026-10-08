import {useEffect,useState} from 'react'
import {ArrowLeft,ArrowRight,ReceiptText} from 'lucide-react'
import SiteLayout from '../../components/site/SiteLayout.jsx'
import {paymentService,rupees} from '../../services/paymentService.js'
import './payments.css'

const label={paid:'Paid',failed:'Failed',created:'Pending'}
export default function MyPaymentsPage(){
 const [rows,setRows]=useState(null),[error,setError]=useState(''),[retry,setRetry]=useState(0)
 useEffect(()=>{let live=true;setRows(null);setError('');paymentService.myPayments().then(r=>{if(live)setRows(r||[])}).catch(e=>{if(live){setError(e.setupRequired?'':e.message);setRows([])}});return()=>{live=false}},[retry])
 return <SiteLayout><div className="pay-page"><div className="ks-wrap pay-narrow">
  <a href="/dashboard/student" className="pay-back"><ArrowLeft size={16}/> My dashboard</a>
  <h1 className="pay-h1">My payments</h1>
  <p className="pay-sub">Receipts for every course you paid for online.</p>
  {rows===null?<p className="pay-status" role="status">Loading payments…</p>
  :error?<div className="pay-card pay-missing"><p role="alert">{error}</p><button className="ks-btn ks-btn-navy" onClick={()=>setRetry(x=>x+1)}>Try again</button></div>
  :!rows.length?<div className="pay-card pay-missing"><ReceiptText size={26}/><div><h2>No payments yet</h2><p>When you enroll in a course online, the receipt appears here.</p></div><a className="ks-btn ks-btn-navy" href="/courses">View courses <ArrowRight size={16}/></a></div>
  :<ul className="pay-list">{rows.map(r=><li key={r.id} className="pay-card">
    <div><p className="pay-kicker">{r.program} · {r.track}</p><h2>{r.plan}</h2><p className="pay-sub">Receipt {r.receipt} · {new Date(r.paid_at||r.created_at).toLocaleDateString('en-IN',{dateStyle:'medium'})}{r.razorpay_payment_id?' · '+r.razorpay_payment_id:''}</p></div>
    <div className="pay-list-right"><strong>{rupees(r.amount_paise,{decimals:true})}</strong><span className={'pay-pill s-'+r.status}>{label[r.status]||r.status}</span></div>
   </li>)}</ul>}
 </div></div></SiteLayout>
}
