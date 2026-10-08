import {test,before,after} from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {chromium} from 'playwright'
let browser,bundle
before(async()=>{
 bundle=(await build({stdin:{resolveDir:process.cwd(),loader:'jsx',contents:`
 import React from 'react';import {createRoot} from 'react-dom/client';
 import {AuthProvider,useAuth} from './src/context/AuthContext.jsx';
 import {supabase} from './src/lib/supabaseClient.js';import {authPortal,recoveryPath,portalLoginPath} from './src/lib/portalSession.js';
 import {navigateTo} from './src/utils/routes.js';
 window.client=supabase;window.portal=authPortal;window.recoveryPath=recoveryPath;window.loginPath=portalLoginPath;window.navigate=navigateTo;
 function Probe(){const auth=useAuth();window.auth=auth;return <output>{auth.loading?'Loading':auth.user?.email||'Signed out'}</output>}
 createRoot(document.getElementById('root')).render(<AuthProvider><Probe/></AuthProvider>);
 `},bundle:true,write:false,format:'iife',jsx:'automatic',define:{'import.meta.env':JSON.stringify({VITE_SUPABASE_URL:'https://fixture.supabase.co',VITE_SUPABASE_ANON_KEY:'fixture-public-key'})}})).outputFiles[0].text
 browser=await chromium.launch()
})
after(async()=>browser?.close())
async function setup(t){
 const context=await browser.newContext();t.after(()=>context.close());const logout=[]
 await context.route('**/*',async route=>{
  const u=new URL(route.request().url())
  if(u.origin==='http://ksc.test')return route.fulfill({contentType:'text/html',body:`<div id="root"></div><script>${bundle}</script>`})
  if(u.pathname==='/auth/v1/token'){
   const {email}=route.request().postDataJSON();const user={id:email,aud:'authenticated',role:'authenticated',email}
   const token=['eyJhbGciOiJIUzI1NiJ9',Buffer.from(JSON.stringify({sub:email,exp:Math.floor(Date.now()/1000)+3600,aud:'authenticated'})).toString('base64url'),'synthetic'].join('.')
   return route.fulfill({json:{access_token:token,refresh_token:'fixture-'+email,token_type:'bearer',expires_in:3600,user}})
  }
  if(u.pathname==='/auth/v1/logout'){logout.push(u.searchParams.get('scope'));return route.fulfill({status:204})}
  return route.abort()
 })
 const open=async path=>{const p=await context.newPage();p.setDefaultTimeout(5000);await p.goto('http://ksc.test'+path);await p.getByText('Signed out',{exact:true}).waitFor();return p}
 const login=async(p,email)=>{await p.evaluate(email=>window.auth.signIn(email,'Synthetic!123'),email);await p.getByText(email,{exact:true}).waitFor()}
 return {context,open,login,logout}
}
test('Admin, teacher and student stay independent across login, reload and local logout',async t=>{
 const {open,login,logout}=await setup(t)
 const admin=await open('/admin/login'),teacher=await open('/teacher/login'),student=await open('/login')
 await login(admin,'admin@fixture.test');await login(teacher,'teacher@fixture.test');await login(student,'student@fixture.test')
 for(const [page,email] of [[admin,'admin@fixture.test'],[teacher,'teacher@fixture.test'],[student,'student@fixture.test']]){await page.reload();await page.getByText(email,{exact:true}).waitFor()}
 await admin.evaluate(()=>window.auth.signOut());await admin.getByText('Signed out',{exact:true}).waitFor()
 await teacher.getByText('teacher@fixture.test',{exact:true}).waitFor();await student.getByText('student@fixture.test',{exact:true}).waitFor()
 assert.deepEqual(logout,['local'])
})
test('Same email in two portals has independent sessions; same portal tabs share sign out',async t=>{
 const {context,open,login}=await setup(t);const admin=await open('/admin/login'),teacher=await open('/teacher/login')
 await login(admin,'same@fixture.test');await login(teacher,'same@fixture.test')
 const admin2=await context.newPage();await admin2.goto('http://ksc.test/dashboard/admin');await admin2.getByText('same@fixture.test',{exact:true}).waitFor()
 await admin.evaluate(()=>window.auth.signOut());await admin2.getByText('Signed out',{exact:true}).waitFor();await teacher.getByText('same@fixture.test',{exact:true}).waitFor()
})
test('Cross-portal navigation loads the destination client and recovery preserves portal',async t=>{
 const {open,login}=await setup(t);const p=await open('/admin/login');await login(p,'admin@fixture.test')
 await p.evaluate(()=>window.navigate('/teacher/login'));await p.waitForURL('**/teacher/login');await p.getByText('Signed out',{exact:true}).waitFor()
 assert.equal(await p.evaluate(()=>window.portal),'teacher')
 await p.goto('http://ksc.test/forgot-password');await p.getByText('Signed out',{exact:true}).waitFor()
 assert.equal(await p.evaluate(()=>window.recoveryPath),'/reset-password?portal=teacher')
 assert.equal(await p.evaluate(()=>window.loginPath),'/teacher/login')
 await p.goto('http://ksc.test/reset-password?portal=admin');await p.getByText('admin@fixture.test',{exact:true}).waitFor()
 assert.equal(await p.evaluate(()=>window.portal),'admin')
})
