import {test,before,after} from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {chromium} from 'playwright'
import {readFile,readdir,mkdir} from 'node:fs/promises'
let browser,bundle,css
before(async()=>{
 css=await readFile('dist/assets/'+(await readdir('dist/assets')).find(f=>f.endsWith('.css')),'utf8')
 await mkdir('scratch/student-program',{recursive:true})
 bundle=(await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {AuthProvider} from './src/context/AuthContext.jsx';import Signup from './src/pages/SignupPage.jsx';import Gate,{useStudentProgram} from './src/components/auth/StudentProgramGate.jsx';import Settings from './src/pages/admin/SignupProgramSettings.jsx';import Programs from './src/pages/public/ExamsListingPage.jsx';function Workspace(){const p=useStudentProgram();return <div>Learning workspace {p?.selection?.program} {p?.selection?.track} {p?.setupRequired?'Baseline compatibility':''}</div>}createRoot(document.getElementById('root')).render(<AuthProvider>{window.fixture.page==='signup'?<Signup/>:window.fixture.page==='admin'?<Settings/>:window.fixture.page==='programs'?<Programs/>:<Gate><Workspace/></Gate>}</AuthProvider>);`,resolveDir:process.cwd(),loader:'jsx'},bundle:true,write:false,format:'iife',jsx:'automatic',loader:{'.css':'empty'},plugins:[{name:'offline',setup(b){
 b.onResolve({filter:/supabaseClient(\.js)?$/},()=>({path:'transport',namespace:'fixture'}))
 b.onResolve({filter:/routes\.js$/},()=>({path:'navigation',namespace:'fixture'}))
 b.onLoad({filter:/.*/,namespace:'fixture'},({path})=>({loader:'js',contents:path==='navigation'?`export const navigateTo=p=>window.navigated=p;`:`
 export const isSupabaseConfigured=true;const f=()=>window.fixture;export const supabase={auth:{getSession:async()=>({data:{session:f().page==='signup'?null:{user:{id:'student'}}}}),onAuthStateChange:cb=>({data:{subscription:{unsubscribe(){}}}}),signUp:async args=>{window.signup=args;if(f().authError)return {error:{message:'Failed to fetch'}};return {data:{user:{identities:[{}]},session:f().immediate?{user:{id:'student'}}:null}}}},rpc:async(name,args)=>{
 window.calls.push({name,args});if(f().missing)return {error:{code:'PGRST202'}};if(f().network)return {error:{code:'NETWORK',message:'Connection interrupted. Retry.'}};
 if(name==='ksc_signup_catalogue')return {data:f().closed?{programs:[]}:f().catalogue};
 if(name==='ksc_student_program_state')return {data:f().state};
 if(name==='ksc_set_student_program'){if(f().saveError)return {error:{message:'Your program changed. Refresh and retry.'}};const p=f().catalogue.programs.find(p=>p.tracks.some(t=>t.id===args.p_level));const t=p?.tracks.find(t=>t.id===args.p_level);f().state={...f().state,selection:{exam_id:p?.id,level_id:args.p_level,program:p?.name||'Enrolled program',track:t?.name||'Enrolled track',available:true,version:args.p_version+1}};return {data:f().state}}
 if(name==='ksc_signup_program_settings')return {data:[{id:'sainik',name:'Sainik School',enabled:f().enabled,active:true,tracks:2}]};
 if(name==='ksc_set_signup_program'){f().enabled=args.p_enabled;return {data:null}};throw Error('Unexpected RPC '+name)
 }};`}))
 }}]})).outputFiles[0].text
 browser=await chromium.launch({headless:true})
})
after(()=>browser?.close())
const catalogue={programs:[{id:'sainik',name:'Sainik School',category:'School entrance',tracks:[{id:'vi',name:'Class VI'},{id:'ix',name:'Class IX'}]},{id:'neet',name:'NEET',category:'Entrance preparation',tracks:[{id:'ug',name:'UG'}]}]}
async function open(t,patch={},width=1440){
 const context=await browser.newContext({viewport:{width,height:950}});t.after(()=>context.close())
 await context.route('**/*',async r=>{const u=new URL(r.request().url());if(u.hostname!=='ksc.test')return r.abort();return u.pathname.startsWith('/brand/')?r.fulfill({contentType:'image/png',body:await readFile('public'+u.pathname)}):r.fulfill({contentType:'text/html',body:'<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div></body></html>'})})
 const p=await context.newPage();p.setDefaultTimeout(5000);const errors=[];p.on('pageerror',e=>errors.push(e.message));t.after(()=>assert.deepEqual(errors,[]))
 await p.goto('http://ksc.test/'+(patch.url|| (patch.switching?'dashboard/student/program':'signup')));await p.evaluate(f=>{window.fixture=f;window.calls=[]},{page:'signup',catalogue,state:{selection:null,enrolled:[],suggested_level_id:null},...patch});await p.addStyleTag({content:css});await p.addScriptTag({content:bundle});return p
}
async function choose(p,track='Class VI'){await p.getByRole('button',{name:/Sainik School/}).click();await p.getByLabel(track,{exact:true}).check();await p.getByRole('button',{name:'Continue',exact:true}).click()}
async function account(p){await p.getByLabel('Student full name').fill('Arjun Kumar');await p.getByLabel('Email',{exact:true}).fill('arjun@ksc.test');await p.getByLabel(/^Password/).fill('password123')}
test('program-first signup is responsive and sends only name and preparation hint, then waits for confirmation',async t=>{
 for(const width of [1440,390,320]){
  const p=await open(t,{},width);await p.getByRole('heading',{name:'What are you preparing for?'}).waitFor();assert.equal(await p.locator('input[type=email]').count(),0)
  await p.screenshot({path:`scratch/student-program/signup-program-${width}.png`,fullPage:true});await choose(p);await account(p)
  assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await p.screenshot({path:`scratch/student-program/signup-account-${width}.png`,fullPage:true})
  await p.getByRole('button',{name:'Create student account'}).click();await p.getByRole('heading',{name:'Check your email'}).waitFor()
  assert.equal(await p.evaluate(()=>window.navigated),undefined)
  const payload=await p.evaluate(()=>window.signup);assert.deepEqual(payload.options.data,{full_name:'Arjun Kumar',ksc_requested_level:'vi'});assert.equal(payload.options.emailRedirectTo,'http://ksc.test/dashboard/student');assert.equal(payload.email,'arjun@ksc.test')
 }
})
test('immediate confirmation opens explicit student route; registration closure creates no account',async t=>{
 const p=await open(t,{immediate:true});await choose(p);await account(p);await p.getByRole('button',{name:'Create student account'}).click();await p.waitForFunction(()=>window.navigated==='/dashboard/student')
 const closed=await open(t);await choose(closed);await account(closed);await closed.evaluate(()=>window.fixture.closed=true);await closed.getByRole('button',{name:'Create student account'}).click();await closed.getByRole('alert').waitFor();assert.equal(await closed.evaluate(()=>window.signup),undefined)
})
test('account error keeps name and selection; catalogue failure is retryable and empty catalogue is honest',async t=>{
 const p=await open(t,{authError:true});await choose(p);await account(p);await p.getByRole('button',{name:'Create student account'}).click();await p.getByRole('alert').waitFor();assert.equal(await p.getByLabel('Student full name').inputValue(),'Arjun Kumar');await p.evaluate(()=>window.fixture.authError=false);await p.getByRole('button',{name:'Create student account'}).click();await p.getByRole('heading',{name:'Check your email'}).waitFor()
 const bad=await open(t,{network:true});await bad.getByRole('button',{name:'Retry program list'}).click();await bad.evaluate(()=>window.fixture.network=false);await bad.getByRole('button',{name:'Retry program list'}).click();await bad.getByRole('heading',{name:'What are you preparing for?'}).waitFor()
 const empty=await open(t,{closed:true});await empty.getByText(/No programs are open/).waitFor();assert.equal(await empty.locator('form').count(),0)
})
test('missing setup blocks new signup while preserving installed student baseline; network errors do not bypass setup',async t=>{
 const signup=await open(t,{missing:true});await signup.getByRole('alert').waitFor();assert.equal(await signup.locator('form').count(),0)
 const old=await open(t,{page:'gate',missing:true});await old.getByText(/Learning workspace.*Baseline compatibility/).waitFor()
 const bad=await open(t,{page:'gate',network:true});await bad.getByRole('button',{name:'Retry program setup'}).waitFor();assert.equal(await bad.getByText(/Learning workspace/).count(),0);await bad.evaluate(()=>window.fixture.network=false);await bad.getByRole('button',{name:'Retry program setup'}).click();await bad.getByRole('heading',{name:'What are you preparing for?'}).waitFor()
})
test('first existing login selects once; confirmed signup or single enrollment hint saves once with account binding',async t=>{
 const p=await open(t,{page:'gate'});await choose(p,'Class IX');await p.waitForFunction(()=>window.navigated==='/dashboard/student');assert.deepEqual(await p.evaluate(()=>window.calls.find(c=>c.name==='ksc_set_student_program').args),{p_level:'ix',p_version:0,p_user:'student'})
 const auto=await open(t,{page:'gate',state:{selection:null,enrolled:[],suggested_level_id:'vi'}});await auto.getByText('Learning workspace Sainik School Class VI').waitFor();assert.equal(await auto.evaluate(()=>window.calls.filter(c=>c.name==='ksc_set_student_program').length),1)
})
test('switch persists version; failed save is retryable without losing chosen track',async t=>{
 const state={selection:{exam_id:'sainik',level_id:'vi',program:'Sainik School',track:'Class VI',available:true,version:7},enrolled:[],suggested_level_id:null}
 const p=await open(t,{page:'gate',switching:true,state,saveError:true});await choose(p,'Class IX');await p.getByRole('alert').waitFor();assert.equal(await p.getByLabel('Class IX').isChecked(),true);await p.evaluate(()=>window.fixture.saveError=false);await p.getByRole('button',{name:'Continue',exact:true}).click();await p.waitForFunction(()=>window.navigated==='/dashboard/student');assert.equal(await p.evaluate(()=>window.calls.filter(c=>c.name==='ksc_set_student_program').at(-1).args.p_version),7)
})
test('administrator can open and close registration through the settings component',async t=>{
 const p=await open(t,{page:'admin',enabled:false});await p.getByRole('button',{name:'Enable registration'}).click();await p.getByRole('button',{name:'Close registration'}).waitFor();await p.getByRole('button',{name:'Close registration'}).click();await p.getByRole('button',{name:'Enable registration'}).waitFor();assert.deepEqual(await p.evaluate(()=>window.calls.filter(c=>c.name==='ksc_set_signup_program').map(c=>c.args)),[{p_exam:'sainik',p_enabled:true},{p_exam:'sainik',p_enabled:false}])
})
const families={programs:[...catalogue.programs.slice(0,1),...['CBSE','ICSE','State Board'].map((board,i)=>({id:'school'+i,slug:'school'+i,name:board+' School Foundation',category:'School Foundation',tracks:['VI','VII','VIII','IX','X'].map(c=>({id:'board'+i+c,name:'Class '+c}))})),{id:'foundation',slug:'iit-neet-foundation',name:'IIT / NEET Foundation',category:'IIT / NEET',tracks:['VI','VII','VIII','IX','X'].map(c=>({id:'iit'+c,name:'Class '+c}))},...['JEE Main','NEET'].map((name,i)=>({id:'entrance'+i,slug:i?'neet':'jee-main',name,category:'IIT / NEET',tracks:['XI','XII'].map(c=>({id:'entrance'+i+c,name:'Class '+c}))})),...['DSC','Group-II','SI & Constable'].map((name,i)=>({id:'competitive'+i,slug:'competitive'+i,name,category:'Competitive Exam Preparation',tracks:[{id:'government'+i,name:'General preparation'}]}))]}
test('all program families fit small phones and changing board/program clears the earlier class',async t=>{
 for(const width of [1440,390,320]){
  const p=await open(t,{catalogue:families},width);await p.getByRole('heading',{name:'School Foundation',exact:true}).waitFor();await p.getByRole('heading',{name:'IIT / NEET',exact:true}).waitFor();await p.getByRole('heading',{name:'Competitive Exam Preparation',exact:true}).waitFor()
  assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await p.screenshot({path:`scratch/student-program/all-families-${width}.png`,fullPage:true})
  await p.getByRole('button',{name:/CBSE School Foundation/}).click();await p.getByRole('radio',{name:'Class VI',exact:true}).check();await p.getByRole('button',{name:'Change program',exact:true}).click();await p.getByRole('button',{name:/ICSE School Foundation/}).click();assert.equal(await p.getByRole('button',{name:'Continue',exact:true}).isEnabled(),false);await p.getByRole('radio',{name:'Class X',exact:true}).check();await p.getByRole('button',{name:'Continue',exact:true}).click();await account(p);await p.getByRole('button',{name:'Create student account'}).click();await p.getByRole('heading',{name:'Check your email'}).waitFor();assert.equal(await p.evaluate(()=>window.signup.options.data.ksc_requested_level),'board1X')
 }
})
test('public programs use enabled catalogue and program deep link opens only its valid preparation tracks',async t=>{
 const p=await open(t,{page:'programs',catalogue:families,url:'courses'},320);await p.getByRole('heading',{name:'KSC Programs',exact:true}).waitFor();await p.getByRole('heading',{name:'CBSE School Foundation',exact:true}).waitFor();assert.equal(await p.locator('article').count(),families.programs.length);assert.equal(await p.getByRole('link',{name:'Choose this program'}).count(),families.programs.length);assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
 const direct=await open(t,{catalogue:families,url:'signup?program=neet'});await direct.getByRole('radio',{name:'Class XI',exact:true}).waitFor();assert.equal(await direct.getByRole('radio',{name:'Class VI',exact:true}).count(),0)
 const invalid=await open(t,{catalogue:families,url:'signup?program=unknown'});await invalid.getByRole('heading',{name:'What are you preparing for?',exact:true}).waitFor();assert.equal(await invalid.getByRole('radio').count(),0)
})




test('Saved programs remain available together and switching uses current account version',async t=>{
 const memberships=[{exam_id:'sainik',level_id:'vi',program:'Sainik School',track:'Class VI',available:true},{exam_id:'neet',level_id:'ug',program:'NEET',track:'UG',available:true}];
 const p=await open(t,{page:'gate',switching:true,state:{selection:{...memberships[0],version:2},memberships,enrolled:[],suggested_level_id:null}},320);
 await p.getByRole('heading',{name:'My preparation programs'}).waitFor();await p.getByRole('button',{name:'NEET · UG · Select',exact:true}).click();await p.getByRole('button',{name:'Continue',exact:true}).click();await p.waitForFunction(()=>window.navigated==='/dashboard/student');assert.equal(await p.evaluate(()=>window.fixture.state.selection.program),'NEET');
 const call=await p.evaluate(()=>window.calls.find(c=>c.name==='ksc_set_student_program'));assert.equal(call.args.p_level,'ug');assert.equal(call.args.p_version,2);assert.equal(call.args.p_user,'student');assert.equal(await p.evaluate(()=>window.fixture.state.memberships.length),2);
 assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
});
