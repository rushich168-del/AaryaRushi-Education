import {test,before,after} from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {chromium} from 'playwright'
import {readFile,readdir,mkdir} from 'node:fs/promises'
import {catalogue} from './fixtures/portal-catalogue.mjs'
let browser,bundle
before(async()=>{
 const helpers=(await readFile('src/services/programService.js','utf8')).split('export const emptyAcademicContext')[1].split('export const programService')[0]
 bundle=(await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import Portal from './src/pages/student/TestPortal.jsx';import Config from './src/pages/admin/AdminExamsConfig.jsx';import Questions from './src/pages/admin/AdminQuestionBank.jsx';import Patterns from './src/pages/admin/AdminExamPatterns.jsx';import Tests from './src/pages/admin/AdminTestBuilder.jsx';window.mount=screen=>createRoot(document.getElementById('root')).render(screen==='config'?<Config/>:screen==='questions'?<Questions/>:screen==='patterns'?<Patterns/>:screen==='tests'?<Tests/>:<Portal/>);`,resolveDir:process.cwd(),loader:'jsx'},bundle:true,write:false,format:'iife',jsx:'automatic',loader:{'.css':'empty'},define:{'import.meta.url':JSON.stringify('http://ksc.test/entry.js')},plugins:[{name:'isolated',setup(b){
  b.onResolve({filter:/StudentProgramGate\.jsx$/},()=>({path:'program-context',namespace:'fixture'}))
  b.onResolve({filter:/AuthContext\.jsx$/},()=>({path:'auth',namespace:'fixture'}))
  b.onResolve({filter:/(programService|studentExamService|learningService|questionBankService|examConfigService|examPatternService|testBuilderService)\.js$/},args=>({path:args.path.split('/').pop(),namespace:'fixture'}))
  b.onLoad({filter:/.*/,namespace:'fixture'},({path})=>({loader:'js',contents:path==='program-context'?`export const useStudentProgram=()=>window.fixture.programState;`:path==='auth'?`export const useAuth=()=>({user:{id:'student'}});`:path==='programService.js'?`export const emptyAcademicContext${helpers}
   export const programService={catalogue:async()=>{if(window.fixture.fail)throw Error('offline');return window.fixture.catalogue},myTracks:async()=>{if(window.fixture.enrollmentFail)throw Error('offline');return window.fixture.mine},courseTracks:async()=>[],create:async(table,value)=>{window.created={table,value}},linkCourse:async()=>{},unlinkCourse:async()=>{}};`
   :path==='studentExamService.js'?`export const studentExamService={getAvailableTests:async()=>window.fixture.tests,getMyAttempts:async()=>window.fixture.attempts};`
   :path==='learningService.js'?`export const learningService={courses:async()=>[]};`
   :path==='examConfigService.js'?`export const examConfigService={getExamCategories:async()=>window.fixture.catalogue.exams,getSubjectsForExam:async id=>window.fixture.catalogue.subjects.filter(s=>s.exam_id===id)};`
   :path==='questionBankService.js'?`export const questionBankService={getQuestions:async()=>window.fixture.questions,createQuestion:async(...args)=>{window.saved=args},getQuestionById:async id=>window.fixture.questions.find(q=>q.id===id)};`
   :path==='examPatternService.js'?`export const examPatternService={getPatterns:async()=>window.fixture.patterns,createPattern:async(...args)=>{window.saved=args}};`
   :`export const testBuilderService={getTests:async()=>window.fixture.tests,createTest:async args=>{window.saved=args;throw Error('Fixture save captured')},getTestById:async id=>window.fixture.tests.find(t=>t.id===id),getTestQuestions:async()=>[],getPublishedPreview:async()=>({test:{name:'Frozen test',is_published:true,status:'PUBLISHED',exam_patterns:{exam_pattern_sections:[{id:'s',section_name:'Frozen section',question_count:1,marks_per_question:4}]}},questions:[{section_id:'s',questions:{id:'q',content:'Frozen question'}}]})};`
  }))
 }}]})).outputFiles[0].text
 browser=await chromium.launch()
})
after(async()=>browser?.close())
async function open(t,screen='portal',patch={},path=''){
 const context=await browser.newContext({viewport:{width:390,height:844}});t.after(()=>context.close())
 await context.route('**/*',r=>r.request().url().startsWith('http://ksc.test/')?r.fulfill({contentType:'text/html',body:'<div id="root"></div>'}):r.abort())
 const p=await context.newPage();p.setDefaultTimeout(5000);await p.goto('http://ksc.test/'+path)
 p.on('pageerror',e=>console.error('Fixture page error:',e.message))
 t.after(async()=>{if(t.error)console.error(await p.locator('body').innerText().catch(()=>''))})
 const css=(await readdir('dist/assets')).find(f=>f.endsWith('.css'));await p.addStyleTag({content:await readFile('dist/assets/'+css,'utf8')})
 await p.evaluate(f=>window.fixture=f,{catalogue,mine:[],tests:[],attempts:[],questions:[],patterns:[],...patch})
 await p.addScriptTag({content:bundle});await p.evaluate(s=>window.mount(s),screen)
 return p
}
test('portal renders categories, configurable tracks, honest empty states and enrolled-only programs',async t=>{
 const p=await open(t,'portal',{mine:[{level_id:'six'}]})
 await p.getByRole('heading',{name:'Government Exams',exact:true}).waitFor()
 await p.getByRole('button',{name:'My Programs',exact:true}).click()
 assert.equal(await p.getByRole('button',{name:/EAMCET/}).count(),0)
 await p.getByRole('button',{name:/Sainik/}).click();await p.getByRole('button',{name:'Class VI · Enrolled',exact:true}).click()
 await p.getByText('No tests are currently available in this area.').waitFor()
 assert.equal(await p.getByRole('button',{name:'Model papers',exact:true}).count(),0)
 assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
 await mkdir('scratch/test-portal-checks',{recursive:true});await p.screenshot({path:'scratch/test-portal-checks/student-mobile.png',fullPage:true})
 await p.getByRole('button',{name:'← All programs'}).click();await p.getByRole('button',{name:'Explore Programs',exact:true}).click()
 await p.setViewportSize({width:1366,height:900});await p.screenshot({path:'scratch/test-portal-checks/student-desktop.png',fullPage:true})
 await p.getByRole('button',{name:/EAMCET/}).click();await p.getByRole('button',{name:'Agriculture/Pharmacy',exact:true}).waitFor()
})
test('track/test-area filtering routes to existing instructions, resume and result',async t=>{
 const tests=[{id:'new',exam_id:'sainik',level_id:'six',name:'New mock',test_kind:'FULL_MOCK',total_marks:10},{id:'resume',exam_id:'sainik',level_id:'six',name:'Resume me',test_kind:'SUBJECT'},{id:'done',exam_id:'sainik',level_id:'six',name:'Completed test',test_kind:'CHAPTER'},{id:'wrong',exam_id:'sainik',level_id:'nine',name:'Wrong track'}]
 const attempts=[{test_id:'resume',status:'IN_PROGRESS',tests:tests[1]},{id:'attempt',test_id:'done',status:'SUBMITTED',score:4,max_score:10,tests:tests[2]}]
 const p=await open(t,'portal',{tests,attempts},'?exam_id=sainik&level_id=six')
 await p.getByRole('heading',{name:'New mock',exact:true}).waitFor();assert.equal(await p.getByText('Wrong track',{exact:true}).count(),0)
 await p.getByRole('button',{name:'Full Mock Tests',exact:true}).click();assert.equal(await p.getByRole('heading',{name:'Resume me',exact:true}).count(),0)
 await p.getByRole('button',{name:'My Results',exact:true}).click();await p.getByText('Score: 4 / 10',{exact:true}).waitFor();await p.getByRole('button',{name:'View Result',exact:true}).click();assert.match(p.url(),/\/test\/done\/result$/)
 await p.getByRole('button',{name:'Full Mock Tests',exact:true}).click();await p.getByRole('button',{name:'Start Test',exact:true}).click();assert.match(p.url(),/\/test\/new\/instructions$/)
})
test('published DSC model paper appears immediately and refresh discovers new batch tests',async t=>{
 const dscCatalogue={...catalogue,exams:[...catalogue.exams,{id:'dsc',name:'DSC',is_active:true,category_id:null}],levels:[...catalogue.levels,{id:'sgt',exam_id:'dsc',name:'SGT',is_active:true}]}
 const published={id:'dsc-admin',exam_id:'dsc',level_id:'sgt',name:'DSC workflow check · Admin',test_kind:'MODEL',total_marks:100,duration_minutes:60}
 const p=await open(t,'portal',{catalogue:dscCatalogue,programState:{selection:{exam_id:'dsc',level_id:'sgt'}},mine:[{level_id:'sgt'}],tests:[published]},'?exam_id=dsc&level_id=sgt')
 await p.getByRole('heading',{name:published.name,exact:true}).waitFor();assert.equal(await p.getByRole('button',{name:'Available tests',exact:true}).getAttribute('aria-pressed'),'true')
 await p.evaluate(t=>window.fixture.tests.push({...t,id:'dsc-teacher',name:'DSC workflow check · Teacher'}),published)
 await p.getByRole('button',{name:'Refresh tests',exact:true}).click();await p.getByRole('heading',{name:'DSC workflow check · Teacher',exact:true}).waitFor()
 assert.equal(await p.getByRole('button',{name:'Start Test',exact:true}).count(),2)
 await p.getByRole('button',{name:'Full Mock Tests',exact:true}).click();assert.equal(await p.getByRole('heading',{name:published.name,exact:true}).count(),0)
 await p.getByRole('button',{name:'Available tests',exact:true}).click();await p.getByRole('heading',{name:published.name,exact:true}).waitFor()
})
test('load errors retry and enrollment failure does not fabricate an empty enrollment',async t=>{
 const p=await open(t,'portal',{fail:true,enrollmentFail:true})
 await p.getByRole('button',{name:'Retry',exact:true}).click();await p.evaluate(()=>window.fixture.fail=false);await p.getByRole('button',{name:'Retry',exact:true}).click()
 await p.getByRole('heading',{name:'Government Exams',exact:true}).waitFor();await p.getByRole('button',{name:'My Programs',exact:true}).click()
 assert.equal(await p.getByText(/No program tracks have been linked/).count(),0);await p.getByRole('button',{name:'Retry enrollment'}).waitFor()
})
test('staff creates hierarchy entries and context links keep track and topic',async t=>{
 const p=await open(t,'config')
 await p.getByLabel('Program',{exact:true}).selectOption('sainik');await p.getByLabel('Track / class',{exact:true}).selectOption('six');await p.getByLabel('Academic subject',{exact:true}).selectOption('math');await p.getByLabel('Syllabus',{exact:true}).selectOption('syllabus');await p.getByLabel('Chapter',{exact:true}).selectOption('chapter');await p.getByLabel('Topic',{exact:true}).selectOption('topic')
 assert.match(await p.getByRole('link',{name:'Question Bank →'}).getAttribute('href'),/level_id=six.*topic_id=topic/)
 await p.getByLabel('Entry type').selectOption('topics');await p.getByLabel('Entry name').fill('Equivalent fractions');await p.getByRole('button',{name:'Add entry',exact:true}).click()
 await p.waitForFunction(()=>window.created);assert.deepEqual(await p.evaluate(()=>window.created),{table:'topics',value:{name:'Equivalent fractions',chapter_id:'chapter'}})
 await p.getByLabel('Program',{exact:true}).selectOption('eamcet');assert.equal(await p.getByLabel('Track / class',{exact:true}).inputValue(),'');assert.equal(await p.getByLabel('Topic',{exact:true}).inputValue(),'')
 await p.screenshot({path:'scratch/test-portal-checks/staff-mobile.png',fullPage:true})
})
test('question context filters compose and creation persists all selected hierarchy IDs',async t=>{
 const p=await open(t,'questions',{questions:[{id:'q',content:'Matching fraction',exam_id:'sainik',level_id:'six',subject_id:'math',status:'DRAFT',difficulty:'EASY'},{id:'other',content:'Other class',exam_id:'sainik',level_id:'nine',status:'APPROVED'}]},'?exam_id=sainik&level_id=six&subject_id=math&syllabus_id=syllabus&chapter_id=chapter&topic_id=topic')
 await p.getByRole('button',{name:'Create Question',exact:true}).click()
 await p.getByPlaceholder(/If \$2x/).fill('Which fraction is larger?')
 for(const [i,text] of ['1/2','1/4','1/8','1/16'].entries())await p.getByPlaceholder('Option '+String.fromCharCode(65+i),{exact:true}).fill(text)
 await p.getByRole('button',{name:'Save Draft',exact:true}).click();await p.waitForFunction(()=>window.saved)
 const saved=await p.evaluate(()=>window.saved[0]);assert.equal(saved.level_id,'six');assert.equal(saved.topic_id,'topic');assert.equal(saved.subject_id,'math')
})
test('test creator restricts active patterns to selected track and sends test area/review policy',async t=>{
 const p=await open(t,'tests',{patterns:[{id:'p',exam_id:'sainik',level_id:'six',status:'ACTIVE',name:'VI pattern',total_marks:4,total_duration_minutes:10},{id:'wrong',exam_id:'sainik',level_id:'nine',status:'ACTIVE',name:'IX pattern'}]},'?exam_id=sainik&level_id=six')
 await p.getByRole('button',{name:'Create Test',exact:true}).click();await p.locator('option',{hasText:'VI pattern'}).waitFor({state:'attached'})
 assert.equal(await p.locator('option',{hasText:'IX pattern'}).count(),0)
 await p.getByLabel('Test area').selectOption('CHAPTER');await p.getByLabel('Student review policy').selectOption('SUMMARY_ONLY')
 await p.locator('select').filter({has:p.locator('option[value="p"]')}).selectOption('p');await p.getByPlaceholder('e.g. Weekly Mock Test 1').fill('Track practice');await p.getByRole('button',{name:'Create & Build',exact:true}).click();await p.waitForFunction(()=>window.saved)
 assert.equal(await p.evaluate(()=>window.saved.test_kind),'CHAPTER');assert.equal(await p.evaluate(()=>window.saved.review_policy),'SUMMARY_ONLY')
})
test('published staff preview uses frozen content',async t=>{
 const p=await open(t,'tests',{tests:[{id:'published',name:'Live renamed',status:'PUBLISHED',is_published:true}]})
 await p.getByRole('button',{name:'View Test',exact:true}).click();await p.getByText('Frozen question',{exact:true}).waitFor();await p.getByRole('heading',{name:'Frozen test',exact:true}).waitFor();assert.equal(await p.getByRole('button',{name:'Publish Test',exact:true}).count(),0)
})


test('saved program overrides a stale foreign-program URL and keeps results within the selected track',async t=>{
 const own={id:'own',exam_id:'sainik',level_id:'six',name:'Current program test',test_kind:'FULL_MOCK'}
 const foreign={id:'other',exam_id:'eamcet',level_id:'eng',name:'Foreign program test',test_kind:'FULL_MOCK'}
 const p=await open(t,'portal',{programState:{selection:{exam_id:'sainik',level_id:'six'}},tests:[own,foreign],attempts:[{id:'a',test_id:'other',status:'SUBMITTED',score:3,max_score:10,tests:foreign}]},'?exam_id=eamcet&level_id=eng')
 await p.getByRole('heading',{name:'Current program test',exact:true}).waitFor();assert.equal(await p.getByText('Foreign program test',{exact:true}).count(),0)
 assert.equal(await p.getByRole('link',{name:'Switch program'}).getAttribute('href'),'/dashboard/student/program')
 assert.equal(new URL(p.url()).searchParams.get('exam_id'),'sainik');await p.getByRole('button',{name:'My Results',exact:true}).click();await p.getByText('No completed tests for this track yet.',{exact:true}).waitFor()
})
