import {test,before,after} from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {chromium} from 'playwright'
import {readFile,readdir} from 'node:fs/promises'
let browser,bundle,css
before(async()=>{
 css=await readFile('dist/assets/'+(await readdir('dist/assets')).find(f=>f.endsWith('.css')),'utf8')
 bundle=(await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {AuthProvider} from './src/context/AuthContext.jsx';import Recovery from './src/pages/PasswordRecoveryPage.jsx';window.mount=reset=>createRoot(document.getElementById('root')).render(<AuthProvider><Recovery reset={reset}/></AuthProvider>);`,resolveDir:process.cwd(),loader:'jsx'},bundle:true,write:false,format:'iife',jsx:'automatic',loader:{'.css':'empty'},plugins:[{name:'offline-recovery',setup(b){
 b.onResolve({filter:/supabaseClient\.js$/},()=>({path:'auth',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({loader:'js',contents:`
 export const isSupabaseConfigured=true;const f=()=>window.fixture;
 export const supabase={auth:{getSession:async()=>({data:{session:f().session||null}}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),
 resetPasswordForEmail:async(email,options)=>{window.recoveryCalls=(window.recoveryCalls||0)+1;window.requestEmail=email;window.redirect=options.redirectTo;if(f().hold)await new Promise(r=>window.release=r);return {error:f().error||null}},
 updateUser:async()=>{window.updateCalls=(window.updateCalls||0)+1;return f().error?{error:f().error}:{data:{user:{id:'synthetic-user'}}}}}};
 `}));}}]})).outputFiles[0].text
 browser=await chromium.launch({headless:true})
})
after(async()=>browser?.close())
async function open(t,fixture={},reset=false,width=390,fragment=''){
 const context=await browser.newContext({viewport:{width,height:900}});t.after(()=>context.close())
 await context.route('**/*',r=>r.request().url().startsWith('http://127.0.0.1:55555/')?r.fulfill({contentType:'text/html',body:'<div id="root"></div>'}):r.abort())
 const p=await context.newPage();p.setDefaultTimeout(5000);const errors=[];p.on('pageerror',e=>errors.push(e.message));t.after(()=>assert.deepEqual(errors,[]))
 await p.goto('http://127.0.0.1:55555/'+(reset?'reset-password':'forgot-password')+fragment);await p.addStyleTag({content:css});await p.evaluate(f=>window.fixture=f,fixture);await p.addScriptTag({content:bundle});await p.evaluate(reset=>window.mount(reset),reset);return p
}
test('first request hitting project mail limit preserves email, explains shared limit and allows explicit retry',async t=>{
 const p=await open(t,{error:{code:'over_email_send_rate_limit',message:'Email rate limit exceeded'}})
 await p.getByLabel('Email address').fill('synthetic@ksc.local');await p.getByRole('button',{name:'Send recovery link'}).click()
 await p.getByRole('alert').filter({hasText:'This can happen on your first attempt'}).waitFor()
 assert.equal(await p.evaluate(()=>window.recoveryCalls),1);assert.equal(await p.getByLabel('Email address').inputValue(),'synthetic@ksc.local')
 assert.equal(await p.getByText('Recovery request accepted',{exact:true}).count(),0)
 assert.equal(await p.getByRole('link',{name:'Contact AaryaRushi Education'}).getAttribute('href'),'/contact')
 await p.evaluate(()=>window.fixture.error=null);await p.getByRole('button',{name:'Send recovery link'}).click()
 await p.getByRole('status').filter({hasText:'Recovery request accepted'}).waitFor();assert.equal(await p.evaluate(()=>window.recoveryCalls),2)
 assert.equal(await p.evaluate(()=>window.redirect),'http://127.0.0.1:55555/reset-password')
})
test('duplicate requests are suppressed and network failure stays distinct from mail quota',async t=>{
 const p=await open(t,{hold:true,error:{message:'Failed to fetch'}});await p.getByLabel('Email address').fill('synthetic@ksc.local');await p.getByRole('button',{name:'Send recovery link'}).click()
 await p.locator('form').evaluate(f=>f.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})))
 assert.equal(await p.evaluate(()=>window.recoveryCalls),1);await p.evaluate(()=>window.release())
 await p.getByRole('alert').filter({hasText:'Network connection failed'}).waitFor();assert.equal(await p.getByText('Recovery email is temporarily unavailable',{exact:true}).count(),0)
 assert.equal(await p.getByRole('button',{name:'Send recovery link'}).isEnabled(),true)
})
test('recovery and reset share institute branding, fit desktop and mobile, and omit signup steps',async t=>{
 for(const reset of [false,true]){
 const p=await open(t,{session:{user:{id:'synthetic-user'}}},reset)
 await p.getByRole('heading',{name:reset?'Set a new password':'Forgot your password?',exact:true}).waitFor()
 assert.equal(await p.getByRole('navigation',{name:'Registration progress'}).count(),0)
 assert.equal(await p.getByRole('img',{name:'AaryaRushi Education logo'}).count(),1)
 for(const width of [1440,390,320]){await p.setViewportSize({width,height:900});assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await p.screenshot({path:'scratch/student-program/'+(reset?'reset':'recovery')+'-'+width+'.png',fullPage:true})}
 }
})
test('invalid recovery link never offers password changes and matching passwords update once',async t=>{
 const invalid=await open(t,{session:{user:{id:'synthetic-user'}}},true,320,'#error_code=otp_expired')
 await invalid.getByRole('alert').filter({hasText:'invalid or expired'}).waitFor();assert.equal(await invalid.getByLabel('New password',{exact:true}).count(),0)
 const p=await open(t,{session:{user:{id:'synthetic-user'}}},true)
 await p.getByLabel('New password',{exact:true}).fill('Synthetic!Password123');await p.getByLabel('Confirm new password').fill('Different!Password123');await p.getByRole('button',{name:'Update password'}).click()
 await p.getByRole('alert').filter({hasText:'Passwords do not match'}).waitFor();assert.equal(await p.evaluate(()=>window.updateCalls||0),0)
 await p.getByLabel('Confirm new password').fill('Synthetic!Password123');await p.getByRole('button',{name:'Update password'}).click();await p.getByRole('status').filter({hasText:'Password updated'}).waitFor();assert.equal(await p.evaluate(()=>window.updateCalls),1)
})
