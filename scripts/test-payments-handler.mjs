// edu-payments Edge Function handler: signature checks, server-side price, ownership, webhook. No network.
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createPaymentsHandler,hmacHex} from '../supabase/functions/edu-payments/handler.mjs'

const ORIGIN='http://127.0.0.1:5173',PLAN='11111111-1111-4111-8111-111111111111',LEVEL='22222222-2222-4222-8222-222222222222'
function setup(){
 const calls=[]
 const h=createPaymentsHandler({allowedOrigins:[ORIGIN],keyId:'rzp_test_KEY',keySecret:'s3cret',webhookSecret:'whsec',
  getUser:async t=>t==='good'?{id:'u1',email:'s@ksc.test',name:'Asha'}:null,
  rpc:async(name,args)=>{calls.push([name,args]);if(name==='ksc_payment_begin')return{payment_id:'p1',receipt:'KSC-1',amount_paise:150000,currency:'INR',title:'Course'};if(name==='ksc_payment_mark_paid')return{status:'paid',receipt:'KSC-1',enrolled:true};return null},
  razorpayCreateOrder:async b=>{calls.push(['order',b]);return{id:'order_ABC123'}}})
 const post=(body,{token='good',origin=ORIGIN,headers={}}={})=>h(new Request('http://x/',{method:'POST',headers:{origin,...(token?{authorization:'Bearer '+token}:{}),...headers},body:typeof body==='string'?body:JSON.stringify(body)}))
 return {calls,post}
}
test('create_order uses the server price and never a browser amount',async()=>{
 const {calls,post}=setup()
 const r=await post({action:'create_order',plan_id:PLAN,level_id:LEVEL,amount:1})
 assert.equal(r.status,200);const b=await r.json()
 assert.equal(b.amount,150000);assert.equal(b.order_id,'order_ABC123');assert.equal(b.key_id,'rzp_test_KEY')
 assert.equal(calls.find(c=>c[0]==='order')[1].amount,150000)
 assert.deepEqual(calls.find(c=>c[0]==='ksc_payment_attach_order')[1],{p_payment:'p1',p_order:'order_ABC123'})
 assert.equal(JSON.stringify(b).includes('s3cret'),false,'secret never returned')
})
test('requires sign-in and an allowed origin',async()=>{
 const {post}=setup()
 assert.equal((await post({action:'create_order',plan_id:PLAN},{token:''})).status,401)
 assert.equal((await post({action:'create_order',plan_id:PLAN},{token:'bad'})).status,401)
 assert.equal((await post({action:'create_order',plan_id:PLAN},{origin:'https://evil.test'})).status,403)
})
test('verify accepts only a valid Razorpay signature and passes the signed-in owner',async()=>{
 const {calls,post}=setup()
 const bad=await post({action:'verify',razorpay_order_id:'order_ABC123',razorpay_payment_id:'pay_XYZ789',razorpay_signature:'00'})
 assert.equal(bad.status,400);assert.equal(calls.some(c=>c[0]==='ksc_payment_mark_paid'),false)
 const sig=await hmacHex('s3cret','order_ABC123|pay_XYZ789')
 const ok=await post({action:'verify',razorpay_order_id:'order_ABC123',razorpay_payment_id:'pay_XYZ789',razorpay_signature:sig})
 assert.equal(ok.status,200);assert.equal((await ok.json()).enrolled,true)
 assert.deepEqual(calls.find(c=>c[0]==='ksc_payment_mark_paid')[1],{p_order:'order_ABC123',p_payment_id:'pay_XYZ789',p_user:'u1',p_amount_paise:null})
})
test('webhook needs the webhook signature and marks captured payments paid with the gateway amount',async()=>{
 const {calls,post}=setup()
 const body=JSON.stringify({event:'payment.captured',payload:{payment:{entity:{id:'pay_W1',order_id:'order_W1',amount:150000}}}})
 assert.equal((await post(body,{token:'',origin:'',headers:{'x-razorpay-signature':'bad'}})).status,401)
 const r=await post(body,{token:'',origin:'',headers:{'x-razorpay-signature':await hmacHex('whsec',body)}})
 assert.equal(r.status,200)
 assert.deepEqual(calls.find(c=>c[0]==='ksc_payment_mark_paid')[1],{p_order:'order_W1',p_payment_id:'pay_W1',p_user:null,p_amount_paise:150000})
})
