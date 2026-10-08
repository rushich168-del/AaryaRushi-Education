import {test,before,after} from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {chromium} from 'playwright'
import {readFile,readdir} from 'node:fs/promises'
let browser,bundle,css
const saved={user:{id:'old-student',email:'saved@ksc.local'}},fresh={user:{id:'new-student',email:'new@ksc.local'}}
before(async()=>{
 css=await readFile('dist/assets/'+(await readdir('dist/assets')).find(f=>f.endsWith('.css')),'utf8')
 bundle=(await build({stdin:{contents:`
 import React from 'react';import {createRoot} from 'react-dom/client';
 import {AuthProvider,useAuth} from './src/context/AuthContext.jsx';
 import StudentGate from './src/components/auth/StudentGate.jsx';import Login from './src/pages/LoginPage.jsx';
 function Probe(){const auth=useAuth();window.authProbe=auth;return <output aria-label="Session identity">{auth.user?.email||'No session'}</output>}
 window.mount=()=>createRoot(document.getElementById('root')).render(<AuthProvider><Probe/><StudentGate entry><Login/></StudentGate></AuthProvider>);
 `,resolveDir:process.cwd(),loader:'jsx'},bundle:true,write:false,format:'iife',jsx:'automatic',loader:{'.css':'empty'},plugins:[{name:'fixture',setup(b){
 b.onResolve({filter:/supabaseClient\.js$/},()=>({path:'auth',namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},()=>({loader:'js',contents:`
 export const isSupabaseConfigured=true;const f=()=>window.fixture;
 export const supabase={rpc:async()=>({data:{role:'student'}}),auth:{
 getSession:async()=>{const captured=f().session||null;if(f().holdInitial)await new Promise(r=>window.releaseInitial=r);return {data:{session:captured}}},
 onAuthStateChange:callback=>{window.emitAuth=callback;return {data:{subscription:{unsubscribe(){}}}}},
 signInWithPassword:async()=>{window.calls=(window.calls||0)+1;if(f().holdSignIn)await new Promise(r=>window.releaseSignIn=r);return f().error?{error:f().error}:{data:{session:f().response}}},
 signOut:async options=>{window.logoutScope=options?.scope;window.logouts=(window.logouts||0)+1;return f().logoutError?{error:{message:'Sign out failed'}}:{error:null}}
 }};
 `}));}}]})).outputFiles[0].text
 browser=await chromium.launch({headless:true})
})
after(async()=>browser?.close())
async function open(t,fixture={},width=390){
 const context=await browser.newContext({viewport:{width,height:900}});t.after(()=>context.close())
 await context.route('**/*',r=>r.request().url().startsWith('http://127.0.0.1:55555/')?r.fulfill({contentType:'text/html',body:'<div id="root"></div>'}):r.abort())
 const p=await context.newPage();p.setDefaultTimeout(5000)
 const errors=[];p.on('pageerror',e=>errors.push(e.message));t.after(()=>assert.deepEqual(errors,[]))
 await p.goto('http://127.0.0.1:55555/login');await p.addStyleTag({content:css});await p.evaluate(f=>window.fixture=f,fixture)
 await p.addScriptTag({content:bundle});await p.evaluate(()=>window.mount());return p
}
async function submit(p){await p.getByLabel('Email',{exact:true}).fill('new@ksc.local');await p.getByLabel('Password',{exact:true}).fill('Synthetic!Password123');await p.getByRole('button',{name:'Sign in',exact:true}).click()}
test('saved account requires an explicit choice and switching preserves failed logout',async t=>{
 const p=await open(t,{session:saved,logoutError:true},320)
 await p.getByRole('link',{name:'Continue with this account'}).waitFor();assert.equal(new URL(p.url()).pathname,'/login')
 await p.getByText('saved@ksc.local',{exact:true}).last().waitFor()
 await p.getByRole('button',{name:'Use a different student account'}).click();await p.getByRole('alert').filter({hasText:'Sign out failed'}).waitFor()
 assert.equal(await p.getByLabel('Email',{exact:true}).count(),0)
 await p.evaluate(()=>{window.fixture.logoutError=false;window.fixture.response={user:{id:'new-student',email:'new@ksc.local'}}})
 await p.getByRole('button',{name:'Use a different student account'}).click();await submit(p);await p.waitForURL('**/dashboard/student')
 assert.equal(await p.getByLabel('Session identity').textContent(),'new@ksc.local')
 assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
})
test('returned session owns identity even without an SDK event; delayed INITIAL_SESSION cannot replace it',async t=>{
 const p=await open(t,{response:fresh});await submit(p);await p.waitForURL('**/dashboard/student')
 await p.evaluate(old=>window.emitAuth('INITIAL_SESSION',old),saved)
 assert.equal(await p.getByLabel('Session identity').textContent(),'new@ksc.local')
})
test('delayed startup snapshot and in-flight events cannot overwrite a verified sign-in',async t=>{
 const p=await open(t,{session:saved,holdInitial:true,response:fresh,holdSignIn:true})
 await p.waitForFunction(()=>!!window.emitAuth);await p.evaluate(()=>window.emitAuth('INITIAL_SESSION',null));await submit(p)
 await p.waitForFunction(()=>!!window.releaseSignIn)
 await p.evaluate(old=>{window.emitAuth('SIGNED_IN',old);window.releaseSignIn()},saved)
 await p.waitForURL('**/dashboard/student');await p.evaluate(()=>window.releaseInitial())
 assert.equal(await p.getByLabel('Session identity').textContent(),'new@ksc.local')
 assert.equal(await p.evaluate(()=>window.calls),1)
})
test('wrong returned identity is cleared locally and never opens the portal',async t=>{
 const p=await open(t,{response:saved,logoutError:true});await submit(p)
 await p.getByRole('alert').filter({hasText:'does not match the email entered'}).waitFor()
 assert.equal(new URL(p.url()).pathname,'/login');assert.equal(await p.getByLabel('Session identity').textContent(),'No session')
 assert.equal(await p.evaluate(()=>window.logoutScope),'local')
 await p.evaluate(old=>window.emitAuth('TOKEN_REFRESHED',old),saved)
 assert.equal(await p.getByLabel('Session identity').textContent(),'No session')
 assert.equal(new URL(p.url()).pathname,'/login')
})
test('unconfirmed account shows actionable error and can retry after confirmation',async t=>{
 const p=await open(t,{error:{code:'email_not_confirmed',message:'Email not confirmed'},response:fresh});await submit(p)
 await p.getByRole('alert').filter({hasText:'Confirm your email before signing in'}).waitFor()
 assert.equal(new URL(p.url()).pathname,'/login');assert.equal(await p.getByLabel('Session identity').textContent(),'No session')
 assert.equal(await p.getByLabel('Email',{exact:true}).inputValue(),'new@ksc.local')
 await p.evaluate(()=>window.fixture.error=null);await p.getByRole('button',{name:'Sign in',exact:true}).click();await p.waitForURL('**/dashboard/student')
 assert.equal(await p.evaluate(()=>window.calls),2)
})
test('double submit sends only one account request and reloaded session shows its own identity',async t=>{
 const p=await open(t,{response:fresh,holdSignIn:true});await submit(p)
 await p.locator('form').evaluate(form=>{form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))})
 assert.equal(await p.evaluate(()=>window.calls),1);await p.evaluate(()=>window.releaseSignIn());await p.waitForURL('**/dashboard/student')
 const reloaded=await open(t,{session:fresh},1440);await reloaded.getByRole('link',{name:'Continue with this account'}).waitFor()
 assert.equal(await reloaded.getByLabel('Session identity').textContent(),'new@ksc.local')
 for(const width of [1440,390,320]){await reloaded.setViewportSize({width,height:900});assert.equal(await reloaded.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await reloaded.screenshot({path:'scratch/student-program/student-login-account-'+width+'.png',fullPage:true})}
})
