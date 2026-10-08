// Fixture screenshots of the publish-a-test journey for visual review.
// Renders the real app shell with the built CSS (run `npm run build` first). No backend is contacted
// and every paper shown is sample data.
// Usage: node scripts/shot-publish-journey.mjs   → scratch/publish-journey/*.png
import {build} from 'esbuild'
import {chromium} from 'playwright'
import {readFile,readdir,mkdir} from 'node:fs/promises'

const out='scratch/publish-journey'
const cssFile=(await readdir('dist/assets')).find(name=>/^index-.*\.css$/.test(name))
if(!cssFile)throw new Error('Run npm run build first: dist/assets/index-*.css was not found.')
const css=await readFile('dist/assets/'+cssFile,'utf8')
const logo=await readFile('public/ksc/institute-logo.png')
const markLight=await readFile('public/brand/logo-mark-light.svg')
await mkdir(out,{recursive:true})

const transport=`
export const isSupabaseConfigured=true
const f=()=>window.fixture
const rpc=async(name,args)=>{
 if(name==='ksc_my_access')return {data:f().access}
 if(name==='is_teacher')return {data:false}
 if(name==='ksc_exam_library_list'){if(f().hold)await new Promise(()=>{});return {data:f().papers}}
 if(name==='ksc_program_library_deliveries')return {data:f().deliveries}
 if(name==='ksc_library_deliveries')return {data:f().legacy}
 if(name==='ksc_withdraw_published_test'){f().deliveries=f().deliveries.filter(d=>d.test_id!==args.p_test);return {data:{test_id:args.p_test,withdrawn:true,results_kept:2}}}
 if(name==='ksc_publish_program_paper'){
  const paper=f().papers.find(p=>p.id===args.p_version)
  const result={id:'new',version_id:paper.id,test_id:'test',title:args.p_title,exam_id:args.p_exam,program:paper.exam_name,opens_at:new Date().toISOString(),question_count:paper.question_count}
  f().deliveries=[result,...f().deliveries]
  return {data:result}
 }
 return {data:[]}
}
export const supabase={
 auth:{getSession:async()=>({data:{session:f().session}}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),signOut:async()=>({error:null})},
 from:()=>{const q={select:()=>q,order:()=>q,eq:()=>q,single:()=>q,then:resolve=>resolve({data:[],error:null})};return q},
 rpc:(name,args)=>{const request={then:(resolve,reject)=>rpc(name,args).then(resolve,reject),abortSignal:()=>request};return request},
}`
const bundle=(await build({
 stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {AuthProvider} from './src/context/AuthContext.jsx';import App from './src/App.jsx';window.mount=()=>createRoot(document.getElementById('root')).render(<AuthProvider><App/></AuthProvider>)`,resolveDir:process.cwd(),loader:'jsx'},
 bundle:true,write:false,format:'iife',jsx:'automatic',loader:{'.css':'empty'},
 define:{'import.meta.url':JSON.stringify('http://127.0.0.1:55555/entry.js'),'import.meta.env.DEV':'true','import.meta.env.VITE_PUBLIC_PREVIEW':'"false"'},
 plugins:[{name:'fixture-transport',setup(b){
  b.onResolve({filter:/supabaseClient\.js$/},()=>({path:'transport',namespace:'fixture'}))
  b.onLoad({filter:/.*/,namespace:'fixture'},()=>({loader:'js',contents:transport}))
 }}],
})).outputFiles[0].text

const paper=(id,exam_id,exam_name,title,rest={})=>({id,exam_id,exam_name,title,version:'1',question_count:150,duration:60,marks:1,created_at:'2026-10-05T05:00:00Z',can_bring_back:true,can_delete:true,...rest})
const papers=[
 paper('g1','group','Group-II','Sample Group-II General Studies Test 1'),
 paper('g4','group','Group-II','Sample Group-II General Studies Test 4'),
 paper('g5','group','Group-II','Sample Group-II General Studies Test 5',{duration:150}),
 paper('d1','dsc','DSC','Sample DSC Divisional Test 1',{question_count:100}),
 paper('s1','si','SI & Constable','Sample SI & Constable Preliminary Test',{question_count:200,duration:180}),
]
const deliveries=[{id:'p1',version_id:'g4',exam_id:'group',test_id:'t-g4',title:'Sample Group-II General Studies Test 4',program:'Group-II',opens_at:'2026-10-06T05:00:00Z',question_count:150}]
const legacy=[{id:'old',title:'Sample batch test',course:'Sample course',batches:['Morning batch'],opens_at:'2026-09-01T05:00:00Z',closes_at:'2026-09-20T05:00:00Z',created_at:'2026-09-01T05:00:00Z',question_count:100}]
const user=role=>({user:{id:'11111111-1111-4111-8111-111111111111',email:role+'@example.com',user_metadata:{full_name:role==='admin'?'Sample Admin':'Sample Teacher'}}})
const sizes=[[1440,900],[390,844],[320,640]]

const browser=await chromium.launch({headless:true})
async function open(role,width,height,patch={},query=''){
 const context=await browser.newContext({viewport:{width,height}})
 await context.route('**/*',route=>{
  const url=new URL(route.request().url())
  if(url.hostname!=='127.0.0.1')return route.abort()
  if(url.pathname.endsWith('.png'))return route.fulfill({contentType:'image/png',body:url.pathname.includes('mark-light')?markLight:logo})
  return route.fulfill({contentType:'text/html',body:'<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div></body></html>'})
 })
 const p=await context.newPage()
 p.setDefaultTimeout(8000)
 p.on('pageerror',e=>console.error('page error:',e.message))
 await p.goto('http://127.0.0.1:55555'+(role==='admin'?'/dashboard/admin/teaching/library':'/dashboard/teacher/library')+query)
 await p.addStyleTag({content:css})
 await p.evaluate(f=>{window.fixture=f},{session:user(role),access:{role,state:'active',password_change_required:false},papers,deliveries,legacy,...patch})
 await p.addScriptTag({content:bundle})
 await p.evaluate(()=>window.mount())
 await p.getByRole('heading',{name:/Publish a test|Published tests/}).waitFor()
 return p
}
const shot=async(p,name,width,fullPage=false)=>{await p.waitForTimeout(150);await p.screenshot({path:`${out}/${name}-${width}.png`,fullPage})}
const chip=(p,name)=>p.getByRole('button',{name:new RegExp('^'+name+', ')})

for(const [width,height] of sizes){
 let p=await open('admin',width,height,{papers:[],deliveries:[],legacy:[]})
 await p.getByRole('heading',{name:'No ready papers yet'}).waitFor()
 await shot(p,'1-library-empty',width)
 await p.context().close()

 p=await open('admin',width,height)
 await p.getByRole('heading',{name:'Ready to publish'}).waitFor()
 await shot(p,'2-all-programs',width,true)
 await chip(p,'Group-II').click()
 await shot(p,'3-program-filtered',width,true)
 await p.getByRole('button',{name:/More actions for Sample Group-II General Studies Test 1/}).click()
 await shot(p,'3b-admin-more-menu',width)
 await p.keyboard.press('Escape')
 await p.getByRole('button',{name:'Publish Sample Group-II General Studies Test 5'}).click()
 await p.getByRole('dialog').waitFor()
 await shot(p,'4-confirm-dialog',width)
 await p.getByRole('dialog').getByRole('button',{name:'Publish now',exact:true}).click()
 await p.getByRole('heading',{name:'Test published'}).waitFor()
 await shot(p,'5-success',width,true)
 await p.getByRole('button',{name:'View published tests'}).click()
 await p.getByRole('heading',{name:'Published tests',exact:true}).waitFor()
 await shot(p,'6-published-tests',width,true)
 await p.getByRole('button',{name:'More actions for Sample Group-II General Studies Test 4'}).click()
 await shot(p,'6b-published-menu',width)
 await p.getByRole('menuitem',{name:'Delete published test'}).click()
 await p.getByRole('dialog').waitFor()
 await shot(p,'6c-delete-test-dialog',width)
 await p.getByRole('dialog').getByRole('button',{name:'Delete test'}).click()
 await p.getByRole('heading',{name:'Published test deleted'}).waitFor()
 await shot(p,'6d-test-deleted',width,true)
 await p.context().close()

 p=await open('teacher',width,height)
 await p.getByRole('heading',{name:'Already published'}).waitFor()
 await shot(p,'7-teacher-view',width,true)
 await p.context().close()

 p=await open('admin',width,height,{},'?paper=d1&publish=1')
 await p.getByRole('dialog').waitFor()
 await shot(p,'7b-dashboard-publish-link',width)
 await p.context().close()

 p=await open('admin',width,height,{hold:true}).catch(()=>null)
 if(p){await shot(p,'8-loading',width);await p.context().close()}
}
await browser.close()
console.log('Saved screenshots to '+out)
