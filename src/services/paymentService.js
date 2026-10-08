import {supabase} from '../lib/supabaseClient.js'
import brand from '../config/brand.js'

const missing=e=>['PGRST202','42883','42P01'].includes(e?.code)
async function rpc(name,args){
 const {data,error}=await supabase.rpc(name,args)
 if(error){const f=new Error(missing(error)?'Course fees are not set up yet.':error.message||'Please retry.');f.setupRequired=missing(error);throw f}
 return data
}
async function fn(body){
 const {data,error}=await supabase.functions.invoke('edu-payments',{body})
 if(error){
  let message='Payment service is not reachable right now. Please try again in a moment.'
  try{const j=await error.context?.json?.();if(j?.error)message=j.error}catch{}
  throw new Error(message)
 }
 return data
}
export const rupees=(paise,{decimals=false}={})=>'₹'+(paise/100).toLocaleString('en-IN',{minimumFractionDigits:decimals?2:0,maximumFractionDigits:decimals?2:0})

// After sign-in/sign-up, send the student back to the page that asked (only student dashboard paths).
const RETURN_KEY='ksc.afterLogin'
export function rememberReturnPath(path){try{if(/^\/dashboard\/student(\/|$|\?)/.test(path))sessionStorage.setItem(RETURN_KEY,path)}catch{}}
export function takeReturnPath(fallback='/dashboard/student'){try{const p=sessionStorage.getItem(RETURN_KEY);sessionStorage.removeItem(RETURN_KEY);if(p&&/^\/dashboard\/student(\/|$|\?)/.test(p))return p}catch{}return fallback}

let scriptPromise=null
export function loadRazorpay(){
 if(window.Razorpay)return Promise.resolve(window.Razorpay)
 scriptPromise??=new Promise((resolve,reject)=>{const s=document.createElement('script');s.src='https://checkout.razorpay.com/v1/checkout.js';s.async=true
  s.onload=()=>window.Razorpay?resolve(window.Razorpay):reject(Error('Payment window could not load'));s.onerror=()=>{scriptPromise=null;reject(Error('Payment window could not load. Check your internet connection.'))};document.head.appendChild(s)})
 return scriptPromise
}

export const paymentService={
 publicPlans:()=>rpc('ksc_public_fee_plans'),
 adminPlans:()=>rpc('ksc_admin_fee_plans'),
 savePlan:plan=>rpc('ksc_save_fee_plan',{p_plan:plan}),
 adminPayments:(limit=200)=>rpc('ksc_admin_payments',{p_limit:limit}),
 myPayments:()=>rpc('ksc_my_payments'),
 createOrder:(planId,levelId)=>fn({action:'create_order',plan_id:planId,level_id:levelId||null}),
 verify:response=>fn({action:'verify',...response}),
 failed:(orderId,reason)=>fn({action:'failed',razorpay_order_id:orderId,reason}).catch(()=>null),
}

// Opens Razorpay Checkout for an order and resolves with the verified, enrolled payment.
export async function payWithRazorpay(order,{onDismiss}={}){
 const Razorpay=await loadRazorpay()
 return new Promise((resolve,reject)=>{
  const rz=new Razorpay({key:order.key_id,order_id:order.order_id,amount:order.amount,currency:order.currency,name:brand.payments.checkoutName,
   description:order.title,image:window.location.origin+brand.logo.mark,prefill:order.prefill,theme:{color:brand.colors.primary},
   notes:{receipt:order.receipt},
   handler:async response=>{try{resolve(await paymentService.verify(response))}catch(e){reject(e)}},
   modal:{ondismiss:()=>{onDismiss?.();const e=new Error('Payment was cancelled. You have not been charged.');e.cancelled=true;reject(e)},confirm_close:true}})
  rz.on('payment.failed',r=>{paymentService.failed(order.order_id,r?.error?.description)})
  rz.open()
 })
}
