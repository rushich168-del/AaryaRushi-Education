// Screenshots of a real PDF imported in the device-only preview (/testcreator/preview), for visual review.
// Needs the local app running (npm run dev). Uses its own temporary browser profile: nothing is saved to
// your browser, and the script never saves a draft, saves ready, shares or publishes.
// Usage: node scripts/shot-pdf-import.mjs <file.pdf> <out-dir> <question> [question ...] [--exam "SI & Constable"] [--format "Final test"]
//        [--figure-dialog <question>]   also opens Add figure from page on that question and screenshots the dialog (then cancels)
//        [--blockers yes]               screenshots the "Before saving ready" panel as imported
//        [--confirm-save yes]           ticks every question check and the final check in this throwaway session, then reports
//                                       whether the save button is enabled. It never presses the save button.
import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const flag = name => { const i = process.argv.indexOf('--' + name); return i > -1 ? process.argv[i + 1] : null }
const positional = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !all[i - 1]?.startsWith('--'))
const [file, out, ...numbers] = positional
if (!file || !out || !numbers.length) { console.error('Usage: node scripts/shot-pdf-import.mjs <file.pdf> <out-dir> <question> [question ...] [--exam name] [--format name]'); process.exit(2) }
const base = flag('url') || 'http://localhost:5173'
await mkdir(out, { recursive: true })

const browser = await chromium.launch({ headless: true })
const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage()
page.on('pageerror', e => console.error('page error:', e.message))
try {
  await page.goto(base + '/testcreator/preview')
  await page.getByRole('heading', { name: 'Prepare a paper', exact: true }).waitFor()
  if (flag('exam')) await page.getByLabel('Exam collection', { exact: true }).selectOption(flag('exam'))
  if (flag('format')) await page.getByRole('button', { name: new RegExp('^' + flag('format')) }).click()
  await page.getByLabel('Source paper').setInputFiles(file)
  await page.getByRole('button', { name: 'Prepare paper', exact: true }).click()
  await page.locator('.lp-question').first().waitFor({ timeout: 180000 })
  const summary = {
    file: path.basename(file),
    questions: await page.getByLabel('Go to question', { exact: true }).locator('option').count(),
    needingContentReview: await page.locator('.lp-issue-list button').count(),
    reviewLine: await page.locator('.lp-panel-title .lp-ready').first().innerText(),
    shots: [],
  }
  for (const number of numbers) {
    await page.getByLabel('Go to question', { exact: true }).selectOption({ label: String(number) })
    await page.getByText(`Question ${number}`, { exact: true }).waitFor()
    const question = page.locator('.lp-question')
    await question.locator('img').first().waitFor()
    await page.waitForTimeout(300)
    const shot = path.join(out, `import-q${number}.png`)
    await question.screenshot({ path: shot })
    summary.shots.push({ number, shot, sourceImages: await question.locator('img').count(), flagged: await question.locator('.lp-question-issues').count() > 0 })
  }
  if (flag('figure-dialog')) {
    const number = flag('figure-dialog')
    await page.getByLabel('Go to question', { exact: true }).selectOption({ label: String(number) })
    await page.getByText(`Question ${number}`, { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Add figure from page', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Add figure from page' })
    const source = dialog.getByRole('img', { name: /^Source PDF page/ }); await source.waitFor({ timeout: 60000 })
    // A sample rectangle, to show how a figure is marked. Nothing is added: the dialog is cancelled.
    const box = await source.boundingBox()
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.125); await page.mouse.down(); await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.275); await page.mouse.up()
    await page.waitForTimeout(300)
    const shot = path.join(out, `import-add-figure-dialog-q${number}.png`)
    await page.screenshot({ path: shot })
    summary.figureDialog = { number, shot, target: await dialog.locator('.lp-figure-target label').allInnerTexts() }
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  }
  const finish = page.locator('.lp-finish')
  if (flag('blockers')) {
    await finish.scrollIntoViewIfNeeded(); await page.waitForTimeout(200)
    summary.blockers = { shot: path.join(out, 'import-blockers.png'), lines: await page.locator('.lp-ready-blockers li').allInnerTexts() }
    await finish.screenshot({ path: summary.blockers.shot })
  }
  if (flag('confirm-save')) {
    const checked = []
    for (let guard = 0; guard < 400 && await page.locator('.lp-issue-list button').count() > 0; guard++) {
      const issue = page.locator('.lp-issue-list button').first()
      checked.push((await issue.locator('strong').innerText()).trim())
      await issue.click()
      await page.getByRole('checkbox', { name: 'I checked and resolved this question' }).check()
    }
    await page.getByRole('checkbox', { name: 'I have completed the final paper checks.' }).check()
    const save = finish.locator('button.lp-primary')
    await finish.scrollIntoViewIfNeeded(); await page.waitForTimeout(200)
    summary.save = { questionsTickedInThisSession: checked, button: (await save.innerText()).trim(), enabled: await save.isEnabled(), blockersLeft: await page.locator('.lp-ready-blockers li').allInnerTexts(), shot: path.join(out, 'import-ready-to-save.png') }
    await finish.screenshot({ path: summary.save.shot })
  }
  await writeFile(path.join(out, 'import-summary.json'), JSON.stringify(summary, null, 1))
  console.log(JSON.stringify(summary, null, 1))
} finally { await browser.close() }
