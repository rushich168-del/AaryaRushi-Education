// Courses → checkout → (stub) Razorpay → verified receipt; admin fees & payments. Mocked backend, SAMPLE fees.
// Usage: node scripts/test-course-payments-ui.mjs [baseUrl] [shotDir]
import {chromium} from 'playwright'
import assert from 'node:assert/strict'
import {samplePlans} from './fixtures/sample-fee-plans.mjs'
const base=process.argv[2]||'http://127.0.0.1:4173',dir=process.argv[3]||'scratch/payments'
const exe=process.env.PW_CHROMIUM||undefined
const b=await chromium.launch(exe?{executablePath:exe}:{})
let pass=0;const ok=(name)=>{pass++;console.log('ok',pass,name)}
const session=(role)=>({access_token:'t',refresh_token:'r',token_type:'bearer',expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,
 user:{id:'00000000-0000-4000-8000-00000000000'+(role==='admin'?'1':'2'),aud:'authenticated',role:'authenticated',email:role==='admin'?'admin@ksc.test':'asha@ksc.test',user_metadata:{full_name:role==='admin'?'Admin':'Asha'},app_metadata:{}}})
async function page(w,{role=null,portal='student'}={}){
 const ctx=await b.newContext({viewport:{width:w,height:900}})
 if(role)await ctx.addInitScript(([k,v])=>{localStorage.setItem(k,v)},['sb-placeholder.supabase.co-ksc-'+portal+'-auth-token',JSON.stringify(session(role))])
 const p=await ctx.newPage()
 const calls=[]
 await p.route('**/auth/v1/**',r=>r.fulfill({json:session(role||'student').user}))
 await p.route('**/rest/v1/rpc/**',r=>{const n=r.request().url().split('/rpc/')[1].split('?')[0];calls.push(n)
  const J={ksc_public_fee_plans:samplePlans,ksc_my_access:{role:role||'student',state:'active',password_change_required:false,full_name:'Admin'},
   ksc_my_payments:[{id:'x',plan:'SI & Constable Complete Course',program:'SI & Constable',track:'General preparation',amount_paise:1499900,status:'paid',receipt:'KSC-261007-3F9A21BC',razorpay_payment_id:'pay_Q7demo123',paid_at:'2026-10-07T09:30:00Z',created_at:'2026-10-07T09:29:00Z',enrolled:true}],
   ksc_admin_fee_plans:{plans:samplePlans.map((s,i)=>({...s,exam_id:'p'+i,is_active:i!==4,paid_count:[14,6,9,22,0][i],sort_order:100})),programs:[{id:'p0',name:'SI & Constable',open:true,tracks:[{id:'l1',name:'General preparation'}]},{id:'p1',name:'Sainik School',open:true,tracks:[{id:'l2',name:'Class VI'},{id:'l3',name:'Class IX'}]}]},
   ksc_admin_payments:[['Asha Reddy','SI & Constable Complete Course',1499900,'paid'],['Ravi Kumar','Group-II Test Series',299900,'paid'],['Meena S','Sainik School Entrance',2400000,'failed'],['Kiran P','IIT / NEET Foundation',3000000,'paid'],['Sai Teja','Group-II Test Series',299900,'created']].map(([s,pl,a,st],i)=>({id:'p'+i,student:s,email:s.split(' ')[0].toLowerCase()+'@mail.test',plan:pl,program:pl.split(' ')[0],track:'General preparation',amount_paise:a,status:st,receipt:'KSC-261007-0000'+i,razorpay_payment_id:st==='paid'?'pay_demo'+i:null,created_at:'2026-10-0'+(7-i)+'T10:00:00Z',paid_at:st==='paid'?'2026-10-0'+(7-i)+'T10:01:00Z':null,enrolled:st==='paid'}))}
  r.fulfill({json:J[n]??null})})
 await p.route('**/functions/v1/edu-payments',async r=>{const body=JSON.parse(r.request().postData());calls.push('fn:'+body.action)
  if(body.action==='create_order'){assert.equal(body.amount,undefined);return r.fulfill({json:{key_id:'rzp_test_demo',order_id:'order_demo1',amount:1499900,currency:'INR',receipt:'KSC-261007-3F9A21BC',title:'SI & Constable Complete Course',prefill:{email:'asha@ksc.test'}}})}
  if(body.action==='verify'){assert.equal(body.razorpay_signature,'sig_demo');return r.fulfill({json:{status:'paid',receipt:'KSC-261007-3F9A21BC',amount_paise:1499900,title:'SI & Constable Complete Course',paid_at:'2026-10-07T09:30:00Z',razorpay_payment_id:'pay_Q7demo123',enrolled:true}})}
  r.fulfill({json:{ok:true}})})
 await p.route('https://checkout.razorpay.com/**',r=>r.fulfill({contentType:'text/javascript',body:`window.Razorpay=function(o){this.on=function(){};this.open=function(){window.__rzOpened=o;setTimeout(function(){o.handler({razorpay_order_id:o.order_id,razorpay_payment_id:'pay_Q7demo123',razorpay_signature:'sig_demo'})},300)}}`}))
 return {p,ctx,calls}
}
const shot=(p,name,full=true)=>p.screenshot({path:`${dir}/${name}.png`,fullPage:full})

for(const w of [1440,390]){
 // Courses page
 {const {p,ctx}=await page(w);await p.goto(base+'/courses',{waitUntil:'networkidle'})
  assert.equal(await p.locator('.ks-fee').count(),5);ok('courses lists all plans '+w)
  await p.getByRole('button',{name:/School & Military Entrance/}).click();assert.equal(await p.locator('.ks-fee').count(),1);ok('category filter '+w)
  await p.getByRole('button',{name:/^All/}).click();await p.getByLabel('Search courses').fill('group');assert.equal(await p.locator('.ks-fee').count(),1);await p.getByLabel('Search courses').fill('')
  await shot(p,'courses-'+w);await ctx.close()}
 // Checkout signed out
 {const {p,ctx}=await page(w);await p.goto(base+'/dashboard/student/checkout?plan='+samplePlans[2].id,{waitUntil:'networkidle'})
  await p.getByRole('heading',{name:'Sign in to pay'}).waitFor();assert.equal(await p.getByRole('button',{name:/Pay ₹30,000 securely/}).isDisabled(),true);ok('signed-out checkout asks to sign in '+w)
  await shot(p,'checkout-signed-out-'+w)
  await p.locator('.pay-signin').getByRole('link',{name:'Student login'}).click();await p.waitForURL('**/login');assert.equal(await p.evaluate(()=>sessionStorage.getItem('ksc.afterLogin')),'/dashboard/student/checkout?plan='+samplePlans[2].id);ok('login remembers checkout '+w);await ctx.close()}
 // Checkout signed in → pay → receipt
 {const {p,ctx,calls}=await page(w,{role:'student'});await p.goto(base+'/dashboard/student/checkout?plan='+samplePlans[2].id,{waitUntil:'networkidle'})
  await p.getByText('Paying as').waitFor()
  await p.getByRole('button',{name:/Pay ₹30,000 securely/}).click();await p.getByRole('alert').filter({hasText:'Choose your class'}).waitFor();ok('track required '+w)
  await p.getByLabel('Class VIII').check();await shot(p,'checkout-'+w)
  await p.getByRole('button',{name:/Pay ₹30,000 securely/}).click()
  await p.getByRole('heading',{name:'Payment successful'}).waitFor();assert.ok(calls.includes('fn:create_order')&&calls.includes('fn:verify'));ok('pay → verify → receipt '+w)
  assert.equal(await p.evaluate(()=>window.__rzOpened.key),'rzp_test_demo')
  await shot(p,'receipt-'+w);await ctx.close()}
 // My payments
 {const {p,ctx}=await page(w,{role:'student'});await p.goto(base+'/dashboard/student/payments',{waitUntil:'networkidle'});await p.getByText('KSC-261007-3F9A21BC').waitFor();ok('my payments '+w);await shot(p,'my-payments-'+w);await ctx.close()}
 // Admin
 {const {p,ctx}=await page(w,{role:'admin',portal:'admin'});await p.goto(base+'/dashboard/admin/fees',{waitUntil:'networkidle'})
  await p.getByRole('heading',{name:'Fees & payments'}).waitFor();assert.equal(await p.locator('.af-plans li').count(),5);ok('admin fee list '+w)
  await shot(p,'admin-fees-'+w)
  await p.getByRole('button',{name:'Add course fee'}).first().click();await p.getByRole('dialog').waitFor();await p.getByRole('button',{name:'Add course fee'}).last().click();await p.getByText('Choose a program.').waitFor();ok('admin validation '+w)
  await p.getByLabel('Program').selectOption('p1');await p.getByLabel('Course name').fill('Sainik School Crash Course');await p.getByLabel('Fee (₹)').fill('9,999')
  await shot(p,'admin-fee-editor-'+w,false);await p.keyboard.press('Escape')
  await p.getByRole('tab',{name:/Payments/}).click();await p.locator('.af-table tbody tr').first().waitFor();assert.equal(await p.locator('.af-table tbody tr').count(),5)
  await p.getByRole('button',{name:'Failed'}).click();assert.equal(await p.locator('.af-table tbody tr').count(),1);await p.getByRole('button',{name:'All'}).click();ok('admin payments list + filter '+w)
  await shot(p,'admin-payments-'+w);await ctx.close()}
}
await b.close();console.log(`# pass ${pass}`)
