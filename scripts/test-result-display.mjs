import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { chromium } from 'playwright'

// Bundle the real pages/service with an in-memory transport. No Vite/env loading,
// Supabase client, HTTP server, credentials, accounts or database is used.
let browser, bundle
before(async () => {
  const result = await build({
    stdin: { contents: `
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import Student from './src/pages/student/TestResult.jsx';
      import Teacher from './src/pages/admin/AdminAttemptDetail.jsx';
      import List from './src/pages/admin/AdminResults.jsx';
      import {resultService} from './src/services/resultService.js';
      window.service = resultService;
      window.mount = kind => createRoot(document.getElementById('root')).render(
        React.createElement(kind === 'student' ? Student : kind === 'teacher' ? Teacher : List,
          {attemptId:'attempt-a', testId:'test-a'}));
    `, resolveDir: process.cwd(), loader: 'jsx' },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    plugins: [{ name: 'local-only-fixtures', setup(b) {
      b.onResolve({ filter: /supabaseClient\.js$/ }, () => ({ path: 'transport', namespace: 'fixture' }))
      b.onResolve({ filter: /studentExamService\.js$/ }, () => ({ path: 'student', namespace: 'fixture' }))
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === 'student'
        ? `export const studentExamService = {getMyAttempts: async () => [window.fixture.attempt]}`
        : `
          export const supabase = {
            rpc: async (name, args) => {
              const f = window.fixture; window.calls.push({rpc:name,args});
              if (f.failRpc === name) return {data:null,error:{message:'Request denied'}};
              if (name === 'is_teacher') return {data:f.teacher,error:null};
              if (name === 'finalize_expired_attempts') return {data:0,error:null};
              if (name === 'get_attempt_section_performance') {
                if (f.attempt.tests.snapshot_contract_version !== 1 || (!f.teacher && f.attempt.tests.review_policy !== 'AFTER_SUBMISSION'))
                  throw new Error('Prohibited section request');
                return {data:f.sections,error:null};
              }
              if (name === 'get_attempt_review') {
                if (!f.teacher && f.attempt.tests.review_policy !== 'AFTER_SUBMISSION') throw new Error('Prohibited review request');
                return {data:f.review,error:null};
              }
              throw new Error('Unexpected RPC '+name);
            },
            from: table => {
              if (!['test_attempts','test_option_snapshots'].includes(table)) throw new Error('Unsupported table '+table);
              const call={table}; window.calls.push(call);
              const q={
                select: projection => {
                  call.projection=projection;
                  // Explicit supported relation fields, rather than accepting arbitrary mocks.
                  const allowed={tests:['name','duration_minutes','review_policy','snapshot_contract_version','exam_name'],student_profiles:['full_name']};
                  for (const [,relation,fields] of projection.matchAll(/(\\w+)\\(([^)]+)\\)/g)) {
                    if (!allowed[relation] || fields.split(',').some(x=>!allowed[relation].includes(x.trim()))) throw new Error('Unsupported projection '+projection);
                  }
                  return q;
                },
                eq:(key,value)=>{(call.filters??=[]).push([key,value]);return q},
                neq:(key,value)=>{call.exclude=[key,value];return q},
                order:()=>q,
                single:()=>{call.single=true;return q},
                then: resolve => {
                  const f=window.fixture;
                  if (f.denied) return Promise.resolve(resolve({data:null,error:{message:'Attempt not found or unauthorized'}}));
                  return Promise.resolve(resolve({data:table==='test_option_snapshots'?f.options:call.single?f.attempt:[f.attempt],error:null}));
                }
              }; return q;
            }
          };
        `, loader: 'js' }))
    }}]
  })
  bundle = result.outputFiles[0].text
  browser = await chromium.launch({ headless: true })
})
after(async () => { await browser?.close() })

function fixture(version = 1, policy = 'AFTER_SUBMISSION', teacher = false) {
  return {
    teacher,
    attempt: { id:'attempt-a',test_id:'test-a',status:'SUBMITTED',score:3,max_score:8,
      correct_count:1,incorrect_count:1,unanswered_count:0,submitted_at:'2026-09-12T00:00:00Z',
      student_profiles:{full_name:'Fixture Learner'},
      tests:{name:'Frozen test',exam_name:'Frozen exam',snapshot_contract_version:version,review_policy:policy} },
    sections:[{section_id:'s',section_name:'Frozen section',subject_name:'Frozen subject',score:3,max_score:8,correct_count:1,incorrect_count:1,unanswered_count:0}],
    review:[{question_id:'q',section_name:'Frozen section',content:'Preserved question',selected_option_id:'o',correct_option_id:'o',is_correct:true,is_unanswered:false,
      marks:version===1?4:null,negative_marks:version===1?1:null,marks_awarded:version===1?4:null,explanation:'Preserved explanation'}],
    options:[{id:'o',content:'Preserved option'}]
  }
}

async function open(t, data, kind = 'student') {
  const context = await browser.newContext()
  t.after(() => context.close())
  await context.route('**/*', route => route.abort())
  const page = await context.newPage()
  const errors=[]; page.on('pageerror',e=>errors.push(e.message))
  await page.setContent('<div id="root"></div>')
  await page.evaluate(data => { window.fixture=data; window.calls=[] }, data)
  await page.addScriptTag({content:bundle})
  await page.evaluate(kind => window.mount(kind), kind)
  await page.waitForFunction(() => !document.body.innerText.includes('Loading'))
  assert.deepEqual(errors,[])
  return page
}
const rpcNames = page => page.evaluate(() => window.calls.filter(c=>c.rpc).map(c=>c.rpc))

test('version 1 SUMMARY_ONLY renders aggregates without section/review/key requests', async t => {
  const page=await open(t,fixture(1,'SUMMARY_ONLY'))
  const text=await page.locator('body').innerText()
  assert.match(text,/Frozen exam/); assert.match(text,/37.5%/)
  assert.match(text,/summary-only/)
  assert.deepEqual(await rpcNames(page),['finalize_expired_attempts'])
  const query=await page.evaluate(()=>window.calls.find(c=>c.table==='test_attempts'))
  assert.ok(query.projection.includes('snapshot_contract_version'))
  assert.ok(query.projection.includes('review_policy'))
  assert.deepEqual(query.filters,[['id','attempt-a']])
})

test('version 1 AFTER_SUBMISSION preserves sections, answers, marks and explanations', async t => {
  const page=await open(t,fixture())
  await page.getByRole('button',{name:/Q1/}).click()
  const text=await page.locator('body').innerText()
  for(const value of ['Frozen section','Frozen subject','+4 marks','Preserved option','Preserved explanation']) assert.ok(text.includes(value),value)
  assert.ok((await rpcNames(page)).includes('get_attempt_section_performance'))
})

test('legacy finalized student history preserves aggregate and authorized explanation without inferred grading', async t => {
  const data=fixture(0); data.attempt.status='EXPIRED'; data.review[0].section_name=null
  const page=await open(t,data)
  await page.getByRole('button',{name:/Q1/}).click()
  const text=await page.locator('body').innerText()
  assert.match(text,/37.5%/); assert.match(text,/Historical section grading is unavailable/)
  assert.match(text,/Unavailable marks/); assert.match(text,/Preserved explanation/)
  assert.doesNotMatch(text,/\+4 marks|0 marks/)
  assert.ok(!(await rpcNames(page)).includes('get_attempt_section_performance'))
})

test('legacy teacher history keeps authorized review even for SUMMARY_ONLY; supported projections only', async t => {
  const page=await open(t,fixture(0,'SUMMARY_ONLY',true),'teacher')
  const text=await page.locator('body').innerText()
  assert.match(text,/Fixture Learner/); assert.match(text,/37.5%/); assert.match(text,/Preserved explanation/)
  assert.match(text,/Unavailable/)
  assert.ok(!(await rpcNames(page)).includes('get_attempt_section_performance'))
  const queries=await page.evaluate(()=>window.calls.filter(c=>c.projection))
  const projection=queries.find(c=>c.table==='test_attempts').projection
  assert.ok(projection.includes('snapshot_contract_version')); assert.ok(projection.includes('review_policy'))
  assert.ok(!projection.includes('email'))
})

test('legacy SUMMARY_ONLY student never requests review or calculations', async t => {
  const page=await open(t,fixture(0,'SUMMARY_ONLY'))
  assert.match(await page.locator('body').innerText(),/37.5%/)
  assert.deepEqual(await rpcNames(page),['finalize_expired_attempts'])
})

test('missing historical counts, grading, labels and explanation remain unavailable, not zero', async t => {
  const data=fixture(0,'AFTER_SUBMISSION',true)
  Object.assign(data.attempt,{score:null,max_score:null,correct_count:null,incorrect_count:null,unanswered_count:null,submitted_at:null})
  data.attempt.tests.exam_name=null
  Object.assign(data.review[0],{explanation:null,correct_option_id:null,is_correct:null,section_name:null})
  const page=await open(t,data,'teacher'); const text=await page.locator('body').innerText()
  assert.match(text,/Historical label unavailable/); assert.match(text,/Explanation unavailable/)
  assert.match(text,/Grading unavailable/); assert.doesNotMatch(text,/0%|0 mk|Not Answered|Invalid Date|1970/)
})

test('cross-user attempt denial is shown honestly and never followed by review requests', async t => {
  const data=fixture();data.denied=true
  const page=await open(t,data)
  assert.match(await page.locator('body').innerText(),/Attempt not found or unauthorized/)
  assert.deepEqual(await rpcNames(page),['finalize_expired_attempts'])
  assert.doesNotMatch(await page.locator('body').innerText(),/Frozen exam|Preserved explanation/)
})

test('review RPC denial is not converted to empty review or successful result', async t => {
  const data=fixture(0);data.failRpc='get_attempt_review'
  const page=await open(t,data)
  assert.match(await page.locator('body').innerText(),/Request denied/)
  assert.doesNotMatch(await page.locator('body').innerText(),/37.5%|Preserved explanation/)
})

test('teacher list uses supported fields, preserves frozen label and filters test ID', async t => {
  const page=await open(t,fixture(1,'AFTER_SUBMISSION',true),'list')
  const text=await page.locator('body').innerText()
  assert.match(text,/Fixture Learner/);assert.match(text,/Frozen exam/);assert.match(text,/37.5%/)
  await page.evaluate(()=>window.service.getTeacherResults('test-a'))
  const call=await page.evaluate(()=>window.calls.filter(c=>c.table==='test_attempts').at(-1))
  assert.deepEqual(call.filters,[['test_id','test-a']]);assert.deepEqual(call.exclude,['status','IN_PROGRESS'])
  assert.ok(!call.projection.includes('email'))
})

test('non-teacher cannot use teacher list/detail adapter even for own attempt', async t => {
  const page=await open(t,fixture(),'teacher')
  assert.match(await page.locator('body').innerText(),/Unauthorized to view teacher results/)
  assert.deepEqual(await rpcNames(page),['is_teacher'])
  assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.table).length),0)
})

test('unfinalized direct result never renders aggregate or requests review', async t => {
  const data=fixture();data.attempt.status='IN_PROGRESS'
  const page=await open(t,data)
  assert.match(await page.locator('body').innerText(),/Attempt is not finalized/)
  assert.deepEqual(await rpcNames(page),['finalize_expired_attempts'])
})

test('version 1 teacher detail retains ordinary section and review behavior', async t => {
  const page=await open(t,fixture(1,'AFTER_SUBMISSION',true),'teacher')
  const text=await page.locator('body').innerText()
  assert.match(text,/Frozen subject/);assert.match(text,/Preserved explanation/)
  assert.ok((await rpcNames(page)).includes('get_attempt_section_performance'))
})

test('empty legacy review is explicitly unavailable while aggregate history remains visible', async t => {
  const data=fixture(0);data.review=[]
  const page=await open(t,data)
  const text=await page.locator('body').innerText()
  assert.match(text,/37.5%/);assert.match(text,/Review details unavailable/)
  assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.table==='test_option_snapshots').length),0)
})

for (const version of [0, 1]) {
  for (const policy of ['SUMMARY_ONLY', 'AFTER_SUBMISSION']) {
    for (const teacher of [false, true]) {
      test(`section access: version ${version}, ${policy}, ${teacher ? 'teacher' : 'student'}`, async t => {
        const page = await open(t, fixture(version, policy, teacher), teacher ? 'teacher' : 'student')
        const body = await page.locator('body').innerText()
        const calls = await rpcNames(page)
        const expectSections = version === 1 && (teacher || policy === 'AFTER_SUBMISSION')
        const expectReview = teacher || policy === 'AFTER_SUBMISSION'
        assert.equal(calls.includes('get_attempt_section_performance'), expectSections)
        assert.equal(body.includes('Frozen subject'), expectSections)
        assert.equal(calls.includes('get_attempt_review'), expectReview)
        assert.match(body, /37.5%/)
        if (version === 0) assert.match(body, /Historical section grading is unavailable/)
        if (teacher) assert.equal(calls[0], 'is_teacher')
      })
    }
  }
}

test('teacher SUMMARY_ONLY section denial is surfaced without rendering result data', async t => {
  const data = fixture(1, 'SUMMARY_ONLY', true)
  data.failRpc = 'get_attempt_section_performance'
  const page = await open(t, data, 'teacher')
  const body = await page.locator('body').innerText()
  assert.match(body, /Request denied/)
  assert.doesNotMatch(body, /37.5%|Frozen subject|Preserved explanation/)
  assert.ok(!(await rpcNames(page)).includes('get_attempt_review'))
})
