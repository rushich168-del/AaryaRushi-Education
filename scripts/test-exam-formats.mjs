// Exam-format registry (DSC-SGT and Group-II) and the shared format setup in Prepare a paper.
// Fixtures only: papers live in the test browser's own storage and no backend is contacted.
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {chromium} from 'playwright'
import JSZip from 'jszip'
import {build} from 'esbuild'
import {readFile} from 'node:fs/promises'
import {examFormats,examFormat,formatSettings,formatIssues,sectionGroups,marksLocked} from '../src/services/examFormats.js'
import * as dsc from '../src/services/dscTestFormats.js'
import {sourceSubjectHeading,importedSubjectSections} from '../src/services/sourceSubjectHeadings.js'
import {paperIssues,readyVersion} from '../src/services/localExamLibrary.js'
import {matchingShareProgram} from '../src/services/librarySharing.js'

const prompt='Choose a Group-II format to set the section plan. Your questions are kept.'
const label='Based on the APPSC Group-II Screening Test pattern. Check against the current notification; the institute can change sections and negative marks.'
const finalSections=['Indian History','Geography','Indian Society','Current Affairs','Mental Ability'].map(subject=>({subject,count:30}))
const question=(number,extra={})=>({number,content:`Sample question ${number}. Which answer is right?\nA. First\nB. Second\nC. Third\nD. Fourth`,options:['A','B','C','D'],correct:0,reviewConfirmed:false,...extra})
const questions=(n,extra)=>Array.from({length:n},(_,i)=>question(i+1,extra))
const groupPaper=(format,n,patch={})=>({title:'Group-II fixture',exam:'Group II',duration:60,marks:1,negative:0,confirmed:true,...formatSettings('Group II',format),questions:questions(n),...patch})

test('Group-II has exactly two formats and both local and institute names find it',()=>{
 const group=examFormat('Group II')
 assert.deepEqual(group.formats.map(f=>[f.id,f.name,f.hint]),[['subject','Subject test','Custom questions & marks'],['final','Final test','150 questions · 150 marks']])
 assert.equal(examFormat('Group-II'),group);assert.equal(examFormats['Group-II'],group)
 assert.equal(group.title,'Group-II Prelims test format');assert.equal(group.tag,'Group-II · Prelims')
 assert.deepEqual(group.subjectOptions,['Indian History','Geography','Indian Society','Current Affairs','Mental Ability','Mixed subjects'])
 assert.equal(examFormat('Group I'),null);assert.equal(examFormat('Other competitive exams'),null);assert.equal(examFormat(''),null)
})

test('Final test sets 150 questions, 1 mark, 150 minutes, 0.33 negative and five sections of 30, with marks locked',()=>{
 const settings=formatSettings('Group II','final')
 assert.deepEqual(settings,{testFormat:'final',targetCount:150,marks:1,duration:150,negative:0.33,sections:finalSections})
 const p=groupPaper('final',150)
 assert.equal(marksLocked(p),true);assert.deepEqual(formatIssues(p),[]);assert.deepEqual(paperIssues(p),[])
 assert.equal(p.questions.length*p.marks,150)
 assert.deepEqual(sectionGroups(p).map(g=>[g.subject,g.items.length]),finalSections.map(s=>[s.subject,30]))
 assert.match(formatIssues({...p,marks:2}).join(' '),/Final test uses 1 mark per question\./)
 assert.match(formatIssues({...p,questions:p.questions.slice(1)}).join(' '),/This format needs 150 questions; imported 149\./)
 // Duration and negative marks are defaults the institute may change.
 assert.deepEqual(paperIssues({...p,duration:120,negative:0.25}),[])
 assert.equal(examFormat('Group II').formats.find(f=>f.id==='final').label,label)
})

test('Subject test takes a custom question count and editable marks',()=>{
 assert.deepEqual(formatSettings('Group II','subject'),{testFormat:'subject',targetCount:20,marks:1,sections:[{subject:'Indian History',count:20}]})
 assert.deepEqual(formatSettings('Group II'),formatSettings('Group II','subject'))
 const p=groupPaper('subject',37,{targetCount:37,marks:2,sections:[{subject:'Mental Ability',count:37}]})
 assert.equal(marksLocked(p),false);assert.deepEqual(formatIssues(p),[]);assert.deepEqual(paperIssues(p),[])
 for(const targetCount of [0,1001,2.5])assert.match(formatIssues({...p,targetCount}).join(' '),/whole question count from 1 to 1000/)
 assert.match(formatIssues({...p,targetCount:40,sections:[{subject:'Mental Ability',count:40}]}).join(' '),/This format needs 40 questions; imported 37\./)
})

test('a section total that differs from the target blocks the final checks',()=>{
 const p=groupPaper('final',150)
 const short={...p,sections:p.sections.map((s,i)=>i?s:{...s,count:29})}
 assert.match(formatIssues(short).join(' '),/Subject sections must total 150 questions/)
 assert.match(paperIssues(short).join(' '),/Subject sections must total 150 questions/)
 assert.throws(()=>readyVersion(short),/Subject sections must total 150 questions/)
 const moved={...p,questions:p.questions.map((q,i)=>i?q:{...q,subject:'Mental Ability'})}
 assert.match(formatIssues(moved).join(' '),/Question subjects differ from your section counts/)
 assert.match(formatIssues({...p,sections:[...p.sections.slice(0,4),{subject:' ',count:30}]}).join(' '),/Subject sections must total 150/)
})

test('imported subject headings map to the sections of the chosen exam only',()=>{
 for(const [text,subject] of [['Indian History','Indian History'],['  GEOGRAPHY ','Geography'],['Indian Society:','Indian Society'],['Current  Affairs','Current Affairs'],['Mental Ability','Mental Ability']])assert.equal(sourceSubjectHeading(text,'Group II'),subject)
 // Headings of another exam, and question prose, are never taken as a Group-II section.
 for(const text of ['Biology','History','Teaching Methodology','Which of these is about Indian History?'])assert.equal(sourceSubjectHeading(text,'Group II'),null)
 const imported=[...questions(2,{subject:'Indian History'}),question(3,{subject:'Mental Ability'})]
 assert.deepEqual(importedSubjectSections(imported),[{subject:'Indian History',count:2},{subject:'Mental Ability',count:1}])
 assert.equal(importedSubjectSections(questions(2)),null)
 // DSC and unnamed-exam imports read headings exactly as before.
 for(const exam of [undefined,'DSC-SGT']){
  assert.equal(sourceSubjectHeading('Biology',exam),'Biology');assert.equal(sourceSubjectHeading('తెలుగు',exam),'Telugu / Language I');assert.equal(sourceSubjectHeading('History',exam),'History')
  for(const text of ['Current Affairs','Indian History','Mental Ability','Indian Society'])assert.equal(sourceSubjectHeading(text,exam),null)
 }
})

test('a Group-II draft from before formats asks for a format and keeps its questions; finished versions stay as they are',async()=>{
 const old={id:'old',title:'Earlier Group-II paper',exam:'Group II',duration:60,marks:1,negative:0,confirmed:true,questions:questions(3)}
 assert.deepEqual(formatIssues(old),[prompt]);assert.deepEqual(formatIssues({...old,state:'draft'}),[prompt])
 assert.deepEqual(paperIssues(old),[prompt]);assert.throws(()=>readyVersion(old),/Choose a Group-II format/)
 assert.equal(marksLocked(old),false)
 const chosen={...old,...formatSettings('Group II','subject'),targetCount:3,sections:[{subject:'Mixed subjects',count:3}]}
 assert.deepEqual(chosen.questions,old.questions);assert.deepEqual(paperIssues(chosen),[])
 // A version finished before formats existed is frozen: it is not asked for a format and is not changed.
 const ready={...old,state:'ready',version:1},before=JSON.stringify(ready)
 assert.deepEqual(formatIssues(ready),[]);assert.deepEqual(paperIssues(ready),[]);assert.equal(JSON.stringify(ready),before)
 // Other exams have no format setup.
 assert.deepEqual(formatIssues({...old,exam:'Group I'}),[]);assert.equal(marksLocked({...old,exam:'Group I'}),false)
})

test('DSC formats, settings and messages are unchanged and still exported from dscTestFormats',()=>{
 assert.deepEqual(dsc.dscFormats.map(f=>[f.id,f.name,f.hint,f.count,f.marks]),[['subject','Subject wise','Custom questions & marks',20,1],['dt','DT-series','100 questions · 100 marks',100,1],['wt','WT-series','100 questions · 100 marks',100,1],['grand','Grand test','160 questions · 80 marks',160,0.5]])
 assert.equal(dsc.dscSubjects.length,13);assert.equal(examFormat('DSC-SGT').formats,dsc.dscFormats);assert.equal(examFormat('DSC-SGT').subjects,dsc.dscSubjects)
 assert.deepEqual(dsc.formatSettings('subject'),{testFormat:'subject',syllabusReference:'ap',targetCount:20,marks:1,sections:[{subject:'General Knowledge & Current Affairs',count:20}]})
 assert.deepEqual(dsc.formatSettings('dt'),{testFormat:'dt',syllabusReference:'ap',targetCount:100,marks:1,sections:[{subject:'Mixed subjects',count:100}]})
 assert.deepEqual(dsc.formatSettings('grand'),{testFormat:'grand',syllabusReference:'ap',targetCount:160,marks:0.5,sections:[['General Knowledge & Current Affairs',16],['Perspectives in Education',8],['Educational Psychology',16],['Telugu / Language I',24],['English / Language II',24],['Mathematics',24],['Science & EVS',24],['Social Studies',24]].map(([subject,count])=>({subject,count}))})
 for(const id of ['subject','dt','wt','grand'])assert.deepEqual(formatSettings('DSC-SGT',id),dsc.formatSettings(id))
 assert.equal(dsc.sectionGroups,sectionGroups)
 const base={title:'DSC fixture',exam:'DSC-SGT',duration:60,negative:0,confirmed:true}
 const grand={...base,...dsc.formatSettings('grand'),questions:questions(160)}
 assert.deepEqual(dsc.dscFormatIssues(grand),[]);assert.equal(marksLocked(grand),true);assert.equal(marksLocked({...base,...dsc.formatSettings('subject'),questions:[]}),false)
 assert.deepEqual(dsc.dscFormatIssues({...base,marks:1,questions:questions(2)}),['Choose a DSC-SGT test format.'])
 // DSC has no earlier format-less versions: a DSC paper always needs a format.
 assert.deepEqual(dsc.dscFormatIssues({...base,marks:1,state:'ready',questions:questions(2)}),['Choose a DSC-SGT test format.'])
 assert.deepEqual(dsc.dscFormatIssues({...grand,marks:1,syllabusReference:'ts',questions:questions(159),sections:[{subject:'Biology',count:1}]}),[
  'This saved draft uses an older syllabus setup. Choose an AP test format to reset its section plan; questions are preserved.',
  'This format needs 160 questions; imported 159.',
  'Grand test uses 0.5 mark per question.',
  'Subject sections must total 160 questions, with at least one per section.'])
 assert.deepEqual(dsc.dscFormatIssues({...grand,questions:grand.questions.map((q,i)=>i?q:{...q,subject:'Biology'})}),['Question subjects differ from your section counts. Adjust the sections or question subjects before saving.'])
 // dscFormatIssues stays a DSC-only check; formatIssues covers every exam with formats.
 assert.deepEqual(dsc.dscFormatIssues({...base,exam:'Group II',marks:1,questions:questions(2)}),[])
 assert.deepEqual(formatIssues(grand),[])
})

// ---- Prepare a paper, in a browser -------------------------------------------------------------
let fixtureBundle
async function workspace(t,width=1440){
 if(!fixtureBundle)fixtureBundle=(await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import Workspace from './src/pages/staff/LocalLibraryPreview.jsx';createRoot(document.getElementById('root')).render(<Workspace role="creator"/>);`,resolveDir:process.cwd(),loader:'jsx'},bundle:true,write:false,format:'iife',jsx:'automatic',loader:{'.css':'empty'},define:{'import.meta.url':JSON.stringify('http://127.0.0.1:5173/fixture.js')}})).outputFiles[0].text
 const css=await readFile('src/pages/staff/local-library.css','utf8')
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close())
 const context=await browser.newContext({viewport:{width,height:1000}})
 await context.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.fallback():r.abort())
 await context.route('**/fixture.js',r=>r.fulfill({contentType:'text/javascript; charset=utf-8',body:fixtureBundle}))
 await context.route(/\/dashboard\/testcreator(\?.*)?$/,r=>r.fulfill({contentType:'text/html; charset=utf-8',body:`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}h1,h2,p{margin-top:0}${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`}))
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message))
 await page.goto('http://127.0.0.1:5173/dashboard/testcreator');await page.getByRole('heading',{name:'Prepare a paper',exact:true}).waitFor()
 return {page,errors}
}
const storeDrafts=(page,drafts)=>page.evaluate(async drafts=>{const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('ksc-local-library-preview-v1',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});await new Promise((resolve,reject)=>{const tx=db.transaction('workspace','readwrite');tx.objectStore('workspace').put({drafts,ready:[],deliveries:[]},'data');tx.oncomplete=resolve;tx.onerror=reject});db.close()},drafts)
const fits=page=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)
const formats=page=>page.getByRole('group',{name:'Group-II test format'})
const subjectCard=page=>page.getByRole('button',{name:'Subject test Custom questions & marks',exact:true})
const finalCard=page=>page.getByRole('button',{name:'Final test 150 questions · 150 marks',exact:true})
const counter=page=>page.locator('.lp-sections summary span')

test('Group-II setup shows two format cards; Final test fills the Prelims plan and locks marks; Subject test stays custom',async t=>{
 const {page,errors}=await workspace(t)
 assert.equal(await page.getByLabel('Exam collection',{exact:true}).inputValue(),'Group II')
 await page.getByRole('heading',{name:'Group-II Prelims test format',exact:true}).waitFor();await page.getByText('Group-II · Prelims',{exact:true}).waitFor()
 assert.equal(await formats(page).getByRole('button').count(),2)
 // A new paper starts as a Subject test: the creator sets the count, marks stay editable.
 assert.equal(await subjectCard(page).getAttribute('aria-pressed'),'true');assert.equal(await finalCard(page).getAttribute('aria-pressed'),'false')
 assert.equal(await page.getByLabel('Target questions').isEnabled(),true);assert.equal(await page.getByLabel('Marks per question').isEnabled(),true)
 await page.getByLabel('Target questions').fill('35');await page.getByText('35 questions × 1 mark = 35 marks',{exact:true}).waitFor()
 assert.equal(await page.getByLabel('Section 1 subject').inputValue(),'Indian History');assert.equal(await page.getByLabel('Section 1 questions').inputValue(),'35')
 assert.deepEqual(await page.getByLabel('Section 1 subject').locator('option').allInnerTexts(),['Indian History','Geography','Indian Society','Current Affairs','Mental Ability','Mixed subjects'])
 assert.equal(await page.getByText(label,{exact:true}).count(),0)
 await page.getByLabel('Marks per question').fill('2');await page.getByText('35 questions × 2 mark = 70 marks',{exact:true}).waitFor()

 await finalCard(page).click()
 assert.equal(await finalCard(page).getAttribute('aria-pressed'),'true')
 assert.equal(await page.getByLabel('Target questions').inputValue(),'150');assert.equal(await page.getByLabel('Target questions').isEnabled(),false)
 await page.getByText('150 questions × 1 mark = 150 marks',{exact:true}).waitFor()
 assert.equal(await page.getByLabel('Marks per question').inputValue(),'1');assert.equal(await page.getByLabel('Marks per question').isEnabled(),false)
 assert.equal(await page.getByLabel('Duration (minutes)').inputValue(),'150');assert.equal(await page.getByLabel('Duration (minutes)').isEnabled(),true)
 assert.equal(await page.getByLabel('Negative marks').inputValue(),'0.33');assert.equal(await page.getByLabel('Negative marks').isEnabled(),true)
 await page.getByText(label,{exact:true}).waitFor()
 for(const [i,subject] of finalSections.map(s=>s.subject).entries()){assert.equal(await page.getByLabel(`Section ${i+1} subject`).inputValue(),subject);assert.equal(await page.getByLabel(`Section ${i+1} questions`).inputValue(),'30')}
 assert.equal(await page.getByLabel('Section 6 subject').count(),0)

 // The live counter is green only while the sections add up to the target.
 assert.equal(await counter(page).innerText(),'150 / 150 questions');assert.equal(await counter(page).evaluate(el=>getComputedStyle(el).color),'rgb(24, 117, 88)')
 await page.getByLabel('Section 1 questions').fill('29')
 assert.equal(await counter(page).innerText(),'149 / 150 questions');assert.notEqual(await counter(page).evaluate(el=>getComputedStyle(el).color),'rgb(24, 117, 88)')
 await page.getByText('Assign 150 questions across your sections. Current total: 149.',{exact:true}).waitFor()
 await page.getByLabel('Section 1 questions').fill('30');assert.equal(await counter(page).innerText(),'150 / 150 questions')

 // Cards sit side by side on a desktop and stack on phones; nothing leaves the screen.
 const boxes=async()=>Promise.all([subjectCard(page),finalCard(page)].map(card=>card.boundingBox()))
 let [a,b]=await boxes();assert.ok(Math.abs(a.y-b.y)<1&&b.x>a.x+a.width-1,'side by side at 1440');assert.equal(await fits(page),true)
 for(const width of [390,320]){await page.setViewportSize({width,height:844});[a,b]=await boxes();assert.ok(b.y>=a.y+a.height-1&&Math.abs(a.x-b.x)<1,'stacked at '+width);assert.equal(await fits(page),true)}

 // Brand colours come from the shared tokens.
 assert.equal(await finalCard(page).evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(5, 44, 73)')
 // Back to Subject test: custom count again, marks unlocked.
 await subjectCard(page).click();assert.equal(await page.getByLabel('Target questions').isEnabled(),true);assert.equal(await page.getByLabel('Marks per question').isEnabled(),true);assert.equal(await page.getByLabel('Target questions').inputValue(),'20')
 assert.deepEqual(errors,[])
})

test('choosing the exam applies its default format, and exams without formats show no setup',async t=>{
 const {page,errors}=await workspace(t)
 const exam=page.getByLabel('Exam collection',{exact:true})
 await exam.selectOption('Group I');assert.equal(await page.locator('.lp-dsc-setup').count(),0);assert.equal(await page.getByLabel('Marks per question').isEnabled(),true)
 await exam.selectOption('DSC-SGT');await page.getByRole('heading',{name:'DSC-SGT test format',exact:true}).waitFor()
 assert.equal(await page.getByRole('group',{name:'DSC test format'}).getByRole('button').count(),4);assert.equal(await page.getByRole('button',{name:'Subject wise Custom questions & marks',exact:true}).getAttribute('aria-pressed'),'true')
 await page.getByRole('button',{name:'Grand test 160 questions · 80 marks'}).click();assert.equal(await page.getByLabel('Marks per question').inputValue(),'0.5');assert.equal(await page.getByLabel('Marks per question').isEnabled(),false)
 await page.getByText('About the AP syllabus reference',{exact:true}).waitFor()
 await exam.selectOption('Group II');await page.getByRole('heading',{name:'Group-II Prelims test format',exact:true}).waitFor()
 assert.equal(await subjectCard(page).getAttribute('aria-pressed'),'true');assert.equal(await page.getByLabel('Target questions').inputValue(),'20')
 assert.equal(await page.getByLabel('Marks per question').inputValue(),'1');assert.equal(await page.getByLabel('Marks per question').isEnabled(),true);assert.equal(await page.getByText('About the AP syllabus reference',{exact:true}).count(),0)
 assert.deepEqual(errors,[])
})

test('an earlier Group-II draft without a format shows the prompt, keeps its questions and saves once a format is set',async t=>{
 const {page,errors}=await workspace(t)
 const old={id:'old-group-two',title:'Earlier Group-II paper',exam:'Group II',duration:60,marks:1,negative:0,confirmed:false,questions:questions(3)}
 await storeDrafts(page,[old]);await page.reload();await page.getByRole('button',{name:'My drafts',exact:true}).click();await page.getByRole('button',{name:'Continue',exact:true}).click()
 await page.getByText('Question 1',{exact:true}).waitFor();assert.equal(await page.getByLabel('Go to question',{exact:true}).locator('option').count(),3)
 await page.getByRole('checkbox',{name:'I have completed the final paper checks.'}).check()
 assert.match(await page.getByRole('region',{name:'Before saving ready'}).innerText(),new RegExp(prompt.replace(/[.]/g,'\\.')));assert.equal(await page.getByRole('button',{name:'Save ready version'}).isEnabled(),false)
 await page.getByRole('button',{name:'Edit details',exact:true}).click()
 await page.locator('.lp-dsc-setup').getByText(prompt,{exact:true}).waitFor()
 assert.equal(await subjectCard(page).getAttribute('aria-pressed'),'false');assert.equal(await finalCard(page).getAttribute('aria-pressed'),'false')
 assert.equal(await page.getByLabel('Target questions').count(),0);assert.equal(await page.getByLabel('Marks per question').isEnabled(),true);assert.equal(await page.getByLabel('Duration (minutes)').inputValue(),'60')
 await subjectCard(page).click();assert.equal(await page.locator('.lp-dsc-setup').getByText(prompt,{exact:true}).count(),0)
 // Sections stay closed while questions exist; the counter shows what is still to assign.
 assert.equal(await page.locator('.lp-sections').evaluate(el=>el.open),false);assert.equal(await counter(page).innerText(),'20 / 20 questions')
 await page.locator('p.lp-error').getByText('This format needs 20 questions; imported 3.',{exact:true}).waitFor()
 await page.getByLabel('Target questions').fill('3');assert.equal(await counter(page).innerText(),'3 / 3 questions')
 // A section total that differs from the target blocks the final checks.
 await page.locator('.lp-sections summary').click();await page.getByLabel('Section 1 questions').fill('2')
 await page.getByRole('checkbox',{name:'I have completed the final paper checks.'}).check()
 assert.match(await page.getByRole('region',{name:'Before saving ready'}).innerText(),/Subject sections must total 3 questions/);assert.equal(await page.getByRole('button',{name:'Save ready version'}).isEnabled(),false)
 await page.getByLabel('Section 1 questions').fill('3');await page.getByRole('checkbox',{name:'I have completed the final paper checks.'}).check()
 assert.equal(await page.getByRole('region',{name:'Before saving ready'}).count(),0)
 // Every question is still there, unchanged, under the chosen subject.
 assert.equal(await page.getByLabel('Go to question',{exact:true}).locator('option').count(),3);assert.match(await page.locator('.lp-question').innerText(),/Sample question 1\. Which answer is right\?/)
 assert.equal(await page.getByLabel('Question 1 subject').inputValue(),'Indian History');assert.equal(await page.getByLabel('Duration (minutes)').inputValue(),'60')
 await page.getByRole('button',{name:'Save ready version'}).click();await page.getByRole('status').filter({hasText:'Earlier Group-II paper saved as v1 on this device.'}).waitFor()
 const saved=await page.evaluate(async()=>{const db=await new Promise(resolve=>{const r=indexedDB.open('ksc-local-library-preview-v1',1);r.onsuccess=()=>resolve(r.result)});const data=await new Promise(resolve=>{const r=db.transaction('workspace').objectStore('workspace').get('data');r.onsuccess=()=>resolve(r.result)});db.close();return data})
 assert.equal(saved.ready.length,1);assert.equal(saved.ready[0].testFormat,'subject');assert.deepEqual(saved.ready[0].questions.map(q=>[q.number,q.content,q.correct]),old.questions.map(q=>[q.number,q.content,q.correct]))
 assert.deepEqual(errors,[])
})

test('subject headings in an imported Group-II Word paper become the section plan',async t=>{
 const para=(text,bold)=>`<w:p><w:r>${bold?'<w:rPr><w:b/></w:rPr>':''}<w:t>${text}</w:t></w:r></w:p>`
 const body=['Indian History',[1,2],'Mental Ability',[3]].map(part=>typeof part==='string'?para(part,true):part.map(n=>para(`${n}. Which choice is correct for question ${n}?`,true)+para('A. First B. Second C. Third D. Fourth')).join('')).join('')
 const zip=new JSZip();zip.file('word/document.xml',`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`)
 const buffer=await zip.generateAsync({type:'nodebuffer'})
 const {page,errors}=await workspace(t)
 await page.getByLabel('Target questions').fill('3')
 await page.getByLabel('Source paper').setInputFiles({name:'group-two-sections.docx',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',buffer});await page.getByRole('button',{name:'Prepare paper',exact:true}).click();await page.getByText('Question 1',{exact:true}).waitFor()
 assert.deepEqual(await page.locator('.lp-navigator-groups section').evaluateAll(sections=>sections.map(s=>[s.querySelector('h3').textContent,s.querySelectorAll('button').length])),[['Indian History',2],['Mental Ability',1]])
 await page.getByRole('button',{name:'Edit details',exact:true}).click()
 assert.equal(await counter(page).innerText(),'3 / 3 questions')
 await page.locator('.lp-sections summary').click()
 assert.equal(await page.getByLabel('Section 1 subject').inputValue(),'Indian History');assert.equal(await page.getByLabel('Section 1 questions').inputValue(),'2')
 assert.equal(await page.getByLabel('Section 2 subject').inputValue(),'Mental Ability');assert.equal(await page.getByLabel('Section 2 questions').inputValue(),'1')
 assert.equal(await page.getByText(/Question subjects differ|Subject sections must total/).count(),0)
 for(const width of [1440,390,320]){await page.setViewportSize({width,height:900});assert.equal(await fits(page),true)}
 assert.deepEqual(errors,[])
})

// ---- SI & Constable ---------------------------------------------------------------------------
const police='SI & Constable'
const policePrompt='Choose an SI & Constable format to set the section plan. Your questions are kept.'
const policeLabel='KSC starting split, informed by the AP police (APSLPRB) preliminary test pattern. Check against the current notification; the institute can change sections, time and negative marks.'
const policeSubjects=['Arithmetic','Reasoning & Mental Ability','General Science','Indian History & National Movement','Geography','Indian Polity','Indian Economy','Current Affairs','English']
const policeSections=[['Arithmetic',50],['Reasoning & Mental Ability',50],['General Science',20],['Indian History & National Movement',20],['Geography',15],['Indian Polity',15],['Indian Economy',10],['Current Affairs',20]].map(([subject,count])=>({subject,count}))
const policePaper=(format,n,patch={})=>({title:'SI & Constable fixture',exam:police,duration:60,marks:1,negative:0,confirmed:true,...formatSettings(police,format),questions:questions(n),...patch})

test('SI & Constable has exactly two formats, and sharing finds the institute program of the same name',()=>{
 const entry=examFormat(police)
 assert.equal(examFormats[police],entry);assert.deepEqual(Object.keys(examFormats),['DSC-SGT','Group-II','SI & Constable'])
 assert.deepEqual(entry.formats.map(f=>[f.id,f.name,f.hint]),[['subject','Subject test','Custom questions & marks'],['final','Final test','200 questions · 200 marks']])
 assert.equal(entry.title,'SI & Constable test format');assert.equal(entry.tag,'Andhra Pradesh · Police (SI & Constable)')
 assert.deepEqual(entry.subjects,policeSubjects);assert.deepEqual(entry.subjectOptions,[...policeSubjects,'Mixed subjects'])
 // The local collection and the institute program carry the same name; sharing picks that program only.
 const programs=[{id:'group',name:'Group-II'},{id:'dsc',name:'DSC'},{id:'police',name:'SI & Constable'}]
 assert.equal(matchingShareProgram({exam:police},programs),'police')
 assert.equal(matchingShareProgram({exam:police,...formatSettings(police,'final')},programs),'police')
 assert.equal(matchingShareProgram({exam:police},programs.slice(0,2)),'')
 assert.equal(matchingShareProgram({exam:'Group II'},programs),'group');assert.equal(matchingShareProgram({exam:'DSC-SGT'},programs),'dsc')
})

test('SI & Constable Final test sets 200 questions, 1 mark, 180 minutes, no negative marks and eight sections, with marks locked',()=>{
 assert.deepEqual(formatSettings(police,'final'),{testFormat:'final',targetCount:200,marks:1,duration:180,negative:0,sections:policeSections})
 assert.equal(policeSections.length,8);assert.equal(policeSections.reduce((n,s)=>n+s.count,0),200)
 const p=policePaper('final',200)
 assert.equal(marksLocked(p),true);assert.deepEqual(formatIssues(p),[]);assert.deepEqual(paperIssues(p),[]);assert.equal(p.questions.length*p.marks,200)
 assert.deepEqual(sectionGroups(p).map(g=>[g.subject,g.items.length]),policeSections.map(s=>[s.subject,s.count]))
 assert.match(formatIssues({...p,marks:2}).join(' '),/Final test uses 1 mark per question\./)
 assert.match(formatIssues({...p,questions:p.questions.slice(1)}).join(' '),/This format needs 200 questions; imported 199\./)
 // Time and negative marks are defaults the institute may change.
 assert.deepEqual(paperIssues({...p,duration:120,negative:0.25}),[])
 assert.equal(examFormat(police).formats.find(f=>f.id==='final').label,policeLabel)
})

test('SI & Constable Subject test takes a custom count up to 500; other exams keep their own limit',()=>{
 assert.deepEqual(formatSettings(police,'subject'),{testFormat:'subject',targetCount:20,marks:1,sections:[{subject:'Arithmetic',count:20}]})
 assert.deepEqual(formatSettings(police),formatSettings(police,'subject'))
 const sized=n=>policePaper('subject',n,{targetCount:n,marks:2,sections:[{subject:'Reasoning & Mental Ability',count:n}]})
 assert.equal(marksLocked(sized(37)),false);assert.deepEqual(paperIssues(sized(37)),[]);assert.deepEqual(formatIssues(sized(500)),[])
 assert.deepEqual(formatIssues(sized(501)),['Set a whole question count from 1 to 500.'])
 for(const targetCount of [0,2.5,1000])assert.match(formatIssues({...sized(37),targetCount}).join(' '),/whole question count from 1 to 500\./)
 // Group-II and DSC subject tests still accept up to 1000.
 for(const exam of ['Group II','DSC-SGT']){
  const other=n=>({title:'Fixture',exam,duration:60,negative:0,confirmed:true,...formatSettings(exam,'subject'),targetCount:n,sections:[{subject:'Mixed subjects',count:n}],questions:questions(n)})
  assert.deepEqual(formatIssues(other(1000)),[]);assert.match(formatIssues(other(1001)).join(' '),/whole question count from 1 to 1000\./)
 }
})

test('an SI & Constable section total that differs from the target blocks the final checks',()=>{
 const p=policePaper('final',200)
 const short={...p,sections:p.sections.map((s,i)=>i?s:{...s,count:49})}
 assert.match(formatIssues(short).join(' '),/Subject sections must total 200 questions/);assert.match(paperIssues(short).join(' '),/Subject sections must total 200 questions/)
 assert.throws(()=>readyVersion(short),/Subject sections must total 200 questions/)
 const moved={...p,questions:p.questions.map((q,i)=>i?q:{...q,subject:'English'})}
 assert.match(formatIssues(moved).join(' '),/Question subjects differ from your section counts/)
})

test('SI & Constable headings map to its sections; other exams read headings as before',()=>{
 for(const subject of policeSubjects)for(const text of [subject,'  '+subject.toUpperCase()+' :'.trim(),subject+':'])assert.equal(sourceSubjectHeading(text,police),subject,text)
 assert.equal(sourceSubjectHeading('Reasoning and Mental Ability',police),'Reasoning & Mental Ability');assert.equal(sourceSubjectHeading('Indian History and National Movement',police),'Indian History & National Movement')
 assert.equal(sourceSubjectHeading('భూగోళ శాస్త్రం',police),'Geography')
 // Headings of other exams, shortened names and question prose are not taken as a section.
 for(const text of ['Biology','Mathematics','Telugu','History','Indian Society','Mental Ability','Reasoning','Polity','Which of these is Arithmetic?'])assert.equal(sourceSubjectHeading(text,police),null,text)
 const imported=[...questions(2,{subject:'Arithmetic'}),question(3,{subject:'English'})]
 assert.deepEqual(importedSubjectSections(imported),[{subject:'Arithmetic',count:2},{subject:'English',count:1}])
 // DSC, Group-II and unnamed-exam imports are unchanged.
 assert.equal(sourceSubjectHeading('English','DSC-SGT'),'English / Language II');assert.equal(sourceSubjectHeading('English'),'English / Language II');assert.equal(sourceSubjectHeading('English','Group II'),null)
 for(const exam of [undefined,'DSC-SGT','Group II'])for(const text of ['Arithmetic','Indian Polity','Indian Economy','General Science','Reasoning & Mental Ability'])assert.equal(sourceSubjectHeading(text,exam),null,text)
 assert.equal(sourceSubjectHeading('Current Affairs','Group II'),'Current Affairs');assert.equal(sourceSubjectHeading('Current Affairs','DSC-SGT'),null)
})

test('an SI & Constable draft from before formats asks for a format and keeps its questions; finished versions stay as they are',()=>{
 const old={id:'old-police',title:'Earlier SI & Constable paper',exam:police,duration:90,marks:1,negative:0,confirmed:true,questions:questions(3)}
 assert.deepEqual(formatIssues(old),[policePrompt]);assert.deepEqual(paperIssues({...old,state:'draft'}),[policePrompt]);assert.throws(()=>readyVersion(old),/Choose an SI & Constable format/)
 assert.equal(marksLocked(old),false)
 const chosen={...old,...formatSettings(police,'subject'),targetCount:3,sections:[{subject:'Mixed subjects',count:3}]}
 assert.deepEqual(chosen.questions,old.questions);assert.equal(chosen.duration,90);assert.deepEqual(paperIssues(chosen),[])
 // A finished version, or a ready save that was interrupted, is not asked for a format and is not changed.
 const ready={...old,state:'ready',version:1},before=JSON.stringify(ready)
 assert.deepEqual(paperIssues(ready),[]);assert.equal(JSON.stringify(ready),before)
 assert.deepEqual(formatIssues({...old,readyOperation:{signature:'pending'}}),[])
})

const policeFormats=page=>page.getByRole('group',{name:'SI & Constable test format'})
const policeFinalCard=page=>page.getByRole('button',{name:'Final test 200 questions · 200 marks',exact:true})
const choosePolice=async page=>{await page.getByLabel('Exam collection',{exact:true}).selectOption(police);await page.getByRole('heading',{name:'SI & Constable test format',exact:true}).waitFor()}

test('SI & Constable setup shows two format cards; Final test fills the 200-question plan and locks marks; Subject test stays custom up to 500',async t=>{
 const {page,errors}=await workspace(t)
 await choosePolice(page);await page.getByText('Andhra Pradesh · Police (SI & Constable)',{exact:true}).waitFor()
 assert.equal(await policeFormats(page).getByRole('button').count(),2)
 // Choosing the collection applies the Subject test: custom count up to 500, marks editable.
 assert.equal(await subjectCard(page).getAttribute('aria-pressed'),'true');assert.equal(await policeFinalCard(page).getAttribute('aria-pressed'),'false')
 assert.equal(await page.getByLabel('Target questions').inputValue(),'20');assert.equal(await page.getByLabel('Target questions').getAttribute('max'),'500')
 assert.equal(await page.getByLabel('Marks per question').isEnabled(),true);assert.equal(await page.getByLabel('Section 1 subject').inputValue(),'Arithmetic')
 assert.deepEqual(await page.getByLabel('Section 1 subject').locator('option').allInnerTexts(),[...policeSubjects,'Mixed subjects'])
 await page.getByLabel('Target questions').fill('40');await page.getByText('40 questions × 1 mark = 40 marks',{exact:true}).waitFor();assert.equal(await page.getByLabel('Section 1 questions').inputValue(),'40')
 assert.equal(await page.getByText(policeLabel,{exact:true}).count(),0)

 await policeFinalCard(page).click()
 assert.equal(await policeFinalCard(page).getAttribute('aria-pressed'),'true')
 assert.equal(await page.getByLabel('Target questions').inputValue(),'200');assert.equal(await page.getByLabel('Target questions').isEnabled(),false)
 await page.getByText('200 questions × 1 mark = 200 marks',{exact:true}).waitFor()
 assert.equal(await page.getByLabel('Marks per question').inputValue(),'1');assert.equal(await page.getByLabel('Marks per question').isEnabled(),false)
 assert.equal(await page.getByLabel('Duration (minutes)').inputValue(),'180');assert.equal(await page.getByLabel('Duration (minutes)').isEnabled(),true)
 assert.equal(await page.getByLabel('Negative marks').inputValue(),'0');assert.equal(await page.getByLabel('Negative marks').isEnabled(),true)
 await page.getByText(policeLabel,{exact:true}).waitFor()
 for(const [i,s] of policeSections.entries()){assert.equal(await page.getByLabel(`Section ${i+1} subject`).inputValue(),s.subject);assert.equal(await page.getByLabel(`Section ${i+1} questions`).inputValue(),String(s.count))}
 assert.equal(await page.getByLabel('Section 9 subject').count(),0)
 assert.equal(await counter(page).innerText(),'200 / 200 questions');assert.equal(await counter(page).evaluate(el=>getComputedStyle(el).color),'rgb(24, 117, 88)')
 await page.getByLabel('Section 8 questions').fill('15');assert.equal(await counter(page).innerText(),'195 / 200 questions')
 await page.getByText('Assign 200 questions across your sections. Current total: 195.',{exact:true}).waitFor()
 await page.getByLabel('Section 8 questions').fill('20')

 const boxes=async()=>Promise.all([subjectCard(page),policeFinalCard(page)].map(card=>card.boundingBox()))
 let [a,b]=await boxes();assert.ok(Math.abs(a.y-b.y)<1&&b.x>a.x+a.width-1,'side by side at 1440');assert.equal(await fits(page),true)
 for(const width of [390,320]){await page.setViewportSize({width,height:844});[a,b]=await boxes();assert.ok(b.y>=a.y+a.height-1&&Math.abs(a.x-b.x)<1,'stacked at '+width);assert.equal(await fits(page),true)}
 // Going back to Group II or DSC shows their own setup, unchanged.
 await page.getByLabel('Exam collection',{exact:true}).selectOption('Group II');assert.equal(await formats(page).getByRole('button').count(),2);assert.equal(await page.getByLabel('Target questions').getAttribute('max'),'1000');assert.equal(await page.getByLabel('Section 1 subject').inputValue(),'Indian History')
 await page.getByLabel('Exam collection',{exact:true}).selectOption('DSC-SGT');assert.equal(await page.getByRole('group',{name:'DSC test format'}).getByRole('button').count(),4);assert.equal(await page.getByLabel('Target questions').getAttribute('max'),'1000')
 assert.deepEqual(errors,[])
})

test('an earlier SI & Constable draft without a format shows the prompt, keeps its questions and saves once a format is set',async t=>{
 const {page,errors}=await workspace(t)
 const old={id:'old-police',title:'Earlier SI & Constable paper',exam:police,duration:90,marks:1,negative:0,confirmed:false,questions:questions(3)}
 await storeDrafts(page,[old]);await page.reload();await page.getByRole('button',{name:'My drafts',exact:true}).click();await page.getByRole('button',{name:'Continue',exact:true}).click()
 await page.getByText('Question 1',{exact:true}).waitFor()
 await page.getByRole('checkbox',{name:'I have completed the final paper checks.'}).check()
 assert.ok((await page.getByRole('region',{name:'Before saving ready'}).innerText()).includes(policePrompt));assert.equal(await page.getByRole('button',{name:'Save ready version'}).isEnabled(),false)
 await page.getByRole('button',{name:'Edit details',exact:true}).click();await page.locator('.lp-dsc-setup').getByText(policePrompt,{exact:true}).waitFor()
 assert.equal(await page.getByLabel('Target questions').count(),0);assert.equal(await page.getByLabel('Marks per question').isEnabled(),true)
 await subjectCard(page).click();assert.equal(await page.locator('.lp-dsc-setup').getByText(policePrompt,{exact:true}).count(),0)
 await page.getByLabel('Target questions').fill('3');assert.equal(await counter(page).innerText(),'3 / 3 questions')
 // A section total that differs from the target blocks the final checks.
 await page.locator('.lp-sections summary').click();await page.getByLabel('Section 1 questions').fill('2');await page.getByRole('checkbox',{name:'I have completed the final paper checks.'}).check()
 assert.match(await page.getByRole('region',{name:'Before saving ready'}).innerText(),/Subject sections must total 3 questions/);assert.equal(await page.getByRole('button',{name:'Save ready version'}).isEnabled(),false)
 await page.getByLabel('Section 1 questions').fill('3');await page.getByRole('checkbox',{name:'I have completed the final paper checks.'}).check();assert.equal(await page.getByRole('region',{name:'Before saving ready'}).count(),0)
 assert.equal(await page.getByLabel('Go to question',{exact:true}).locator('option').count(),3);assert.equal(await page.getByLabel('Question 1 subject').inputValue(),'Arithmetic');assert.equal(await page.getByLabel('Duration (minutes)').inputValue(),'90')
 await page.getByRole('button',{name:'Save ready version'}).click();await page.getByRole('status').filter({hasText:'Earlier SI & Constable paper saved as v1 on this device.'}).waitFor()
 const saved=await page.evaluate(async()=>{const db=await new Promise(resolve=>{const r=indexedDB.open('ksc-local-library-preview-v1',1);r.onsuccess=()=>resolve(r.result)});const data=await new Promise(resolve=>{const r=db.transaction('workspace').objectStore('workspace').get('data');r.onsuccess=()=>resolve(r.result)});db.close();return data})
 assert.equal(saved.ready.length,1);assert.equal(saved.ready[0].exam,police);assert.equal(saved.ready[0].testFormat,'subject');assert.deepEqual(saved.ready[0].questions.map(q=>[q.number,q.content,q.correct]),old.questions.map(q=>[q.number,q.content,q.correct]))
 assert.deepEqual(errors,[])
})

test('subject headings in an imported SI & Constable Word paper become the section plan',async t=>{
 const para=(text,bold)=>`<w:p><w:r>${bold?'<w:rPr><w:b/></w:rPr>':''}<w:t>${text}</w:t></w:r></w:p>`
 const body=['Arithmetic',[1,2],'Reasoning &amp; Mental Ability',[3],'English',[4]].map(part=>typeof part==='string'?para(part,true):part.map(n=>para(`${n}. Which choice is correct for question ${n}?`,true)+para('A. First B. Second C. Third D. Fourth')).join('')).join('')
 const zip=new JSZip();zip.file('word/document.xml',`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`)
 const buffer=await zip.generateAsync({type:'nodebuffer'})
 const {page,errors}=await workspace(t)
 await choosePolice(page);await page.getByLabel('Target questions').fill('4')
 await page.getByLabel('Source paper').setInputFiles({name:'police-sections.docx',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',buffer});await page.getByRole('button',{name:'Prepare paper',exact:true}).click();await page.getByText('Question 1',{exact:true}).waitFor()
 assert.deepEqual(await page.locator('.lp-navigator-groups section').evaluateAll(sections=>sections.map(s=>[s.querySelector('h3').textContent,s.querySelectorAll('button').length])),[['Arithmetic',2],['Reasoning & Mental Ability',1],['English',1]])
 await page.getByRole('button',{name:'Edit details',exact:true}).click();assert.equal(await counter(page).innerText(),'4 / 4 questions')
 await page.locator('.lp-sections summary').click()
 for(const [i,[subject,count]] of [['Arithmetic','2'],['Reasoning & Mental Ability','1'],['English','1']].entries()){assert.equal(await page.getByLabel(`Section ${i+1} subject`).inputValue(),subject);assert.equal(await page.getByLabel(`Section ${i+1} questions`).inputValue(),count)}
 assert.equal(await page.getByText(/Question subjects differ|Subject sections must total/).count(),0)
 for(const width of [1440,390,320]){await page.setViewportSize({width,height:900});assert.equal(await fits(page),true)}
 assert.deepEqual(errors,[])
})
