import {test,before,after} from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {chromium} from 'playwright'
let browser,bundle
before(async()=>{
  bundle=(await build({stdin:{contents:`import React from 'react'; import {createRoot} from 'react-dom/client'; import App from './src/App.jsx'; import {AuthProvider} from './src/context/AuthContext.jsx'; import {supabase} from './src/lib/supabaseClient.js'; window.mount=async()=>{await supabase.auth.getSession(); await new Promise(r=>setTimeout(r,30)); createRoot(document.getElementById('root')).render(<React.StrictMode><AuthProvider><App /></AuthProvider></React.StrictMode>);};`,resolveDir:process.cwd(),loader:'jsx'},loader:{'.css':'empty'},bundle:true,write:false,format:'iife',jsx:'automatic',define:{'import.meta.url':JSON.stringify('http://ksc.test/entry.js'),'import.meta.env':JSON.stringify({VITE_SUPABASE_URL:'https://fixture.supabase.co',VITE_SUPABASE_ANON_KEY:'fixture-public-key'})}})).outputFiles[0].text
  browser=await chromium.launch()
})
after(async()=>browser?.close())
async function open(t,path){
 const context=await browser.newContext();t.after(()=>context.close());const page=await context.newPage();page.setDefaultTimeout(4000)
 await context.route('**/*',route=>{
  const url=new URL(route.request().url())
  if(url.origin==='http://ksc.test')return route.fulfill({contentType:'text/html',body:'<div id="root"></div>'})
  if(url.origin==='https://fixture.supabase.co'&&url.pathname==='/auth/v1/user')return route.fulfill({contentType:'application/json',body:JSON.stringify({id:'fixture-user',aud:'authenticated',role:'authenticated',email:'fixture@example.com'})})
  return route.abort()
 })
 await page.goto('http://ksc.test'+path);await page.addScriptTag({content:bundle});await page.evaluate(()=>window.mount());return page
}
const fragment='#access_token=fixture-token&refresh_token=fixture-refresh&expires_in=3600&token_type=bearer&type=recovery'
test('Recovery callback arriving at root before React mounts opens password form',async t=>{
 const page=await open(t,'/'+fragment)
 await page.getByRole('heading',{name:'Set a new password'}).waitFor()
 assert.equal(new URL(page.url()).pathname,'/reset-password')
})
test('Direct reset callback opens form with actual SDK',async t=>{
 const page=await open(t,'/reset-password'+fragment)
 await page.getByLabel('New password',{exact:true}).waitFor()
})

test('Recovery callback returning to forgot-password before React mounts opens new-password form',async t=>{
 const page=await open(t,'/forgot-password'+fragment)
 await page.getByLabel('New password',{exact:true}).waitFor()
 assert.equal(new URL(page.url()).pathname,'/reset-password')
 await page.getByLabel('New password',{exact:true}).fill('fixture-new-password')
 await page.getByLabel('Confirm new password').fill('fixture-new-password')
 await page.getByRole('button',{name:'Update password'}).click()
 await page.getByText('Your password has been updated.').waitFor()
})
