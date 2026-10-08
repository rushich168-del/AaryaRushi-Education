import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import fs from 'node:fs'
import { parseAnswerKey, printedContent } from '../src/services/printedPaperContract.js'
import { sharedPassage, addFigure, removeFigure, addedFigures, figureWarnings, dismissFigureWarnings, restoreFigureWarnings } from '../src/services/questionFigures.js'
import { reviewReasons } from '../src/services/printedPaperReview.js'
import { repeatedCopies, sourceCountNote, mergeCopy, deleteQuestion, renumberFrom } from '../src/services/repeatedNumbers.js'
import { formatIssues } from '../src/services/examFormats.js'
let browser, bundle
before(async () => {
  bundle = (await build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import Workspace from './src/components/site/PrintedPaperWorkspace.jsx';import {preparePrintedDocx} from './src/services/printedPaperPreparation.js';window.parseDocx=preparePrintedDocx;window.mount=()=>createRoot(document.getElementById('root')).render(<Workspace/>);`, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic', loader: { '.css': 'empty' }, plugins: [{ name: 'fixtures', setup(b) {
    b.onResolve({ filter: /browserPlatform\.js$/ }, () => ({ path: 'platform', namespace: 'fixture' }))
    b.onLoad({ filter: /platform/, namespace: 'fixture' }, () => ({ contents: `export const createBrowserPlatform=()=>({createCanvas:(w,h)=>{const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;return {canvas,context:canvas.getContext('2d')}},openPdf:async()=>({pdf:{numPages:3,getPage:async()=>({getViewport:({scale})=>({width:300*scale,height:400*scale}),render:({canvasContext})=>{canvasContext.fillStyle='black';canvasContext.fillText('Original question',20,40);return {promise:Promise.resolve()}}})}})});` }))
    b.onResolve({ filter: /printedPaperService\.js$/ }, () => ({ path: 'service', namespace: 'fixture' }))
    b.onLoad({ filter: /service/, namespace: 'fixture' }, () => ({ contents: `export const printedPaperService={list:async()=>[window.paper],load:async()=>({paper:window.paper,questions:window.questions}),save:async(p,m,q)=>{window.saves++;if(window.failSave)throw Error('Connection lost; try again');if(m){window.savedMetadata=m;window.paper.metadata=m}if(q){window.savedQuestions=q;for(const row of q)window.questions[row.position]=row}return {...window.paper,revision:(p?.revision||0)+1}},publish:async()=>{window.publishes++;return 'published-test'}}` }))
    b.onResolve({ filter: /programService\.js$/ }, () => ({ path: 'program', namespace: 'fixture' }))
    b.onLoad({ filter: /program/, namespace: 'fixture' }, () => ({ contents: `export const emptyAcademicContext={exam_id:'',level_id:'',subject_id:'',syllabus_id:'',chapter_id:'',topic_id:''};export const contextFromUrl=()=>emptyAcademicContext;export const programService={catalogue:async()=>({categories:[],exams:[{id:'exam',name:'SI / Constable'}],levels:window.noTracks?[]:[{id:'level',exam_id:'exam',name:'Preliminary'}],subjects:window.noSubjects?[]:[{id:'subject',exam_id:'exam',name:'General paper'}],syllabi:[],chapters:[],topics:[]}),ensurePaperSubject:async()=>{window.subjectSetups=(window.subjectSetups||0)+1;if(window.failSubject)throw Error('Subject setup denied');return 'mixed'},create:async(table,values)=>({id:'mixed',...values})}` }))
  } }] })).outputFiles[0].text
  browser = await chromium.launch()
})
after(async () => browser?.close())

test('flagged question editing, source crop, review invalidation and saved-draft resume', async t => {
  const p=await page(t)
  await p.setViewportSize({width:1440,height:1000})
  const real=JSON.parse(fs.readFileSync('scratch/group2/prepared.json')).questions.slice(0,3)
  await p.evaluate(questions=>{window.questions=questions;window.saves=0;window.publishes=0;window.paper={id:'paper',revision:1,metadata:{name:'Group 2 review',source_type:'PDF',expected_count:3,answer_key_page:3,exam_id:'exam',subject_id:'subject',duration_minutes:60,marks:1,negative_marks:0}};window.mount()},real)
  await p.getByRole('button',{name:'Group 2 review · Draft'}).click()
  await p.getByRole('checkbox').check()
  assert.equal(await p.getByRole('button',{name:'Publish online test'}).isDisabled(),true)
  await p.getByRole('button',{name:'Show review needed',exact:true}).click()
  assert.equal(await p.getByRole('button',{name:'Review question 3',exact:true}).count(),0)
  await p.screenshot({path:'scratch/group2/teacher-review-desktop.png',fullPage:true})
  await p.getByRole('button',{name:'Edit question',exact:true}).click()
  await p.getByRole('button',{name:'Remove block 1'}).click()
  await p.getByRole('button',{name:'Add text block',exact:true}).click()
  await p.getByLabel('Text block 1').fill('Corrected Telugu / English question with four choices')
  await p.getByText('Select a corrected image from PDF',{exact:true}).click()
  await p.getByLabel('Original PDF',{exact:true}).setInputFiles({name:'source.pdf',mimeType:'application/pdf',buffer:Buffer.from('fixture')})
  const img=p.getByRole('img',{name:'Source PDF page 2'})
  await img.waitFor()
  const box=await img.boundingBox()
  await p.mouse.move(box.x+20,box.y+20);await p.mouse.down();await p.mouse.move(box.x+180,box.y+150);await p.mouse.up()
  await p.getByRole('button',{name:'Add selected region'}).click()
  await p.getByRole('button',{name:'Apply question changes'}).click()
  assert.equal(await p.getByRole('checkbox').isChecked(),false)
  await p.getByRole('button',{name:'Mark question checked',exact:true}).click()
  await p.getByRole('button',{name:'B',exact:true}).click()
  await p.getByRole('button',{name:'Mark question checked',exact:true}).waitFor()
  await p.getByRole('button',{name:'Mark question checked',exact:true}).click()
  await p.getByRole('button',{name:/Review question 2/}).click()
  await p.getByRole('button',{name:'Mark question checked',exact:true}).click()
  await p.getByRole('button',{name:'Save draft',exact:true}).click()
  await p.getByText('Draft saved. You can reopen it from Saved papers below.').waitFor()
  const saved=await p.evaluate(()=>window.questions[0])
  assert.equal(saved.reviewConfirmed,true)
  assert.match(saved.content,/Corrected Telugu/)
  assert.match(saved.content,/Teacher-selected source/)
  assert.ok(saved.reviewReasons.length>0)
  await p.getByRole('button',{name:'Choose another paper',exact:true}).click()
  await p.getByRole('button',{name:'Group 2 review · Draft'}).click()
  await p.getByText('Corrected Telugu / English question with four choices',{exact:true}).waitFor()
  assert.equal(await p.getByRole('button',{name:'Question checked',exact:true}).isDisabled(),true)
  await p.getByRole('checkbox').check()
  assert.equal(await p.getByRole('button',{name:'Publish online test'}).isEnabled(),true)
  await p.setViewportSize({width:390,height:844})
  assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
  await p.screenshot({path:'scratch/group2/teacher-review-mobile.png',fullPage:true})
})
async function page(t) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } }); t.after(() => context.close())
  await context.route('**/*', r => r.request().url().startsWith('http://ksc.test/') ? r.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }) : r.abort())
  const p = await context.newPage(); await p.goto('http://ksc.test/dashboard/admin/paper-tests')
  await p.addScriptTag({ content: bundle })
  const css = fs.readdirSync('dist/assets').find(f => f.endsWith('.css')); await p.addStyleTag({ content: fs.readFileSync('dist/assets/' + css, 'utf8') })
  return p
}
test('DSC Word: prepares 100 sequential questions with Unicode Telugu', async t => {
  const p = await page(t)
  const bytes = fs.readFileSync('C:/Users/AARYA RUSHI/Downloads/PDF files/KUTTI   DSC DIVISIONAL  TEST - 1.docx').toString('base64')
  const result = await p.evaluate(async b64 => window.parseDocx(Uint8Array.from(atob(b64), c => c.charCodeAt(0))), bytes)
  assert.equal(result.questions.length, 100)
  assert.deepEqual(result.questions.map(q => q.number), Array.from({ length: 100 }, (_, i) => i + 1))
  assert.match(result.questions[0].content, /కిరణజన్య/)
  assert.ok(result.questions.every(q => q.correct === null))
  assert.deepEqual(result.sections,[{subject:'Biology',count:10},{subject:'Teaching Methodology',count:15},{subject:'Educational Psychology',count:15},{subject:'Geography',count:20},{subject:'Telugu / Language I',count:20},{subject:'Physical Science',count:20}])
  assert.equal(result.questions[10].subject,'Teaching Methodology')
  assert.equal(result.questions[60].subject,'Telugu / Language I')
  assert.doesNotMatch(result.questions[9].content,/ట్రై మెథడ్/)
  assert.equal(result.questions.filter(q => q.warnings.length).length, 0)
  fs.mkdirSync('scratch/printed-paper', { recursive: true }); fs.writeFileSync('scratch/printed-paper/dsc.json', JSON.stringify(result))
  console.log('DSC: 100 questions; missing answer key remains unconfirmed; warnings:', result.questions.filter(q => q.warnings.length).length)
})
test('mobile review, missing answers, failed save/retry and explicit publication', async t => {
  const p = await page(t)
  const real = JSON.parse(fs.readFileSync('scratch/printed-paper/test10.json')).questions.slice(0, 2)
  real.forEach(q=>{q.reviewConfirmed=true})
  real[1].correct = null
  await p.evaluate(q => { window.questions=q;window.saves=0;window.publishes=0;window.paper={id:'paper',revision:1,metadata:{name:'SI Test 10',filename:'test.pdf',source_type:'PDF',expected_count:2,exam_id:'exam',level_id:'level',subject_id:'subject',duration_minutes:60,marks:1,negative_marks:0}};window.mount() }, real)
  await p.getByRole('button', { name: 'SI Test 10 · Draft' }).click()
  await p.getByRole('checkbox').check()
  assert.equal(await p.getByRole('button', { name: 'Publish online test' }).isDisabled(), true)
  await p.getByLabel('Go to question').selectOption({ value: '1' })
  await p.getByRole('heading', { name: 'Question 2', exact: true }).waitFor()
  await p.getByRole('button', { name: 'B', exact: true }).click()
  await p.getByRole('button', { name: 'Mark question checked', exact: true }).click()
  assert.equal(await p.getByRole('checkbox').isChecked(), false)
  await p.evaluate(() => window.failSave=true)
  await p.getByRole('button', { name: 'Save draft', exact: true }).click()
  await p.getByRole('alert').waitFor(); assert.match(await p.getByRole('alert').innerText(), /Connection lost/)
  await p.evaluate(() => window.failSave=false)
  await p.getByRole('checkbox').check()
  assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await p.screenshot({ path: 'scratch/printed-paper/review-mobile.png', fullPage: true })
  await p.getByRole('button', { name: 'Publish online test' }).click()
  await p.getByText('Your online test is published', { exact: true }).waitFor()
  assert.equal(await p.evaluate(() => window.publishes), 1)
})
test('answer-key parser rejects ambiguity and image content rejects active URLs', () => {
  assert.equal(parseAnswerKey('1 A\n2 4', [{ number: 1 }, { number: 2 }])[1].correct, 3)
  assert.throws(() => parseAnswerKey('1 A\n1 B', [{ number: 1 }]))
  assert.throws(() => parseAnswerKey('99 A', [{ number: 1 }]))
  assert.throws(() => printedContent([{ type: 'image', src: 'https://example.com/key' }]))
})

test('draft saves before settings; subject works without a track; publication errors appear at buttons', async t => {
  const p = await page(t)
  const content = printedContent([{type:'text',text:'Question one'}])
  await p.evaluate(content => {
    window.noTracks=true;window.saves=0;window.publishes=0
    window.questions=[{number:1,content,correct:0,options:['A','B','C','D']}]
    window.paper={id:'paper',revision:1,metadata:{name:'Unfinished paper',source_type:'PDF',expected_count:1,duration_minutes:'',marks:1,negative_marks:0}}
    window.mount()
  }, content)
  await p.getByRole('button',{name:'Unfinished paper · Draft'}).click()
  await p.getByRole('button',{name:'Save draft',exact:true}).click()
  await p.getByText('Draft saved. You can reopen it from Saved papers below.').waitFor()
  assert.ok(await p.evaluate(()=>window.saves>0))
  await p.getByLabel('Program',{exact:true}).selectOption('exam')
  assert.equal(await p.getByLabel('Academic subject').isEnabled(),true)
  await p.getByLabel('Academic subject').selectOption('subject')
  await p.getByRole('checkbox').check()
  await p.getByRole('button',{name:'Publish online test',exact:true}).click()
  await p.getByRole('alert').waitFor()
  assert.match(await p.getByRole('alert').innerText(),/duration/)
  assert.equal(await p.evaluate(()=>window.publishes),0)
  const alert = await p.getByRole('alert').boundingBox(), button = await p.getByRole('button',{name:'Publish online test',exact:true}).boundingBox()
  assert.ok(Math.abs(button.y-alert.y)<650)
  await p.getByLabel('Duration (minutes)').fill('60')
  await p.getByRole('checkbox').check()
  await p.getByRole('button',{name:'Publish online test',exact:true}).click()
  await p.getByText('Your online test is published',{exact:true}).waitFor()
})

test('Publish automatically resolves missing subject; failed setup preserves draft and retry succeeds', async t => {
  const p = await page(t)
  await p.evaluate(content => {
    window.noSubjects=true;window.noTracks=true;window.saves=0;window.publishes=0
    window.questions=[{number:1,content,correct:0,options:['A','B','C','D']}]
    window.paper={id:'paper',revision:1,metadata:{name:'Mixed paper',source_type:'PDF',expected_count:1,exam_id:'exam',duration_minutes:60,marks:1,negative_marks:0}}
    window.mount()
  }, printedContent([{type:'text',text:'Question'}]))
  await p.getByRole('button',{name:'Mixed paper · Draft'}).click()
  await p.evaluate(()=>window.failSubject=true)
  await p.getByRole('checkbox').check()
  await p.getByRole('button',{name:'Publish online test',exact:true}).click()
  await p.getByRole('alert').waitFor()
  assert.match(await p.getByRole('alert').innerText(),/Subject setup denied/)
  assert.equal(await p.evaluate(()=>window.publishes),0)
  assert.equal(await p.evaluate(()=>window.saves),0)
  await p.evaluate(()=>window.failSubject=false)

  await p.getByRole('checkbox').check()
  await p.getByRole('button',{name:'Publish online test',exact:true}).click()
  await p.getByText('Your online test is published',{exact:true}).waitFor()
  assert.equal(await p.evaluate(()=>window.savedMetadata.subject_id),'mixed')
  assert.equal(await p.evaluate(()=>window.savedMetadata.exam_id),'exam')
})

// ---- Manual figure tool in the creator review screen --------------------------------------------
const pixel = colour => 'data:image/png;base64,' + Buffer.from(`fixture-${colour}`).toString('base64')
const picture = (colour, alt) => ({ type: 'image', src: pixel(colour), alt })
const figureQuestion = (number, blocks, warnings = []) => ({ number, content: printedContent(blocks), options: ['A', 'B', 'C', 'D'], correct: 0, sourcePages: [2], warnings, reviewConfirmed: false })
const passageBlock = picture('passage', 'Printed source, page 2')
const figureQuestions = () => [
  figureQuestion(1, [passageBlock, picture('one', 'Printed source, page 2')], ['RASTER_PAGE']),
  figureQuestion(2, [passageBlock, picture('two', 'Printed source, page 2')], ['RASTER_PAGE']),
  figureQuestion(3, [picture('three', 'Printed source, page 2')], ['VISUAL_FROM_LAYOUT_GAP_NEEDS_CONFIRMATION', 'NO_TELUGU_REGION']),
]
const RASTER_NOTE = 'This page is a picture in the PDF. Check that the question and any diagram look right.'
const blocksOf = q => JSON.parse(q.content.slice('KSC_PRINTED_V1:'.length)).blocks

test('figure helpers: shared passage, adding to a question or to the passage, removing, and dismissing a figure check', () => {
  const questions = figureQuestions()
  assert.deepEqual(sharedPassage(questions, 0), { from: 0, to: 1, blocks: 1, numbers: [1, 2] })
  assert.deepEqual(sharedPassage(questions, 1), sharedPassage(questions, 0)); assert.equal(sharedPassage(questions, 2), null)
  // To one question: the figure goes after its own content; nothing else changes.
  const own = addFigure(questions, 0, { src: pixel('figure'), page: 2 }, 'question')
  assert.deepEqual(blocksOf(own[0]).map(b => b.src), [pixel('passage'), pixel('one'), pixel('figure')])
  assert.deepEqual(blocksOf(own[0])[2], { type: 'image', src: pixel('figure'), alt: 'Figure added from page 2', added: true })
  assert.equal(own[0].edited, true); assert.equal(own[0].reviewConfirmed, false)
  assert.equal(own[1], questions[1]); assert.equal(own[2], questions[2]); assert.equal(questions[0].edited, undefined)
  // To the shared passage: every linked question gets it, at the end of the passage and before its own content.
  const shared = addFigure(questions, 1, { src: pixel('figure'), page: 2 }, 'passage')
  for (const [i, mine] of [[0, 'one'], [1, 'two']]) { assert.deepEqual(blocksOf(shared[i]).map(b => b.src), [pixel('passage'), pixel('figure'), pixel(mine)]); assert.equal(shared[i].edited, true) }
  assert.equal(shared[2], questions[2]); assert.deepEqual(sharedPassage(shared, 0), { from: 0, to: 1, blocks: 2, numbers: [1, 2] })
  assert.deepEqual(addedFigures(shared, 0), [{ src: pixel('figure'), alt: 'Figure added from page 2', shared: true }]); assert.deepEqual(addedFigures(own, 0), [{ src: pixel('figure'), alt: 'Figure added from page 2', shared: false }])
  assert.deepEqual(addedFigures(questions, 0), [])
  // Removing a passage figure removes it from every linked question; removing a question's figure touches only that question.
  const cleared = removeFigure(shared, 0, pixel('figure'))
  for (const [i, mine] of [[0, 'one'], [1, 'two']]) assert.deepEqual(blocksOf(cleared[i]).map(b => b.src), [pixel('passage'), pixel(mine)])
  assert.deepEqual(blocksOf(removeFigure(own, 0, pixel('figure'))[0]).map(b => b.src), [pixel('passage'), pixel('one')])
  // A question that is not part of a passage cannot take a passage figure.
  assert.throws(() => addFigure(questions, 2, { src: pixel('figure'), page: 2 }, 'passage'), /shared passage/)
  assert.throws(() => addFigure(questions, 0, { src: 'https://example.test/x.png', page: 2 }, 'question'))
  // No figure needed: only the figure checks go, they are recorded, and they can be brought back.
  assert.deepEqual(figureWarnings(questions[2]), ['VISUAL_FROM_LAYOUT_GAP_NEEDS_CONFIRMATION']); assert.deepEqual(figureWarnings(questions[0]), ['RASTER_PAGE'])
  const dismissed = dismissFigureWarnings(questions[2])
  assert.deepEqual(dismissed.warnings, ['NO_TELUGU_REGION']); assert.deepEqual(dismissed.figureDismissed, ['VISUAL_FROM_LAYOUT_GAP_NEEDS_CONFIRMATION'])
  assert.deepEqual(reviewReasons(questions[2]), ['Check the complete diagram or table is visible.']); assert.deepEqual(reviewReasons(dismissed), [])
  assert.deepEqual(restoreFigureWarnings(dismissed).warnings.sort(), [...questions[2].warnings].sort()); assert.equal(restoreFigureWarnings(dismissed).figureDismissed, undefined)
  assert.deepEqual(reviewReasons(questions[0]), [RASTER_NOTE])
})

let creatorBundle
async function creatorReview(t, drafts, width = 1440) {
  creatorBundle ||= (await build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import Workspace from './src/pages/staff/LocalLibraryPreview.jsx';window.mount=()=>createRoot(document.getElementById('root')).render(<Workspace role="creator"/>);`, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic', logLevel: 'error', loader: { '.css': 'empty' }, define: { 'import.meta.url': JSON.stringify('http://127.0.0.1:5173/fixture.js') }, plugins: [{ name: 'fixtures', setup(b) {
    b.onResolve({ filter: /browserPlatform\.js$/ }, () => ({ path: 'platform', namespace: 'fixture' }))
    b.onLoad({ filter: /platform/, namespace: 'fixture' }, () => ({ contents: `export const createBrowserPlatform=()=>({createCanvas:(w,h)=>{const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;return {canvas,context:canvas.getContext('2d')}},openPdf:async()=>({pdf:{numPages:3,getPage:async n=>({getViewport:({scale})=>({width:300*scale,height:400*scale}),render:({canvasContext})=>{canvasContext.fillStyle='white';canvasContext.fillRect(0,0,600,800);canvasContext.fillStyle='black';canvasContext.font='28px sans-serif';canvasContext.fillText('Source page '+n,40,80);canvasContext.strokeRect(120,240,260,220);return {promise:Promise.resolve()}}})}})});` }))
  } }] })).outputFiles[0].text
  const context = await browser.newContext({ viewport: { width, height: 1000 } }); t.after(() => context.close())
  // The workspace needs a secure context (crypto.randomUUID): the fixture page is served as 127.0.0.1. Nothing leaves the test.
  await context.route('**/*', r => r.request().url().startsWith('http://127.0.0.1:5173/') ? r.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div></body></html>' }) : r.abort())
  const p = await context.newPage(), errors = []; p.on('pageerror', e => errors.push(e.message))
  await p.goto('http://127.0.0.1:5173/testcreator/preview')
  const css = fs.readdirSync('dist/assets').find(f => f.endsWith('.css')); await p.addStyleTag({ content: fs.readFileSync('dist/assets/' + css, 'utf8') })
  await p.evaluate(async drafts => { const db = await new Promise((resolve, reject) => { const r = indexedDB.open('ksc-local-library-preview-v1', 1); r.onupgradeneeded = () => r.result.createObjectStore('workspace'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) }); await new Promise((resolve, reject) => { const tx = db.transaction('workspace', 'readwrite'); tx.objectStore('workspace').put({ drafts, ready: [], deliveries: [] }, 'data'); tx.oncomplete = resolve; tx.onerror = reject }); db.close() }, drafts)
  await p.addScriptTag({ content: creatorBundle }); await p.evaluate(() => window.mount())
  await p.getByRole('button', { name: 'My drafts', exact: true }).click()
  await p.getByRole('button', { name: /Fix missing questions|Continue/ }).click()
  await p.locator('.lp-question').waitFor()
  return { p, errors }
}
const figureDraft = () => ({ id: 'figure-draft', title: 'Figure fixture', exam: 'Group II', testFormat: 'subject', targetCount: 3, sections: [{ subject: 'Mixed subjects', count: 3 }], duration: 60, marks: 1, negative: 0, confirmed: false, questions: figureQuestions() })
const goTo = async (p, number) => { await p.getByLabel('Go to question', { exact: true }).selectOption({ label: String(number) }); await p.getByText(`Question ${number}`, { exact: true }).waitFor() }
const shownImages = p => p.locator('.lp-question [aria-label="Original question"] img').evaluateAll(images => images.map(i => i.alt))
const storedDraft = p => p.evaluate(async () => { const db = await new Promise(resolve => { const r = indexedDB.open('ksc-local-library-preview-v1', 1); r.onsuccess = () => resolve(r.result) }); const data = await new Promise(resolve => { const r = db.transaction('workspace').objectStore('workspace').get('data'); r.onsuccess = () => resolve(r.result) }); db.close(); return data.drafts[0] })
async function drawFigure(p, action = 'Add figure') {
  const dialog = p.getByRole('dialog', { name: 'Add figure from page' })
  if (await dialog.getByRole('img', { name: /^Source PDF page/ }).count() === 0) await dialog.getByLabel('Original PDF', { exact: true }).setInputFiles({ name: 'source.pdf', mimeType: 'application/pdf', buffer: Buffer.from('fixture') })
  const img = dialog.getByRole('img', { name: 'Source PDF page 2' }); await img.waitFor(); await img.scrollIntoViewIfNeeded()
  const box = await img.boundingBox()
  await p.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.3); await p.mouse.down(); await p.mouse.move(box.x + box.width * 0.65, box.y + box.height * 0.6); await p.mouse.up()
  await dialog.getByRole('button', { name: action, exact: true }).click()
}

test('Add figure from page attaches a crop to a question and to a shared passage; undo and remove work', async t => {
  const { p, errors } = await creatorReview(t, [figureDraft()])
  await goTo(p, 1)
  await p.locator('.lp-question-issues').getByText(RASTER_NOTE, { exact: true }).waitFor()
  assert.deepEqual(await shownImages(p), ['Printed source, page 2', 'Printed source, page 2'])
  // Cancelling changes nothing.
  await p.getByRole('button', { name: 'Add figure from page', exact: true }).click()
  const dialog = p.getByRole('dialog', { name: 'Add figure from page' }); await dialog.waitFor()
  assert.equal(await dialog.getByRole('radio', { name: 'This question (Q1)' }).isChecked(), true); assert.equal(await dialog.getByRole('radio', { name: 'The shared passage for questions 1–2' }).count(), 1)
  assert.equal(await dialog.getByRole('button', { name: 'Add figure', exact: true }).count(), 0)
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); assert.equal(await dialog.count(), 0); assert.equal((await shownImages(p)).length, 2)
  // To this question.
  await p.getByRole('button', { name: 'Add figure from page', exact: true }).click(); await drawFigure(p)
  await p.getByRole('status').filter({ hasText: 'Figure added to question 1.' }).waitFor(); assert.equal(await dialog.count(), 0)
  assert.deepEqual(await shownImages(p), ['Printed source, page 2', 'Printed source, page 2', 'Figure added from page 2'])
  const natural = await p.locator('.lp-question [aria-label="Original question"] img').last().evaluate(i => new Promise(resolve => { const done = () => resolve([i.naturalWidth, i.naturalHeight]); i.complete ? done() : i.onload = done }))
  assert.ok(natural[0] > 200 && natural[1] > 150, 'the crop is the dragged region at the page resolution')
  // Undo takes it away again.
  await p.getByRole('button', { name: 'Undo', exact: true }).click(); assert.equal((await shownImages(p)).length, 2); assert.equal(await p.getByRole('button', { name: 'Undo', exact: true }).count(), 0)
  // Added again: the other questions are untouched, and it can still be removed after moving away and back.
  await p.getByRole('button', { name: 'Add figure from page', exact: true }).click(); await drawFigure(p); assert.equal((await shownImages(p)).length, 3)
  await goTo(p, 2); assert.equal((await shownImages(p)).length, 2); assert.equal(await p.getByRole('button', { name: /^Remove added figure/ }).count(), 0); await goTo(p, 1)
  await p.getByText('Figure added from page 2.', { exact: true }).waitFor()
  await p.getByRole('button', { name: 'Remove added figure', exact: true }).click(); assert.equal((await shownImages(p)).length, 2)
  // To the shared passage: both linked questions get it, between the passage and their own content.
  await p.getByRole('button', { name: 'Add figure from page', exact: true }).click(); await dialog.getByRole('radio', { name: 'The shared passage for questions 1–2' }).check(); await drawFigure(p)
  await p.getByRole('status').filter({ hasText: 'Figure added to the shared passage for questions 1–2.' }).waitFor()
  assert.deepEqual(await shownImages(p), ['Printed source, page 2', 'Figure added from page 2', 'Printed source, page 2'])
  await goTo(p, 2); assert.deepEqual(await shownImages(p), ['Printed source, page 2', 'Figure added from page 2', 'Printed source, page 2'])
  await goTo(p, 3); assert.equal((await shownImages(p)).length, 1); assert.equal(await p.getByRole('button', { name: /^Remove added figure/ }).count(), 0)
  // The figure survives a saved draft and a reload, and removing it from one question removes it from the passage.
  await p.getByRole('button', { name: 'Save draft', exact: true }).first().click(); await p.getByRole('status').filter({ hasText: 'Draft saved on this device.' }).waitFor()
  const saved = await storedDraft(p)
  assert.deepEqual(saved.questions.map(q => blocksOf(q).length), [3, 3, 1]); assert.deepEqual(saved.questions.map(q => !!q.edited), [true, true, false])
  await goTo(p, 2); await p.getByRole('button', { name: 'Remove added figure from the shared passage', exact: true }).click()
  assert.equal((await shownImages(p)).length, 2); await goTo(p, 1); assert.equal((await shownImages(p)).length, 2)
  for (const width of [1440, 390, 320]) { await p.setViewportSize({ width, height: 900 }); await p.getByRole('button', { name: 'Add figure from page', exact: true }).click(); await dialog.waitFor(); assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'fits at ' + width); const box = await dialog.boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= width + 1); await p.keyboard.press('Escape'); assert.equal(await dialog.count(), 0) }
  assert.deepEqual(errors, [])
})

test('No figure needed dismisses the figure check, is recorded with the draft and can be brought back', async t => {
  const { p, errors } = await creatorReview(t, [figureDraft()])
  await goTo(p, 3)
  await p.locator('.lp-question-issues').getByText('Check the complete diagram or table is visible.', { exact: true }).waitFor()
  await p.getByRole('button', { name: 'No figure needed', exact: true }).click()
  assert.equal(await p.locator('.lp-question-issues').count(), 0); assert.equal(await p.getByRole('button', { name: 'No figure needed', exact: true }).count(), 0)
  await p.getByText('Marked as no figure needed.', { exact: true }).waitFor()
  assert.equal(await p.locator('.lp-issue-list button').count(), 2)
  await p.getByRole('button', { name: 'Save draft', exact: true }).first().click(); await p.getByRole('status').filter({ hasText: 'Draft saved on this device.' }).waitFor()
  const saved = await storedDraft(p)
  assert.deepEqual(saved.questions[2].warnings, ['NO_TELUGU_REGION']); assert.deepEqual(saved.questions[2].figureDismissed, ['VISUAL_FROM_LAYOUT_GAP_NEEDS_CONFIRMATION'])
  // After a reload the check does not come back.
  await p.reload(); const css = fs.readdirSync('dist/assets').find(f => f.endsWith('.css')); await p.addStyleTag({ content: fs.readFileSync('dist/assets/' + css, 'utf8') }); await p.addScriptTag({ content: creatorBundle }); await p.evaluate(() => window.mount())
  await p.getByRole('button', { name: 'My drafts', exact: true }).click(); await p.getByRole('button', { name: /Fix missing questions|Continue/ }).click(); await p.locator('.lp-question').waitFor(); await goTo(p, 3)
  assert.equal(await p.locator('.lp-question-issues').count(), 0); await p.getByText('Marked as no figure needed.', { exact: true }).waitFor()
  // Bringing the check back shows it again; the raster-page note on another question can be dismissed the same way.
  await p.getByRole('button', { name: 'Bring back the figure check', exact: true }).click()
  await p.locator('.lp-question-issues').getByText('Check the complete diagram or table is visible.', { exact: true }).waitFor()
  await goTo(p, 1); await p.locator('.lp-question-issues').getByText(RASTER_NOTE, { exact: true }).waitFor()
  await p.getByRole('button', { name: 'No figure needed', exact: true }).click(); assert.equal(await p.locator('.lp-question-issues').count(), 0)
  assert.deepEqual(errors, [])
})

// ---- Repeated question numbers in the creator review screen -------------------------------------
const repeatQuestions = () => [
  figureQuestion(1, [picture('one', 'Question one')]),
  figureQuestion(2, [picture('two-english', 'Question two, English')]),
  { ...figureQuestion(2, [picture('two-telugu', 'Question two, Telugu')], ['NUMBER_SEQUENCE_GAP(expected 3, got 2)', 'ENGLISH_STEM_MISSING_OR_SHORT']), correct: 0 },
  figureQuestion(3, [picture('three', 'Question three')]),
]
// The creator has already raised the count to match the four questions found, as in the report.
const repeatDraft = (patch = {}) => ({ id: 'repeat-draft', title: 'Repeat fixture', exam: 'Group II', testFormat: 'subject', targetCount: 4, sections: [{ subject: 'Indian History', count: 2 }, { subject: 'Geography', count: 2 }], duration: 60, marks: 1, negative: 0, confirmed: false, expectedCount: 3, answerKeyCount: 3, questions: repeatQuestions(), ...patch })
const KEY_NOTE = 'The answer key has 3 answers but the paper has 4 questions.'
const REPEAT_NOTE = 'Repeated question numbers: 2. Open each one to merge or delete the extra copy.'

test('repeated-number helpers: copies, the count note, merge, delete and renumber with their section plans', () => {
  const paper = repeatDraft()
  assert.deepEqual(repeatedCopies(paper.questions), [{ number: 2, index: 2, first: 1 }]); assert.deepEqual(repeatedCopies(paper.questions.slice(0, 2)), [])
  assert.equal(sourceCountNote(paper), KEY_NOTE); assert.equal(sourceCountNote({ ...paper, answerKeyCount: undefined }), 'The source paper has 3 questions but 4 were found.')
  assert.equal(sourceCountNote({ ...paper, expectedCount: 4 }), ''); assert.equal(sourceCountNote({ ...paper, expectedCount: undefined }), '')
  // Merge: the copy's content follows the first one's, the copy is gone, the first keeps its number and answer.
  const merged = mergeCopy(paper, 2)
  assert.deepEqual(merged.questions.map(q => q.number), [1, 2, 3]); assert.deepEqual(blocksOf(merged.questions[1]).map(b => b.alt), ['Question two, English', 'Question two, Telugu'])
  assert.equal(merged.questions[1].edited, true); assert.equal(merged.questions[1].reviewConfirmed, false); assert.equal(merged.questions[1].correct, 0)
  assert.deepEqual(merged.questions[1].warnings, ['ENGLISH_STEM_MISSING_OR_SHORT']); assert.equal(merged.questions[0], paper.questions[0]); assert.equal(merged.questions[2], paper.questions[3])
  // The plan matched the four questions found: the section that held the copy loses one, and so does a custom count.
  assert.deepEqual(merged.sections, [{ subject: 'Indian History', count: 2 }, { subject: 'Geography', count: 1 }]); assert.equal(merged.targetCount, 3)
  assert.deepEqual(formatIssues({ ...paper, ...merged }), []); assert.equal(sourceCountNote({ ...paper, ...merged }), '')
  assert.equal(paper.questions.length, 4); assert.equal(paper.targetCount, 4)
  assert.throws(() => mergeCopy(paper, 1), /earlier question/)
  // Delete: the same bookkeeping, nothing merged.
  const deleted = deleteQuestion(paper, 2)
  assert.deepEqual(deleted.questions, [paper.questions[0], paper.questions[1], paper.questions[3]]); assert.deepEqual(deleted.sections, merged.sections); assert.equal(deleted.targetCount, 3)
  // A fixed plan that never described the extra copies (Final test, 200 planned, 204 found) is left as it is.
  const fixed = { ...paper, sections: [{ subject: 'Indian History', count: 3 }], targetCount: 3 }
  assert.equal(mergeCopy(fixed, 2).sections, undefined); assert.equal(mergeCopy(fixed, 2).targetCount, undefined)
  // Sections taken from the paper's own subject headings are recounted from the questions.
  const headed = { ...paper, questions: paper.questions.map((q, i) => ({ ...q, subject: i < 2 ? 'Indian History' : 'Geography' })) }
  assert.deepEqual(deleteQuestion(headed, 2).sections, [{ subject: 'Indian History', count: 2 }, { subject: 'Geography', count: 1 }])
  // Renumber: this copy and everything after it move up by one; the paper is now expected to hold one more.
  const renumbered = renumberFrom(paper, 2)
  assert.deepEqual(renumbered.questions.map(q => q.number), [1, 2, 3, 4]); assert.equal(renumbered.expectedCount, 4); assert.equal(renumbered.sections, undefined)
  assert.equal(renumbered.questions[2].edited, true); assert.deepEqual(renumbered.questions[2].warnings, ['ENGLISH_STEM_MISSING_OR_SHORT']); assert.equal(renumbered.questions[3].edited, undefined)
  assert.equal(renumbered.questions[1], paper.questions[1]); assert.deepEqual(repeatedCopies(renumbered.questions), [])
})

const repeatTools = p => p.getByRole('group', { name: 'Question 2 is used twice' })
const blockersText = async p => (await p.getByRole('region', { name: 'Before saving ready' }).innerText()).replace(/\s+/g, ' ')
const questionCount = p => p.getByLabel('Go to question', { exact: true }).locator('option').allInnerTexts()
async function openCopy(p) {
  await p.getByRole('region', { name: 'Before saving ready' }).getByRole('button', { name: 'Open the extra copy of question 2', exact: true }).click()
  await repeatTools(p).waitFor()
  assert.deepEqual(await shownImages(p), ['Question two, Telugu'])
}

test('repeated numbers: actionable blockers with links, and Merge removes the copy and updates the counts', async t => {
  const { p, errors } = await creatorReview(t, [repeatDraft()])
  // The blockers say what is wrong and what to do; the generic lines are gone.
  const before = await blockersText(p)
  assert.ok(before.includes(REPEAT_NOTE), before); assert.ok(before.includes(KEY_NOTE), before)
  assert.doesNotMatch(before, /Resolve the source question count|Source expects|Expected 3 questions; found 4/)
  assert.equal(await p.getByText(KEY_NOTE, { exact: true }).count(), 2)
  // Raising or lowering the count in the format setup does not hide them, and the field says what it must match.
  await p.getByRole('button', { name: 'Edit details', exact: true }).click()
  await p.getByText('The count must match the questions in the paper and the answer key.', { exact: true }).waitFor()
  assert.equal(await p.getByLabel('Target questions').inputValue(), '4')
  for (const count of ['3', '4']) { await p.getByLabel('Target questions').fill(count); const text = await blockersText(p); assert.ok(text.includes(REPEAT_NOTE) && text.includes(KEY_NOTE), `count ${count}: ${text}`) }
  // The link jumps to the extra copy, which carries the tools; the first copy does not.
  await goTo(p, 1); assert.equal(await repeatTools(p).count(), 0)
  await openCopy(p)
  assert.deepEqual(await repeatTools(p).getByRole('button').allInnerTexts(), ['Merge into question 2 (same question in another language)', 'Delete this question', 'Renumber from here…'])
  assert.deepEqual(await questionCount(p), ['1', '2', '2', '3']); await p.getByRole('heading', { name: 'Questions & answers (4)' }).waitFor()
  // Fixture pictures of the tools and the blockers, for visual review.
  fs.mkdirSync('scratch/pdf-duplicates', { recursive: true })
  for (const width of [1440, 390]) { await p.setViewportSize({ width, height: 1000 }); await p.locator('.lp-question').screenshot({ path: `scratch/pdf-duplicates/review-repeated-number-tools-${width}.png` }); await p.locator('.lp-finish').screenshot({ path: `scratch/pdf-duplicates/review-repeated-number-blockers-${width}.png` }) }
  await p.setViewportSize({ width: 1440, height: 1000 })
  // Merge: one question 2 holding both parts, three questions, section plan and count follow.
  await repeatTools(p).getByRole('button', { name: 'Merge into question 2 (same question in another language)', exact: true }).click()
  await p.getByRole('status').filter({ hasText: 'Merged into question 2.' }).waitFor()
  assert.deepEqual(await questionCount(p), ['1', '2', '3']); await p.getByRole('heading', { name: 'Questions & answers (3)' }).waitFor()
  await p.getByText('Question 2', { exact: true }).waitFor(); assert.deepEqual(await shownImages(p), ['Question two, English', 'Question two, Telugu']); assert.equal(await repeatTools(p).count(), 0)
  await p.getByRole('checkbox', { name: 'I checked and resolved this question' }).check()
  await p.getByRole('checkbox', { name: 'I have completed the final paper checks.' }).check()
  assert.equal(await p.getByRole('region', { name: 'Before saving ready' }).count(), 0); assert.equal(await p.getByRole('button', { name: 'Save ready version' }).isEnabled(), true)
  // The details opened earlier are still open: the custom count and the section that held the copy followed.
  assert.equal(await p.getByLabel('Target questions').inputValue(), '3')
  await p.locator('.lp-sections summary').click(); assert.equal(await p.getByLabel('Section 2 questions').inputValue(), '1')
  for (const width of [1440, 390, 320]) { await p.setViewportSize({ width, height: 900 }); assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'fits at ' + width) }
  assert.deepEqual(errors, [])
})

test('repeated numbers: Merge can be undone; Delete asks first and offers Undo; Renumber moves the following numbers up', async t => {
  const { p, errors } = await creatorReview(t, [repeatDraft()])
  // Merge, then Undo.
  await openCopy(p); await repeatTools(p).getByRole('button', { name: /^Merge into question 2/ }).click(); assert.equal((await questionCount(p)).length, 3)
  await p.getByRole('status').filter({ hasText: 'Merged into question 2.' }).getByRole('button', { name: 'Undo', exact: true }).click()
  assert.deepEqual(await questionCount(p), ['1', '2', '2', '3']); assert.ok((await blockersText(p)).includes(REPEAT_NOTE))
  // Delete: cancel keeps it; confirming removes it; Undo brings it back.
  await openCopy(p); await repeatTools(p).getByRole('button', { name: 'Delete this question', exact: true }).click()
  const confirm = p.getByRole('dialog', { name: 'Delete this question?' }); await confirm.waitFor()
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).click(); assert.equal(await confirm.count(), 0); assert.equal((await questionCount(p)).length, 4)
  await repeatTools(p).getByRole('button', { name: 'Delete this question', exact: true }).click(); await confirm.getByRole('button', { name: 'Delete question', exact: true }).click()
  await p.getByRole('status').filter({ hasText: 'Question 2 deleted.' }).waitFor()
  assert.deepEqual(await questionCount(p), ['1', '2', '3']); assert.doesNotMatch(await blockersText(p), /Repeated question numbers|answer key has/)
  await p.getByRole('status').filter({ hasText: 'Question 2 deleted.' }).getByRole('button', { name: 'Undo', exact: true }).click()
  assert.deepEqual(await questionCount(p), ['1', '2', '2', '3'])
  // Renumber from here: the copy becomes 3 and the old 3 becomes 4; the repeat is gone and the paper now expects four.
  await openCopy(p); await repeatTools(p).getByRole('button', { name: 'Renumber from here…', exact: true }).click()
  const renumber = p.getByRole('dialog', { name: 'Renumber from here?' }); await renumber.waitFor()
  await renumber.getByRole('button', { name: 'Renumber', exact: true }).click()
  await p.getByRole('status').filter({ hasText: 'Renumbered from question 3.' }).waitFor()
  assert.deepEqual(await questionCount(p), ['1', '2', '3', '4']); await p.getByText('Question 3', { exact: true }).waitFor(); assert.deepEqual(await shownImages(p), ['Question two, Telugu'])
  await p.getByRole('checkbox', { name: 'I have completed the final paper checks.' }).check()
  const after = await blockersText(p); assert.doesNotMatch(after, /Repeated question numbers|answer key has|Expected \d+ questions/); assert.match(after, /Question 3: This question was edited/)
  await p.getByRole('button', { name: 'Save draft', exact: true }).first().click(); await p.getByRole('status').filter({ hasText: 'Draft saved on this device.' }).waitFor()
  const saved = await storedDraft(p); assert.deepEqual(saved.questions.map(q => q.number), [1, 2, 3, 4]); assert.equal(saved.expectedCount, 4)
  assert.deepEqual(errors, [])
})
