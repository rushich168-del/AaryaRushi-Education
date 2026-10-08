// Fixture screenshots of the student test journey (instructions + exam workspace) with the built CSS.
// Run `npm run build` first. No backend; all content is sample data. Output: scratch/student-test/*.png
import {build} from 'esbuild'
import {chromium} from 'playwright'
import {readFile,readdir,mkdir} from 'node:fs/promises'
const out='scratch/student-test'
await mkdir(out,{recursive:true})
const css=await readFile('dist/assets/'+(await readdir('dist/assets')).find(f=>/^index-.*\.css$/.test(f)),'utf8')
const marks={light:await readFile('public/brand/logo-mark-light.svg'),dark:await readFile('public/brand/logo-mark.svg')}
const sections=[['Biology',10],['Teaching Methodology',15],['Educational Psychology',15],['Geography',20],['Telugu / Language I',20],['Physical Science',20]]
const questions=[];let n=0
sections.forEach(([name,count],s)=>{for(let i=0;i<count;i++){n++;questions.push({question_id:'q'+n,section_id:'s'+s,content:n===1?'Which of the following is the functional unit of the kidney?':'Sample question '+n,marks:1,negative_marks:0,exam_pattern_sections:{section_name:name}})}})
const options=questions.flatMap(q=>q.question_id==='q1'?['Neuron','Nephron','Alveolus','Villus'].map((c,i)=>({id:q.question_id+'-'+i,question_id:q.question_id,content:c})):[0,1,2,3].map(i=>({id:q.question_id+'-'+i,question_id:q.question_id,content:'Option '+(i+1)})))
const stored={q1:{selected_option_id:'q1-1',is_marked_for_review:false},q2:{selected_option_id:'q2-0',is_marked_for_review:false},q3:{selected_option_id:null,is_marked_for_review:true},q5:{selected_option_id:'q5-2',is_marked_for_review:true}}
const bundle=(await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import Instructions from './src/pages/student/TestInstructions.jsx';import Workspace from './src/pages/student/ExamWorkspace.jsx';import Layout from './src/pages/student/StudentPortalLayout.jsx';import Shell from './src/components/site/ProgramOnboardingShell.jsx';import Choice from './src/components/site/ProgramChoice.jsx';
const T=(...n)=>n.map((name,i)=>({id:name+i,name}));const C=['VI','VII','VIII','IX','X'].map(c=>'Class '+c);
const programs=[['School & Military Entrance',[['Navodaya',['Class VI','Class IX']],['RIMC',['Class VIII']],['RMS',['Class VI','Class IX']],['Sainik',['Class VI','Class IX']]]],['School Foundation',[['CBSE School Foundation',C],['ICSE School Foundation',C],['State Board School Foundation',C]]],['IIT / NEET',[['IIT / NEET Foundation',C],['JEE Main',['Class XI','Class XII']],['NEET',['Class XI','Class XII']]]],['Competitive Exam Preparation',[['DSC',['General preparation']],['Group-II',['General preparation']],['SI & Constable',['General preparation']]]]].flatMap(([category,list])=>list.map(([name,tracks])=>({id:name,name,category,tracks:T(...tracks)})));
function Signup({track}){const [value,setValue]=React.useState(track?{exam:'Navodaya',level:'Class VI0'}:{exam:'',level:''});return <Shell step={value.exam?2:1}><Choice programs={programs} value={value} onChange={setValue} onContinue={()=>{}}/></Shell>}
window.mount=v=>createRoot(document.getElementById('root')).render(v==='instructions'?<Instructions testId="t"/>:v==='portal'?<Layout name="Sample Learner"><h2 style={{padding:24}}>Sample student dashboard</h2></Layout>:v==='login'?<Shell login><p>Sample sign-in form</p></Shell>:v==='signup'?<Signup/>:v==='signup-track'?<Signup track/>:<Workspace testId="t"/>)`,resolveDir:process.cwd(),loader:'jsx'},bundle:true,write:false,format:'iife',jsx:'automatic',loader:{'.css':'empty'},
 plugins:[{name:'fixture',setup(b){b.onResolve({filter:/studentExamService\.js$/},()=>({path:'s',namespace:'f'}));b.onResolve({filter:/AuthContext\.jsx$/},()=>({path:'auth',namespace:'a'}));b.onLoad({filter:/.*/,namespace:'a'},()=>({loader:'js',contents:'export const useAuth=()=>({user:{email:"learner@example.com",user_metadata:{full_name:"Sample Learner"}},signOut:async()=>({})})'}));b.onLoad({filter:/.*/,namespace:'f'},()=>({loader:'js',contents:`const f=()=>window.fixture;export const studentExamService={
 getTestDetails:async()=>({name:'DSC DIVISIONAL TEST - 1',exams:{name:'DSC'},duration_minutes:100,total_marks:100,exam_patterns:{exam_pattern_sections:f().sections.map(([n,c],i)=>({id:'s'+i,section_name:n,question_count:c,marks_per_question:1,negative_marks:0}))}}),
 startAttempt:async()=>{},getMyAttempts:async()=>[{id:'a',test_id:'t',status:'IN_PROGRESS',expires_at:new Date(Date.now()+5400000).toISOString(),tests:{name:'DSC DIVISIONAL TEST - 1'}}],
 getAttemptQuestions:async()=>f().questions,getAttemptOptions:async()=>f().options,getMyAnswers:async()=>Object.entries(f().stored).map(([question_id,a])=>({question_id,...a})),saveAnswer:async()=>{},submitAttempt:async()=>{}}`}))}}]})).outputFiles[0].text
const browser=await chromium.launch({headless:true})
for(const [w,h] of [[1440,900],[390,844]]){
 for(const view of process.env.VIEWS?process.env.VIEWS.split(','):['instructions','workspace','portal','login','signup','signup-track']){
  const ctx=await browser.newContext({viewport:{width:w,height:h}})
  await ctx.route('**/*',r=>r.request().url().endsWith('.png')?r.fulfill({contentType:'image/png',body:r.request().url().includes('mark-light')?marks.light:marks.dark}):r.fulfill({contentType:'text/html',body:'<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0"><div id="root"></div></body></html>'}))
  const p=await ctx.newPage();p.on('pageerror',e=>console.error(e.message))
  await p.goto('http://127.0.0.1:55555/test/t/attempt');await p.addStyleTag({content:css})
  await p.evaluate(x=>window.fixture=x,{sections,questions,options,stored});await p.addScriptTag({content:bundle});await p.evaluate(v=>window.mount(v),view)
  await p.waitForTimeout(900)
  await p.screenshot({path:`${out}/${view}-${w}.png`,fullPage:['instructions','signup','signup-track'].includes(view)})
  if(view==='workspace'&&w===390){await p.getByRole('button',{name:'Open question palette'}).click();await p.waitForTimeout(400);await p.screenshot({path:`${out}/workspace-palette-${w}.png`})}
  await ctx.close()
 }
}
await browser.close();console.log('Saved to '+out)
