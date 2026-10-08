import {test,before,after} from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {chromium} from 'playwright'
import {readFile,readdir,mkdir} from 'node:fs/promises'
import {catalogue} from './fixtures/portal-catalogue.mjs'
let browser,bundle
before(async()=>{
 bundle=(await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import Bank from './src/pages/admin/AdminQuestionBank.jsx';import Import from './src/components/site/QuestionImportWorkspace.jsx';createRoot(document.getElementById('root')).render(window.reviewItems?<Import initialItems={window.reviewItems} onBack={()=>{}}/>:<Bank/>);`,resolveDir:process.cwd(),loader:'jsx'},bundle:true,write:false,format:'iife',jsx:'automatic',plugins:[{name:'transport',setup(b){
 b.onResolve({filter:/supabaseClient\.js$/},()=>({path:'client',namespace:'fixture'}))
 b.onLoad({filter:/.*/,namespace:'fixture'},()=>({loader:'js',contents:`export const supabase={
 from(table){let filters=[],patch=null,one=false;const q={select(){return q},eq(k,v){filters.push([k,v]);return q},order(){return q},range(){return q},single(){one=true;return q},maybeSingle(){one=true;return q},update(v){patch=v;return q},then(resolve,reject){let rows=(window.tables[table]||[]).filter(row=>filters.every(([k,v])=>row[k]===v));if(patch)rows.forEach(row=>Object.assign(row,patch));return Promise.resolve({data:one?(rows[0]||null):rows,error:null}).then(resolve,reject)}};return q},
 async rpc(name,args){window.calls.push({name,args});if(window.failSave)return {error:{message:'Save failed'}};const id=args.p_id||'saved';const question={id,...args.p_question,status:'DRAFT'};window.tables.questions=window.tables.questions.filter(q=>q.id!==id).concat(question);window.tables.question_options=args.p_options.map((content,i)=>({id:'o'+i,question_id:id,content,sort_order:i}));window.tables.question_answer_keys=[{question_id:id,correct_option_id:'o'+args.p_correct_index}];return {data:question,error:null}}
 };`}))
 }}]})).outputFiles[0].text
 browser=await chromium.launch()
})
after(async()=>browser?.close())
async function open(t,{syllabi,subjects,reviewItems}={}){
 const ctx=await browser.newContext({viewport:{width:390,height:844}});t.after(()=>ctx.close())
 await ctx.route('**/*',r=>r.request().url().startsWith('http://ksc.test/')?r.fulfill({contentType:'text/html',body:'<div id="root"></div>'}):r.abort())
 const p=await ctx.newPage();p.setDefaultTimeout(5000);await p.goto('http://ksc.test/dashboard/admin/questions')
 const css=(await readdir('dist/assets')).find(f=>f.endsWith('.css'));await p.addStyleTag({content:await readFile('dist/assets/'+css,'utf8')})
 await p.evaluate(({catalogue,syllabi,subjects,reviewItems})=>{
   window.tables={program_categories:catalogue.categories,exams:catalogue.exams,exam_levels:catalogue.levels,exam_subjects:subjects||catalogue.subjects,syllabi:syllabi||catalogue.syllabi.map(s=>({...s,status:'ACTIVE'})),chapters:catalogue.chapters,topics:catalogue.topics,questions:[],question_options:[],question_answer_keys:[]};window.calls=[];window.reviewItems=reviewItems
 },{catalogue,syllabi,subjects,reviewItems})
 await p.addScriptTag({content:bundle});return p
}
async function selectContext(p){await p.getByLabel('Program',{exact:true}).selectOption('sainik');await p.getByLabel('Track / class',{exact:true}).selectOption('six');await p.getByLabel('Academic subject',{exact:true}).selectOption('math')}
test('real bank components and services save draft, retry failure, review approval and re-edit',async t=>{
 const p=await open(t);await selectContext(p);await p.getByRole('button',{name:'Create Question',exact:true}).click()
 await p.waitForFunction(()=>document.querySelector('[aria-label="Syllabus"]').value==='syllabus')
 await p.getByPlaceholder(/If \$2x/).fill('Acceptance: 2 + 2 = ?')
 for(const [i,value] of ['3','4','5','6'].entries())await p.getByPlaceholder('Option '+String.fromCharCode(65+i),{exact:true}).fill(value)
 await p.getByTitle('Mark as correct answer').nth(1).click()
 await p.locator('textarea').last().fill('Add two and two.')
 await p.evaluate(()=>window.failSave=true);await p.getByRole('button',{name:'Save Draft',exact:true}).click();await p.getByText('Save failed',{exact:true}).waitFor()
 assert.equal(await p.getByPlaceholder(/If \$2x/).inputValue(),'Acceptance: 2 + 2 = ?')
 await p.evaluate(()=>window.failSave=false);await p.getByRole('button',{name:'Save Draft',exact:true}).click()
 await p.getByRole('button',{name:/Review/}).click();await p.getByRole('heading',{name:'Review Question'}).waitFor()
 assert.equal(await p.getByText('DRAFT',{exact:true}).count(),1)
 await p.getByRole('button',{name:'Approve Question',exact:true}).click();await p.getByText('APPROVED',{exact:true}).waitFor()
 const calls=await p.evaluate(()=>window.calls);assert.equal(calls[1].name,'ksc_save_question');assert.equal(calls[1].args.p_question.syllabus_id,'syllabus');assert.equal(calls[1].args.p_correct_index,1)
 await p.getByTitle('Edit',{exact:true}).click();await p.getByRole('button',{name:'Save Draft',exact:true}).click();await p.getByText('DRAFT',{exact:true}).waitFor()
 assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
 await mkdir('scratch/question-authoring',{recursive:true});await p.screenshot({path:'scratch/question-authoring/bank-mobile.png',fullPage:true})
})
test('authoring has empty states, active-only options, multiple syllabus choice and parent clearing',async t=>{
 const p=await open(t,{syllabi:[{...catalogue.syllabi[0],status:'ACTIVE'},{...catalogue.syllabi[0],id:'second',name:'Second syllabus',status:'ACTIVE'},{...catalogue.syllabi[0],id:'archived',name:'Archived syllabus',status:'ARCHIVED'}]})
 await p.getByRole('button',{name:'Create Question',exact:true}).click();await selectContext(p)
 assert.equal(await p.getByLabel('Syllabus',{exact:true}).inputValue(),'');assert.equal(await p.locator('option[value="archived"]').count(),0)
 await p.getByLabel('Syllabus',{exact:true}).selectOption('syllabus');await p.getByLabel('Chapter',{exact:true}).selectOption('chapter');await p.getByLabel('Topic',{exact:true}).selectOption('topic')
 await p.getByLabel('Track / class',{exact:true}).selectOption('nine');assert.equal(await p.getByLabel('Topic',{exact:true}).inputValue(),'');assert.equal(await p.getByLabel('Topic',{exact:true}).isDisabled(),true)
 await p.getByLabel('Academic subject',{exact:true}).selectOption('math');await p.getByText('No active syllabi configured',{exact:true}).waitFor({state:'attached'})
 const empty=await open(t,{subjects:[]});await empty.getByRole('button',{name:'Create Question',exact:true}).click();await empty.getByLabel('Program',{exact:true}).selectOption('sainik');await empty.getByLabel('Track / class',{exact:true}).selectOption('six');await empty.getByText('No subjects configured',{exact:true}).waitFor({state:'attached'})
})
test('all import entries reach empty shared review without uploading or writing questions',async t=>{
 const p=await open(t);await p.getByRole('button',{name:'Import Questions',exact:true}).click()
 for(const label of ['Upload PDF','Excel / CSV','Paste Text']){await p.getByRole('button',{name:label,exact:true}).click();await p.getByText(/No parsed questions yet/).waitFor();assert.equal(await p.getByRole('button',{name:/Save drafts/}).isDisabled(),true)}
 await p.getByLabel('Source text',{exact:true}).fill('Unparsed source text');assert.equal(await p.evaluate(()=>window.calls.length),0)
 await p.screenshot({path:'scratch/question-authoring/import-mobile.png',fullPage:true});await p.setViewportSize({width:1366,height:900});await p.screenshot({path:'scratch/question-authoring/import-desktop.png',fullPage:true})
})
test('review candidates require a correct answer and edits revoke confirmation',async t=>{
 const academic={exam_id:'sainik',level_id:'six',subject_id:'math',syllabus_id:'syllabus',chapter_id:'',topic_id:''}
 const p=await open(t,{reviewItems:[{content:'Fixture review question',options:['3','4'],academic,source:{kind:'PDF',name:'fixture.pdf',page:1}}]})
 const confirm=p.getByLabel('I reviewed this question for draft import');assert.equal(await confirm.isDisabled(),true)
 await p.getByLabel('Correct answer 2',{exact:true}).check();await confirm.check();await p.getByText(/1 valid, included/).waitFor()
 await p.getByLabel('Question text',{exact:true}).fill('Edited fixture');assert.equal(await confirm.isChecked(),false)
 assert.equal(await p.evaluate(()=>window.calls.length),0)
})
