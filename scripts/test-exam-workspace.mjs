import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import fs from 'node:fs'

// Real workspace, isolated in-memory service. No env, credentials or live database.
let browser, bundle
before(async () => {
  const result = await build({
    stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
      import Workspace from './src/pages/student/ExamWorkspace.jsx';
      const root=createRoot(document.getElementById('root'));
      let generation=0;
      window.mount=()=>root.render(React.createElement(Workspace,{testId:'test-a',key:++generation}));`,
    resolveDir: process.cwd(), loader: 'jsx' },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    plugins: [{ name: 'local-workspace-fixture', setup(b) {
      b.onResolve({ filter: /studentExamService\.js$/ }, () => ({ path: 'service', namespace: 'fixture' }))
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ loader: 'js', contents: `
        export const studentExamService={
          getMyAttempts:async()=>{
            window.loadCalls=(window.loadCalls||0)+1;
            if(window.fixture.failLoad) throw Error('Connection unavailable');
            return [{id:'attempt-a',test_id:'test-a',status:'IN_PROGRESS',
              expires_at:window.fixture.expiresAt||(window.fixture.expired?new Date(Date.now()-1000).toISOString():null),tests:{name:window.fixture.name||'Fixture test'}}]
          },
          getAttemptQuestions:async()=>window.fixture.questions||[{question_id:'q1',content:'Choose a letter',marks:1,negative_marks:0,exam_pattern_sections:{section_name:'Fixture section'}}],
          getAttemptOptions:async()=>window.fixture.options||[{id:'a',question_id:'q1',content:'Option Alpha'},{id:'b',question_id:'q1',content:'Option Beta'}],
          getMyAnswers:async()=>Object.entries(window.stored).map(([question_id,answer])=>({question_id,...answer})),
          saveAnswer:async(id,qId,option,marked,clear)=>{
            window.calls.push({kind:'save',option,marked,clear});
            const complete=()=>{
              if(window.fixture.failSave) throw Error('Offline');
              window.stored[qId]={selected_option_id:clear?null:option,is_marked_for_review:marked};
            };
            if(window.fixture.holdSave) await new Promise((resolve,reject)=>window.releaseSave=()=>{try{complete();resolve()}catch(e){reject(e)}});
            else complete();
          },
          submitAttempt:async()=>{window.calls.push({kind:'submit'});if(window.fixture.failSubmit)throw Error('Connection unavailable')}
        };
      ` }))
    }}]
  })
  bundle = result.outputFiles[0].text
  browser = await chromium.launch({ headless: true })
})
after(async () => browser?.close())

async function open(t, fixture = {}) {
  const context = await browser.newContext()
  t.after(() => context.close())
  await context.route('**/*', route => route.request().url() === 'http://ksc-fixture.test/test/test-a/attempt'
    ? route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }) : route.abort())
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  t.after(() => assert.deepEqual(errors, []))
  await page.goto('http://ksc-fixture.test/test/test-a/attempt')
  await page.evaluate(fixture => { window.fixture = fixture; window.calls = []; window.stored = {} }, fixture)
  await page.addScriptTag({ content: bundle })
  await page.evaluate(() => window.mount())
  await page.waitForFunction(() => !document.body.innerText.includes('Loading Exam Engine'))
  return page
}

test('printed Test 10 question appears in student exam on mobile with answer controls', { skip: !fs.existsSync('scratch/printed-paper/test10.json') && 'Run check-printed-test10.mjs to generate the source fixture' }, async t => {
  const source = JSON.parse(fs.readFileSync('scratch/printed-paper/test10.json')).questions
  const page = await open(t, { name: 'SI / Constable Test 10', expiresAt: new Date(Date.now()+3600000).toISOString(),
    questions: source.map(q => ({ question_id: 'q'+q.number, content: q.content, marks: 1, negative_marks: 0, exam_pattern_sections: { section_name: 'SI / Constable Test 10' } })),
    options: source.flatMap(q=>q.options.map((label,i)=>({id:'q'+q.number+'-'+i,question_id:'q'+q.number,content:label}))) })
  await page.setViewportSize({ width: 390, height: 844 })
  const css = fs.readdirSync('dist/assets').find(f => f.endsWith('.css'))
  await page.addStyleTag({ content: fs.readFileSync('dist/assets/' + css, 'utf8') })
  await page.getByRole('img', { name: /Printed source/ }).first().waitFor()
  for (let i=0;i<5;i++) await page.getByRole('button',{name:'Save & Next',exact:true}).click()
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.getByRole('button', { name: 'Option A', exact: true }).click()
  await page.waitForFunction(() => window.stored.q6?.selected_option_id === 'q6-0')
  await page.screenshot({ path: 'scratch/printed-paper/student-mobile.png', fullPage: true })
})

test('section navigation distinguishes unvisited and unanswered without sending a fabricated answer',async t=>{
 const page=await open(t,{questions:[{question_id:'q1',section_id:'s1',content:'First question',marks:1,exam_pattern_sections:{section_name:'Maths'}},{question_id:'q2',section_id:'s2',content:'Second question',marks:2,exam_pattern_sections:{section_name:'Science'}}]})
 await page.getByRole('button',{name:'Question 2: not visited',exact:true}).waitFor()
 await page.getByRole('combobox').selectOption('s2');await page.getByText('Second question',{exact:true}).waitFor()
 await page.getByRole('button',{name:'Question 2: unanswered',exact:true}).waitFor()
 await page.getByRole('button',{name:'Previous',exact:true}).click();await page.getByText('First question',{exact:true}).waitFor()
 assert.deepEqual(await page.evaluate(()=>window.calls),[])
})

test('Group 2 uses the DSC layout: 150 navigator buttons and reachable fixed answers', async t => {
  const source=JSON.parse(fs.readFileSync('scratch/group2/prepared.json')).questions
  const page=await open(t,{name:'Group 2 G.S. Test 2',expiresAt:new Date(Date.now()+3600000).toISOString(),questions:source.map(q=>({question_id:'q'+q.number,section_id:'general',content:q.content,marks:1,negative_marks:0,exam_pattern_sections:{section_name:'General Studies'}})),options:source.flatMap(q=>q.options.map((label,i)=>({id:`q${q.number}-${i}`,question_id:'q'+q.number,content:label})))})
  const css=fs.readdirSync('dist/assets').find(f=>f.endsWith('.css'))
  await page.addStyleTag({content:fs.readFileSync('dist/assets/'+css,'utf8')})
  await page.setViewportSize({width:1440,height:1000})
  assert.equal(await page.getByRole('button',{name:/^Question \d+:/}).count(),150)
  await page.getByRole('button',{name:'Option A',exact:true}).click()
  await page.getByRole('button',{name:'Mark for Review',exact:true}).click()
  await page.waitForFunction(()=>window.stored.q1?.is_marked_for_review)
  await page.screenshot({path:'scratch/group2/student-desktop.png',fullPage:true})
  await page.getByRole('button',{name:'Save & Next',exact:true}).click()
  const src=await page.getByRole('img',{name:/Printed source/}).first().getAttribute('src')
  assert.ok(src===JSON.parse(source[1].content.slice(15)).blocks[0].src,'Question 2 displays its own source image')
  await page.setViewportSize({width:390,height:844})
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
  const answer=await page.getByRole('button',{name:'Option A',exact:true}).boundingBox()
  assert.ok(answer.y+answer.height<=844)
  await page.getByRole('button',{name:'Option C',exact:true}).click()
  await page.waitForFunction(()=>window.stored.q2?.selected_option_id==='q2-2')
  await page.screenshot({path:'scratch/group2/student-mobile.png',fullPage:true})
})

test('UI waits for rapid pending choices before submission and disables changes while submitting', async t => {
  const page = await open(t, { holdSave: true })
  await page.getByRole('button', { name: 'Option Alpha' }).click()
  await page.getByRole('button', { name: 'Option Beta' }).click()
  await page.getByRole('button', { name: 'Submit Test' }).first().click()
  await page.getByRole('button', { name: 'Confirm Submit' }).click()
  assert.equal(await page.getByRole('button', { name: 'Option Alpha' }).isEnabled(), false)
  assert.deepEqual(await page.evaluate(() => window.calls.map(c => c.kind)), ['save'])
  await page.evaluate(() => { window.fixture.holdSave = false; window.releaseSave() })
  await page.waitForURL('**/result')
  assert.deepEqual(await page.evaluate(() => window.calls.map(c => c.kind)), ['save', 'save', 'submit'])
  assert.equal(await page.evaluate(() => window.stored.q1.selected_option_id), 'b')
})

test('UI keeps failed intent visible, blocks submission and saves it on explicit retry', async t => {
  const page = await open(t, { failSave: true })
  await page.getByRole('button', { name: 'Option Beta' }).click()
  await page.getByRole('button', { name: 'Retry saving' }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Option Beta' }).getAttribute('aria-pressed'), 'true')
  await page.getByRole('button', { name: 'Submit Test' }).first().click()
  await page.getByRole('button', { name: 'Confirm Submit' }).click()
  await page.getByText('Some answers are not saved. Retry saving before submitting.', { exact: true }).waitFor()
  assert.equal(await page.evaluate(() => window.calls.some(c => c.kind === 'submit')), false)
  await page.evaluate(() => { window.fixture.failSave = false })
  await page.getByRole('button', { name: 'Retry saving' }).click()
  await page.waitForFunction(() => document.body.innerText.includes('Saved') && !document.body.innerText.includes('Unsaved'))
  assert.equal(await page.evaluate(() => window.stored.q1.selected_option_id), 'b')
})

test('UI serializes select, mark and clear without losing the review flag', async t => {
  const page = await open(t, { holdSave: true })
  await page.getByRole('button', { name: 'Option Alpha' }).click()
  await page.getByRole('button', { name: 'Mark for Review' }).click()
  await page.getByRole('button', { name: 'Clear', exact: true }).click()
  await page.evaluate(() => { window.fixture.holdSave = false; window.releaseSave() })
  await page.waitForFunction(() => window.stored.q1?.selected_option_id === null && window.stored.q1?.is_marked_for_review)
  assert.deepEqual(await page.evaluate(() => window.calls.map(c => [c.option, c.marked, c.clear])),
    [['a', false, false], ['a', true, false], [null, true, true]])
})

test('expired UI locks answers, exposes failure and retries server finalization', async t => {
  const page = await open(t, { expired: true, failSubmit: true })
  await page.getByRole('button', { name: 'Retry submission' }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Option Alpha' }).isEnabled(), false)
  assert.match(await page.locator('body').innerText(), /Only answers accepted by the server count/)
  await page.evaluate(() => { window.fixture.failSubmit = false })
  await page.getByRole('button', { name: 'Retry submission' }).click()
  await page.waitForURL('**/result')
  assert.deepEqual(await page.evaluate(() => window.calls.map(c => c.kind)), ['submit', 'submit'])
})

test('load failure has a visible retry instead of an empty-question state', async t => {
  const page = await open(t, { failLoad: true })
  assert.match(await page.getByRole('alert').innerText(), /Connection unavailable/)
  assert.doesNotMatch(await page.locator('body').innerText(), /No questions found/)
  await page.evaluate(() => { window.fixture.failLoad = false })
  await page.getByRole('button', { name: 'Retry loading' }).click()
  await page.getByRole('button', { name: 'Option Alpha' }).waitFor()
})

test('reopening the workspace restores persisted selection and review flag', async t => {
  const page = await open(t)
  await page.getByRole('button', { name: 'Option Beta' }).click()
  await page.getByRole('button', { name: 'Mark for Review' }).click()
  await page.waitForFunction(() => window.stored.q1?.is_marked_for_review === true)
  await page.evaluate(() => window.mount())
  await page.waitForFunction(() => window.loadCalls === 2 && !document.body.innerText.includes('Loading Exam Engine'))
  await page.getByRole('button', { name: 'Option Beta', pressed: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Mark for Review' }).getAttribute('aria-pressed'), 'true')
})

test('submission failure with saved answers does not misreport an unsaved answer', async t => {
  const page = await open(t, { failSubmit: true })
  await page.getByRole('button', { name: 'Option Alpha' }).click()
  await page.getByRole('button', { name: 'Submit Test' }).first().click()
  await page.getByRole('button', { name: 'Confirm Submit' }).click()
  await page.getByRole('button', { name: 'Retry submission' }).waitFor()
  assert.match(await page.locator('body').innerText(), /Submission has not been confirmed/)
  assert.equal(await page.getByRole('button', { name: 'Option Beta' }).isEnabled(), false)
  assert.doesNotMatch(await page.locator('body').innerText(), /Some answers are not saved/)
})
