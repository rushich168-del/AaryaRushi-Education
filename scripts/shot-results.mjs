// Fixture screenshots of Student results and answer review (admin and teacher) for visual review.
// Renders the real app shell with the built CSS (run `npm run build` first). No backend is contacted
// and every paper shown is sample data.
// Usage: node scripts/shot-results.mjs   → scratch/results/*.png
import {build} from 'esbuild'
import {chromium} from 'playwright'
import {readFile,readdir,mkdir} from 'node:fs/promises'

const out='scratch/results'
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
 if(name==='ksc_teaching_courses')return {data:[]}
 if(name==='ksc_teaching_results')return {data:f().results}
 if(name==='ksc_delete_student_result')return {data:{attempt_id:args.p_attempt,deleted:true}}
 if(name==='ksc_teaching_result_review')return {data:f().review}
 if(name==='ksc_exam_library_list'){if(f().hold)await new Promise(()=>{});return {data:f().papers}}
 if(name==='ksc_program_library_deliveries')return {data:f().deliveries}
 if(name==='ksc_library_deliveries')return {data:f().legacy}
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


const result=(id,student,test,test_id,exam_id,program,score,total_marks,day)=>({id,student,test,test_id,exam_id,program,score,total_marks,submitted_at:`2026-10-0${day}T10:00:00Z`})
const results=[
 result('r1','Sample Learner Anitha','Sample DSC Divisional Test 1','t-dsc','dsc','DSC',72,100,6),
 result('r2','Sample Learner Bharath','Sample DSC Divisional Test 1','t-dsc','dsc','DSC',58.5,100,6),
 result('r3','Sample Learner Chaitanya','Sample DSC Divisional Test 1','t-dsc','dsc','DSC',41,100,5),
 result('r4','Sample Learner Divya','Sample Group-II General Studies Test 4','t-g4','group','Group-II',96,150,5),
 result('r5','Sample Learner Eshwar','Sample Group-II General Studies Test 4','t-g4','group','Group-II',null,150,4),
]
const review={student:'Sample Learner Anitha',test:'Sample DSC Divisional Test 1',program:'DSC',score:72,total_marks:100,questions:[
 {question_id:'q1',section:'Mathematics',content:'If 3x + 5 = 20, what is x?',selected_option_id:'b',correct_option_id:'b',marks_awarded:1,options:[{id:'a',content:'3'},{id:'b',content:'5'},{id:'c',content:'7'},{id:'d',content:'15'}],explanation:'3x = 15, so x = 5.'},
 {question_id:'q2',section:'General Studies',content:'Which river is called the Dakshina Ganga?',selected_option_id:'a',correct_option_id:'c',marks_awarded:-0.25,options:[{id:'a',content:'Krishna'},{id:'b',content:'Kaveri'},{id:'c',content:'Godavari'},{id:'d',content:'Tungabhadra'}]},
 {question_id:'q3',section:'General Studies',content:'Sample unanswered question',selected_option_id:null,correct_option_id:'a',marks_awarded:0,options:[{id:'a',content:'Option A'},{id:'b',content:'Option B'}]},
]}
const user=role=>({user:{id:'11111111-1111-4111-8111-111111111111',email:role+'@example.com',user_metadata:{full_name:role==='admin'?'Sample Admin':'Sample Teacher'}}})
const browser=await chromium.launch({headless:true})
async function open(role,path,width,height=900,patch={}){
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
 await p.goto('http://127.0.0.1:55555'+path)
 await p.addStyleTag({content:css})
 await p.evaluate(f=>{window.fixture=f},{session:user(role),access:{role,state:'active',password_change_required:false},papers:[],deliveries:[],legacy:[],results,review,...patch})
 await p.addScriptTag({content:bundle})
 await p.evaluate(()=>window.mount())
 await p.getByRole('heading',{name:/Student results|answer review|Results for/i}).first().waitFor()
 await p.waitForTimeout(200)
 return p
}
for(const width of [1440,390]){
 for(const [name,role,path] of [
  ['1-admin-all','admin','/dashboard/admin/teaching/results'],
  ['2-admin-one-test','admin','/dashboard/admin/teaching/results?test=t-dsc'],
  ['3-admin-review','admin','/dashboard/admin/teaching/results?attempt=r1'],
  ['4-teacher-all','teacher','/dashboard/teacher/results'],
 ]){
  const p=await open(role,path,width)
  await p.screenshot({path:`${out}/${name}-${width}.png`,fullPage:true})
  await p.context().close()
 }
}
for(const width of [1440,390]){
 const p=await open('admin','/dashboard/admin/teaching/results',width)
 await p.getByRole('button',{name:/More actions for Sample Learner Bharath/}).click()
 await p.screenshot({path:`${out}/6-admin-result-menu-${width}.png`})
 await p.getByRole('menuitem',{name:'Delete result'}).click()
 await p.getByRole('dialog').waitFor()
 await p.screenshot({path:`${out}/7-admin-delete-result-dialog-${width}.png`})
 await p.getByRole('dialog').getByRole('button',{name:'Delete result'}).click()
 await p.getByText(/was deleted/).waitFor()
 await p.screenshot({path:`${out}/8-admin-result-deleted-${width}.png`,fullPage:true})
 await p.context().close()
}
const p=await open('admin','/dashboard/admin/teaching/results',1440,900,{results:[]})
await p.screenshot({path:`${out}/5-admin-empty-1440.png`,fullPage:true})
await browser.close()
console.log('Saved screenshots to '+out)
