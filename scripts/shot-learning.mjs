// Screenshots of the student Learning (LMS) pages with sample records. Run `npm run build` first.
// node scripts/shot-learning.mjs  → scratch/learning-redesign/*.png
import {build} from 'esbuild'
import {chromium} from 'playwright'
import {readFile,readdir,mkdir} from 'node:fs/promises'
const bundle=(await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import LearningPage from './src/pages/student/LearningPage.jsx';createRoot(document.getElementById('root')).render(<LearningPage/>);`,resolveDir:process.cwd(),loader:'jsx'},bundle:true,write:false,loader:{'.css':'empty'},format:'iife',jsx:'automatic',plugins:[{name:'fixtures',setup(b){
 b.onResolve({filter:/(AuthContext\.jsx|learningService\.js)$/},a=>({path:a.path.split('/').pop(),namespace:'fx'}))
 b.onLoad({filter:/.*/,namespace:'fx'},({path})=>({loader:'js',contents:path==='AuthContext.jsx'?`export const useAuth=()=>({user:{id:'learner',email:'arjun@ksc.test',user_metadata:{full_name:'Arjun'}},signOut:async()=>({})});`
 :`const f=()=>window.fixture;export const learningService={courses:async()=>f().courses,programCourses:async()=>f().courses,completions:async()=>f().completions,lessons:async id=>f().lessons[id]||[],complete:async id=>{f().completions.push({lesson_id:id,completed_at:new Date().toISOString()})}};`}))
}}]})).outputFiles[0].text
const words=n=>Array.from({length:n},(_,i)=>['number','divisor','prime','factor','remainder','integer','value'][i%7]).join(' ')
const body=`Integers are the set of whole numbers together with their negatives: …, −3, −2, −1, 0, 1, 2, 3, …\n\nOn the number line, positive integers lie to the right of zero and negative integers lie to the left. The further right a number is, the greater its value.\n\nKey properties\n• Closure: the sum, difference and product of two integers is always an integer.\n• Commutative: a + b = b + a and a × b = b × a.\n• Associative: (a + b) + c = a + (b + c).\n\nExample: (−7) + 12 = 5, because we move 12 steps right from −7.\n\n${words(420)}.`
const L=(c,n,titles)=>titles.map((t,i)=>({id:c+i,title:t,body:i===1?body:words(150+i*90),is_published:true,sort_order:i}))
const fixture={courses:[
 {id:'m',name:'Sainik School · Mathematics',description:'Number system, algebra and geometry for the AISSEE entrance — explained step by step.'},
 {id:'s',name:'General Science',description:'Physics, chemistry and biology basics with everyday examples.'},
 {id:'e',name:'English Grammar',description:'Parts of speech, tenses and comprehension practice.'},
 {id:'g',name:'General Knowledge',description:'Current affairs and static GK for entrance exams.'}],
 lessons:{m:L('m',6,['Number system','Integers – Introduction and Properties','Fractions and decimals','Ratio and proportion','Simple interest','Perimeter and area']),
  s:L('s',4,['Matter around us','Motion and measurement','Light and shadows','Living organisms']),
  e:L('e',3,['Nouns and pronouns','Tenses','Reading comprehension']),g:[]},
 completions:[{lesson_id:'m0',completed_at:'2026-10-03T09:00:00Z'},{lesson_id:'e0',completed_at:'2026-09-28T09:00:00Z'},{lesson_id:'e1',completed_at:'2026-09-29T09:00:00Z'},{lesson_id:'e2',completed_at:'2026-10-01T09:00:00Z'}]}
const css=await readFile('dist/assets/'+(await readdir('dist/assets')).find(f=>f.endsWith('.css')),'utf8')
const browser=await chromium.launch();await mkdir('scratch/learning-redesign',{recursive:true})
async function shot(name,path,width,fx=fixture){
 const ctx=await browser.newContext({viewport:{width,height:900}});await ctx.route('**/*',r=>r.request().url().startsWith('http://ksc.test/')?r.fulfill({contentType:'text/html',body:'<div id="root"></div>'}):r.abort())
 const p=await ctx.newPage();await p.goto('http://ksc.test/'+path);await p.addStyleTag({content:css});await p.evaluate(f=>{window.fixture=structuredClone(f)},fx);await p.addScriptTag({content:bundle})
 await p.locator('.lx-hero,.lx-course-head,.lx-lesson-card,.lx-empty').first().waitFor();await p.waitForTimeout(700)
 const overflow=await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth);if(overflow)console.log('OVERFLOW',name,width)
 await p.screenshot({path:`scratch/learning-redesign/${name}-${width}.png`,fullPage:true});await ctx.close()
}
for(const w of [1440,390,320]){
 await shot('home','dashboard/student/courses',w)
 await shot('course','dashboard/student/courses?course=m',w)
 await shot('lesson','dashboard/student/courses?course=m&lesson=m1',w)
}
await shot('home-empty','dashboard/student/courses',390,{courses:[],lessons:{},completions:[]})
await shot('lesson-done','dashboard/student/courses?course=e&lesson=e2',1440)
await browser.close();console.log('done')
