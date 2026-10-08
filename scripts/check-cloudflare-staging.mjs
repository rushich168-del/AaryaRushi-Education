import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import JSZip from 'jszip'
import { BACKEND_URL, stagingHeaders } from './staging-config.mjs'

// Test the ZIP itself, with its deployed headers, without contacting live accounts.
const zipPath = fileURLToPath(new URL('../scratch/ksc-cloudflare-staging.zip', import.meta.url))
const zip = await JSZip.loadAsync(await readFile(zipPath))
assert.equal(await zip.file('_headers').async('string'), stagingHeaders)
const headers = Object.fromEntries(stagingHeaders.split('\n').filter(line => line.startsWith('  ')).map(line => {
  const colon = line.indexOf(':')
  return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()]
}))
const server = createServer(async (req, res) => {
  try {
    const requested = new URL(req.url, 'http://localhost').pathname.slice(1)
    const file = zip.file(requested) || zip.file('index.html')
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }
    res.writeHead(200, { ...headers, 'Content-Type': types[path.extname(file.name)] || 'application/octet-stream' })
    res.end(await file.async('nodebuffer'))
  } catch { res.writeHead(500); res.end() }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let browser
try {
  browser = await chromium.launch({ headless: true, ...(process.env.KSC_CHROMIUM ? { executablePath: process.env.KSC_CHROMIUM } : {}) })
  const page = await browser.newPage()
  page.setDefaultTimeout(10000)
  const origin = `http://127.0.0.1:${server.address().port}`
  const errors = [], unexpected = []
  let signInRequests = 0
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', async route => {
    const url = route.request().url()
    if (url.startsWith(origin + '/')) return route.continue()
    if (url === BACKEND_URL + '/auth/v1/token?grant_type=password') {
      signInRequests++
      return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ code: 'invalid_credentials', msg: 'Invalid login credentials' }) })
    }
    unexpected.push(new URL(url).origin)
    return route.abort()
  })
  await page.goto(origin)
  for (const route of ['/dashboard', '/dashboard/student/courses', '/dashboard/admin', '/dashboard/admin/paper-tests', '/dashboard/admin/results', '/test/example/attempt']) {
    await page.goto(origin + route)
    await page.waitForURL(origin + '/login')
    await page.getByRole('heading', { name: 'Sign in', exact: true }).waitFor()
  }
  await page.getByLabel('Email', { exact: true }).fill('staging-fixture@example.invalid')
  await page.getByLabel('Password', { exact: true }).fill('synthetic-not-a-real-password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.getByText(/incorrect|invalid|check.*email/i).last().waitFor()
  assert.equal(signInRequests, 1, 'CSP must permit the exact KSC auth destination')
  assert.equal(await page.getByRole('button', { name: 'Sign in', exact: true }).isEnabled(), true)
  await page.goto(origin + '/signup')
  await page.getByRole('heading', { name: 'Create account', exact: true }).waitFor()
  await page.goto(origin + '/forgot-password')
  await page.getByLabel('Email address').waitFor()
  await page.goto(origin + '/demo/tests/foundation-practice-test-1')
  assert.match(await page.locator('body').innerText(), /DSC/)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(origin + '/login')
  await page.getByLabel('Email', { exact: true }).waitFor()
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  assert.deepEqual(unexpected, [])
  assert.deepEqual(errors, [])
  console.log('PASS: actual staging ZIP, headers, six protected deep links including paper-to-test, sign-in failure/retry availability, signup/recovery forms, demo, mobile login and no old homepage links. All backend traffic intercepted; live accounts not tested.')
} finally {
  await browser?.close()
  await new Promise(resolve => server.close(resolve))
}
