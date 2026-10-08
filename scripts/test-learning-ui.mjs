import {test,before,after} from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {chromium} from 'playwright'
import {readFile,readdir,mkdir} from 'node:fs/promises'
let browser,bundle
before(async()=>{
 const portalHelpers=(await readFile('src/services/programService.js','utf8')).split('export const emptyAcademicContext')[1].split('export const programService')[0]
 bundle=(await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import LearningPage from './src/pages/student/LearningPage.jsx';import Questions from './src/pages/admin/AdminQuestionBank.jsx';import Patterns from './src/pages/admin/AdminExamPatterns.jsx';import Tests from './src/pages/admin/AdminTestBuilder.jsx';window.mount=(screen)=>createRoot(document.getElementById('root')).render(screen==='questions'?<Questions/>:screen==='patterns'?<Patterns/>:screen==='tests'?<Tests/>:<LearningPage staff={screen==='staff'}/>);`,resolveDir:process.cwd(),loader:'jsx'},bundle:true,write:false,loader:{'.css':'empty'},format:'iife',jsx:'automatic',define:{'import.meta.url':JSON.stringify('http://ksc.test/fixtures/entry.js')},plugins:[{name:'isolated-services',setup(b){
 b.onResolve({filter:/AuthContext\.jsx$/},()=>({path:'auth',namespace:'fixture'}));b.onResolve({filter:/(programService|learningService|examConfigService|questionBankService|examPatternService|testBuilderService)\.js$/},args=>({path:args.path.split('/').pop(),namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},({path})=>({loader:'js',contents:path==='auth'?`export const useAuth=()=>({user:{id:'learner'}});`:path==='learningService.js'?`
 const f=()=>window.fixture;const fail=()=>{if(f().fail)throw Error('Request failed')};
 export const learningService={courses:async()=>{fail();return f().courses},institutes:async()=>[{id:'institute',name:'KSC'}],lessons:async id=>{(window.lessonRequests||=[]).push(id);return f().lessons},batches:async()=>f().batches,completions:async()=>f().completions,progress:async()=>f().completions,roster:async()=>f().roster,
 createCourse:async(i,name,description)=>f().courses.push({id:'course',name,description}),createBatch:async(c,name)=>f().batches.push({id:'batch',name}),
 saveLesson:async(c,l)=>{if(f().failSave)throw Error('Save failed');f().lessons=[{...l,id:l.id||'lesson'}]},enroll:async()=>{f().roster=[{student_id:'learner',student_profiles:{full_name:'Learner'}}]},complete:async id=>{if(f().failComplete)throw Error('Network error.');f().completions=[{lesson_id:id,student_id:'learner'}]}};`
 :path==='programService.js'?`export const emptyAcademicContext${portalHelpers} export const programService={catalogue:async()=>({categories:[],exams:[{id:'exam',name:'Practice exam'}],levels:[],subjects:[],syllabi:[],chapters:[],topics:[]})};`
 :path==='examConfigService.js'?`export const examConfigService={getExamCategories:async()=>[{id:'exam',name:'Practice exam'}],getSubjectsForExam:async()=>[{id:'subject',name:'Arithmetic'}]};`
 :path==='questionBankService.js'?`export const questionBankService={getQuestions:async()=>window.fixture.questions||[],getQuestionById:async id=>window.fixture.questions.find(q=>q.id===id),createQuestion:async(...args)=>{window.savedQuestion=args}};`
 :path==='examPatternService.js'?`export const examPatternService={getPatterns:async()=>window.fixture.patterns||[],createPattern:async(...args)=>{window.savedPattern=args}};`
 :`export const testBuilderService={getTests:async()=>window.fixture.tests||[],getTestById:async id=>window.fixture.tests.find(t=>t.id===id),getTestQuestions:async()=>[],getEligibleQuestions:async()=>[]};`}))
 b.onResolve({filter:/staffAccountService\.js$/},()=>({path:'staff-routes',namespace:'staff-fixture'}))
 b.onLoad({filter:/.*/,namespace:'staff-fixture'},()=>({contents:`export const inTeacherWorkspace=()=>false; export const teacherCourse=()=>null;`,loader:'js'}))
 }}]})).outputFiles[0].text
 browser=await chromium.launch()
})
after(async()=>browser?.close())
async function open(t,screen,fixture={}){
 const context=await browser.newContext({viewport:{width:390,height:844}});t.after(()=>context.close());await context.route('**/*',r=>r.request().url().startsWith('http://ksc.test/')?r.fulfill({contentType:'text/html',body:'<div id="root"></div>'}):r.abort());const page=await context.newPage();page.setDefaultTimeout(5000)
 page.on('pageerror',error=>console.error('Local fixture page error:',error.message));
 await page.goto('http://ksc.test/'+(fixture.path||''));
 const css=(await readdir('dist/assets')).find(f=>f.endsWith('.css'));await page.addStyleTag({content:await readFile('dist/assets/'+css,'utf8')});
 await page.evaluate(f=>{window.fixture={courses:[],lessons:[],batches:[],completions:[],roster:[],...f}},fixture);await page.addScriptTag({content:bundle});await page.evaluate(s=>window.mount(s),screen);return page
}
test('teacher creates course, batch, lesson and enrolls learner through real page',async t=>{
 const p=await open(t,'staff');await p.getByLabel('Course name',{exact:true}).fill('Foundation');await p.getByLabel('Description',{exact:true}).fill('Learn arithmetic');await p.getByRole('button',{name:'Create course',exact:true}).click();
 await p.getByRole('button',{name:/Foundation/}).click();await p.getByLabel('New batch name').fill('Morning');await p.getByRole('button',{name:'Create batch',exact:true}).click();
 await p.getByRole('button',{name:'Add lesson'}).click();await p.getByLabel('Lesson title').fill('Addition');await p.getByLabel('Lesson text').fill('Two plus two makes four.');await p.getByLabel('Publish for enrolled learners').check();await p.getByRole('button',{name:'Save lesson'}).click();await p.getByRole('heading',{name:'Addition',exact:true}).waitFor();
 await p.getByLabel('Manage batch').selectOption('batch');await p.getByLabel('Confirmed learner email').fill('learner@example.com');await p.getByRole('button',{name:'Enroll learner',exact:true}).click();await p.getByText('Enrolled learners (1)',{exact:true}).waitFor();
 assert.equal(await p.evaluate(()=>window.fixture.lessons[0].is_published),true)
 await p.setViewportSize({width:1280,height:900});await mkdir('scratch/lms-checks',{recursive:true});await p.screenshot({path:'scratch/lms-checks/teacher.png',fullPage:true});
})
test('learner reads lesson and persists completion; empty courses remains honest',async t=>{
 const p=await open(t,'student',{courses:[{id:'course',name:'Foundation'}],lessons:[{id:'lesson',title:'Addition',body:'Two plus two makes four.',is_published:true}]});
 await p.getByRole('heading',{name:'Start your first lesson'}).waitFor();await p.getByRole('button',{name:'View lessons: Foundation'}).click();
 await p.getByText('0 of 1 published lessons completed',{exact:true}).waitFor();await p.getByRole('button',{name:'Start lesson 1: Addition'}).click();
 await p.getByText('Two plus two makes four.',{exact:true}).waitFor();assert.match(new URL(p.url()).search,/course=course&lesson=lesson/);
 await p.getByRole('button',{name:'Mark as completed'}).click();await p.getByText('Lesson completed. Your progress is saved.',{exact:true}).waitFor();await p.getByText('Course complete!',{exact:true}).waitFor();
 assert.deepEqual(await p.evaluate(()=>window.fixture.completions),[{lesson_id:'lesson',student_id:'learner'}]);
 assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await mkdir('scratch/lms-checks',{recursive:true});await p.screenshot({path:'scratch/lms-checks/student.png',fullPage:true});
 await p.getByRole('button',{name:'Back to my courses'}).click();await p.getByRole('heading',{name:'You’re all caught up'}).waitFor();await p.getByText('1 of 1 completed',{exact:true}).waitFor();
 const empty=await open(t,'student');await empty.getByText('No courses assigned yet.',{exact:false}).waitFor();
})
test('learner home resumes the next lesson, filters courses and pages through lessons',async t=>{
 const p=await open(t,'student',{courses:[{id:'a',name:'Arithmetic'},{id:'b',name:'Biology'}],lessons:[{id:'l1',title:'Counting',body:'One two three.',is_published:true},{id:'l2',title:'Adding',body:'Add numbers.',is_published:true},{id:'hidden',title:'Hidden draft',body:'x',is_published:false}],completions:[{lesson_id:'l1',student_id:'learner',completed_at:'2026-10-01T10:00:00Z'}]});
 await p.getByRole('heading',{name:'Pick up where you left off'}).waitFor();await p.getByRole('button',{name:'Resume lesson'}).click();
 await p.getByRole('heading',{name:'Adding',level:2}).waitFor();assert.equal(await p.getByText('Hidden draft').count(),0);
 await p.getByRole('button',{name:/Previous lesson/}).click();await p.getByRole('heading',{name:'Counting',level:2}).waitFor();await p.getByText('Lesson completed',{exact:true}).waitFor();
 await p.goBack();await p.getByRole('heading',{name:'Adding',level:2}).waitFor();
 await p.getByRole('button',{name:'My courses'}).first().click();await p.getByRole('button',{name:/Completed/,pressed:false}).click();await p.getByText('No courses match this filter.').waitFor();
 await p.getByRole('button',{name:'Show all courses'}).click();await p.getByLabel('Search my courses').fill('Bio');assert.equal(await p.locator('.lx-card').count(),1);
})
test('failed lesson completion keeps the lesson open and retry saves progress',async t=>{
 const p=await open(t,'student',{path:'dashboard/student/courses?course=c&lesson=l',courses:[{id:'c',name:'Course'}],lessons:[{id:'l',title:'Only lesson',body:'Text',is_published:true}]});
 await p.getByRole('heading',{name:'Only lesson'}).waitFor();
 await p.evaluate(()=>{window.fixture.failComplete=true});await p.getByRole('button',{name:'Mark as completed'}).click();await p.getByText('Your progress was not saved',{exact:false}).waitFor();
 await p.evaluate(()=>{window.fixture.failComplete=false});await p.getByRole('button',{name:'Mark as completed'}).click();await p.getByText('Lesson completed. Your progress is saved.').waitFor();
})
test('learning request failure supports retry',async t=>{
 const p=await open(t,'student',{fail:true});await p.getByRole('alert').waitFor();await p.evaluate(()=>window.fixture.fail=false);await p.getByRole('button',{name:'Retry loading'}).click();await p.getByText('No courses assigned yet.',{exact:false}).waitFor();
})
for(const screen of ['questions','patterns','tests'])test(`${screen} authoring lookup loads supported service methods`,async t=>{
 const p=await open(t,screen);const errors=[];p.on('pageerror',e=>errors.push(e.message));
 const label=screen==='questions'?/Create Question/:screen==='patterns'?/Create Pattern/:/^Create Test$/;
 await p.getByRole('button',{name:label}).first().click();await p.locator('option',{hasText:'Practice exam'}).waitFor({state:'attached'});assert.deepEqual(errors,[])
})

test('saved lesson link opens the specific editor; filters find matching courses and lessons',async t=>{
 const p=await open(t,'staff',{path:'?course=course&lesson=lesson',courses:[{id:'course',name:'Foundation'}],lessons:[{id:'lesson',title:'Addition',body:'Saved text',sort_order:0,is_published:false}]});
 await p.getByLabel('Lesson title').waitFor();assert.equal(await p.getByLabel('Lesson title').inputValue(),'Addition');
 await p.getByLabel('Lesson title').fill('Unsaved change');p.once('dialog',dialog=>dialog.dismiss());await p.getByRole('button',{name:'← All courses'}).click();assert.equal(await p.getByLabel('Lesson title').inputValue(),'Unsaved change');
 p.once('dialog',dialog=>dialog.accept());await p.getByRole('button',{name:'Cancel',exact:true}).click();
 await p.getByLabel('Search lessons').fill('no match');await p.getByText('No lessons match these filters.').waitFor();
 await p.getByRole('button',{name:'← All courses'}).click();await p.getByLabel('Search courses').fill('missing');await p.getByText('No courses match your search.').waitFor();
})
test('test search and status compose without hiding the unfiltered empty state',async t=>{
 const p=await open(t,'tests',{tests:[{id:'one',name:'Arithmetic',status:'DRAFT'},{id:'two',name:'English',status:'PUBLISHED'}]});await p.getByLabel('Search tests').fill('Arithmetic');await p.getByRole('heading',{name:'Arithmetic',exact:true}).waitFor();assert.equal(await p.getByRole('heading',{name:'English',exact:true}).count(),0);await p.getByLabel('Test status').selectOption('PUBLISHED');await p.getByText('No tests match your search or status filter.').waitFor();
})
test('draft test resume link opens the builder; published test refuses editing',async t=>{
 const p=await open(t,'tests',{path:'?test=one',tests:[{id:'one',name:'Saved test',is_published:true,status:'PUBLISHED'}]});await p.getByText('This test is already published.',{exact:false}).waitFor();assert.equal(await p.getByRole('button',{name:'Add',exact:true}).count(),0);
})
test('pattern filters combine title and status',async t=>{
 const p=await open(t,'patterns',{patterns:[{id:'one',name:'Arithmetic',status:'DRAFT'},{id:'two',name:'English',status:'ACTIVE'}]});await p.getByLabel('Search patterns').fill('Arithmetic');await p.getByLabel('Pattern status').selectOption('ACTIVE');await p.getByText('No patterns match these filters.').waitFor();
})
test('question resume link opens review of the chosen saved question',async t=>{
 const p=await open(t,'questions',{path:'?question=q',questions:[{id:'q',content:'Review this saved question',status:'DRAFT',difficulty:'EASY',options:[]}]});await p.getByRole('heading',{name:'Review Question'}).waitFor();await p.getByText('Review this saved question',{exact:true}).waitFor();
})
test('question text and difficulty filters combine',async t=>{
 const p=await open(t,'questions',{questions:[{id:'q',content:'Arithmetic practice',status:'DRAFT',difficulty:'EASY'},{id:'r',content:'English practice',status:'DRAFT',difficulty:'HARD'}]});await p.getByPlaceholder('Search questions...').fill('Arithmetic');await p.getByLabel('Difficulty',{exact:true}).selectOption('HARD');assert.equal(await p.getByText('Arithmetic practice',{exact:true}).count(),0);await p.getByLabel('Difficulty',{exact:true}).selectOption('EASY');await p.getByText('Arithmetic practice',{exact:true}).waitFor();
})
test('failed lesson save retains edits; retry saves and reopening restores saved text',async t=>{
 const p=await open(t,'staff',{path:'?course=course&lesson=lesson',failSave:true,courses:[{id:'course',name:'Foundation'}],lessons:[{id:'lesson',title:'Addition',body:'Old text',sort_order:0,is_published:false}]});await p.getByLabel('Lesson text').fill('Updated lesson content');await p.getByRole('button',{name:'Save lesson'}).click();await p.getByText('Save failed',{exact:false}).waitFor();assert.equal(await p.getByLabel('Lesson text').inputValue(),'Updated lesson content');await p.evaluate(()=>window.fixture.failSave=false);await p.getByRole('button',{name:'Save lesson'}).click();await p.getByText('Lesson saved.',{exact:true}).waitFor();await p.getByRole('button',{name:'Edit lesson'}).click();assert.equal(await p.getByLabel('Lesson text').inputValue(),'Updated lesson content');
})




test('student cannot fetch a course outside the enrolled list from a deep link',async t=>{
 const p=await open(t,'student',{path:'dashboard/student/courses?course=outside',courses:[{id:'course',name:'Enrolled course'}],lessons:[{id:'secret',title:'Secret',body:'Hidden content',is_published:true}]});await p.getByText('Course not available',{exact:true}).waitFor();assert.equal(await p.evaluate(()=>(window.lessonRequests||[]).includes('outside')),false);assert.equal(await p.getByText('Hidden content',{exact:true}).count(),0)
})
test('unpublished lesson deep link remains unavailable in the student reader',async t=>{
 const p=await open(t,'student',{path:'dashboard/student/courses?course=course&lesson=draft',courses:[{id:'course',name:'Enrolled course'}],lessons:[{id:'draft',title:'Draft material',body:'Draft private text',is_published:false}]});await p.getByRole('alert').waitFor();assert.equal(await p.getByText('Draft material',{exact:true}).count(),0);assert.equal(await p.getByText('Draft private text',{exact:true}).count(),0);assert.equal(await p.getByRole('button',{name:'Mark as completed'}).count(),0)
})
