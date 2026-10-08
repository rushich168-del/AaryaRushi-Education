import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { chromium } from 'playwright'
let browser, bundle
before(async () => {
  bundle = (await build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import Overview from './src/pages/student/StudentLearningOverview.jsx';createRoot(document.getElementById('root')).render(<Overview userId="student"/>);`, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic', plugins: [{ name: 'fixture', setup(b) {
    b.onResolve({ filter: /learningService\.js$/ }, () => ({ path: 'service', namespace: 'fixture' }))
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ loader: 'js', contents: `export const learningService={courses:async()=>{if(window.fixture.fail)throw Error('offline');return window.fixture.courses},completions:async id=>{window.requestedUser=id;return [{lesson_id:'done'},{lesson_id:'done'},{lesson_id:'removed'}]},lessons:async id=>{if(window.fixture.bad===id)throw Error('offline');return window.fixture.lessons[id]||[]}}` }))
  } }] })).outputFiles[0].text
  browser = await chromium.launch()
})
after(async () => browser?.close())
async function open(t, patch = {}) {
  const context = await browser.newContext()
  t.after(() => context.close())
  await context.route('**/*', r => r.request().url().startsWith('http://ksc.test/') ? r.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }) : r.abort())
  const p = await context.newPage()
  await p.goto('http://ksc.test/dashboard/student')
  await p.evaluate(patch => { window.fixture = { courses: [{ id: 'c1', name: 'Maths' }, { id: 'c2', name: 'Science' }], lessons: { c1: [{ id: 'draft', title: 'Draft', is_published: false }, { id: 'done', title: 'Basics', is_published: true }, { id: 'next', title: 'Fractions', is_published: true }] }, ...patch } }, patch)
  await p.addScriptTag({ content: bundle })
  await p.getByRole('button', { name: 'Refresh course progress' }).waitFor()
  return p
}
test('published lesson progress deduplicates completions and links to first unfinished lesson', async t => {
  const p = await open(t)
  assert.match(await p.locator('body').innerText(), /1 of 2 published lessons completed/)
  assert.equal(await p.getByRole('link', { name: 'Continue learning: Fractions' }).getAttribute('href'), '/dashboard/student/courses?course=c1&lesson=next')
  assert.equal(await p.evaluate(() => window.requestedUser), 'student')
  assert.equal(await p.getByText('Your teacher has not published lessons yet.').count(), 1)
})
test('partial failure preserves other courses and refresh recovers', async t => {
  const p = await open(t, { bad: 'c1' })
  await p.getByRole('alert').waitFor()
  assert.equal(await p.getByRole('heading', { name: 'Science' }).count(), 1)
  await p.evaluate(() => window.fixture.bad = null)
  await p.getByRole('button', { name: 'Refresh course progress' }).click()
  await p.getByRole('link', { name: 'Continue learning: Fractions' }).waitFor()
  assert.equal(await p.getByRole('alert').count(), 0)
})
test('request error does not claim no enrollment; retry and actual empty state work', async t => {
  const p = await open(t, { fail: true, courses: [] })
  assert.equal(await p.getByText(/No courses assigned/).count(), 0)
  await p.evaluate(() => window.fixture.fail = false)
  await p.getByRole('button', { name: 'Refresh course progress' }).click()
  await p.getByText(/No courses assigned/).waitFor()
})
test('completed course offers review instead of an unfinished lesson', async t => {
  const p = await open(t, { courses: [{ id: 'c1', name: 'Maths' }], lessons: { c1: [{ id: 'done', title: 'Basics', is_published: true }] } })
  assert.equal(await p.getByRole('link', { name: 'Review course' }).getAttribute('href'), '/dashboard/student/courses?course=c1')
  assert.match(await p.locator('body').innerText(), /1 of 1 published lessons completed/)
})
