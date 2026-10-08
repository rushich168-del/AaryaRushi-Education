import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = path.resolve(fileURLToPath(new URL('../scratch/cloudflare-preview/', import.meta.url)))
const headerFile = await readFile(path.join(root, '_headers'), 'utf8')
const headers = Object.fromEntries(headerFile.split('\n').filter(line => line.startsWith('  ')).map(line => {
  const index = line.indexOf(':')
  return [line.slice(0, index).trim(), line.slice(index + 1).trim()]
}))
const server = createServer(async (req, res) => {
  try {
    const requested = path.resolve(root, '.' + new URL(req.url, 'http://localhost').pathname)
    if (requested !== root && !requested.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return }
    let file = requested
    let bytes
    try { bytes = await readFile(file) } catch { file = path.join(root, 'index.html'); bytes = await readFile(file) }
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' }
    res.writeHead(200, { ...headers, 'Content-Type': types[path.extname(file)] || 'application/octet-stream' })
    res.end(bytes)
  } catch { res.writeHead(500); res.end() }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage()
  page.setDefaultTimeout(10000)
  const external = [], errors = []
  page.on('request', request => { if (!request.url().startsWith(origin)) external.push(request.url()) })
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(origin)
  assert.match(await page.locator('#school-programs').innerText(), /CBSE \/ ICSE/)
  assert.match(await page.locator('#school-programs').innerText(), /IIT \/ NEET/)
  for (const route of ['/login', '/signup', '/forgot-password', '/reset-password', '/dashboard/student', '/dashboard/admin/results', '/test/example/attempt']) {
    await page.goto(origin + route)
    assert.equal(await page.getByRole('heading', { name: 'Student accounts are coming soon.' }).count(), 1)
    assert.equal(await page.locator('input').count(), 0)
  }
  await page.goto(origin + '/demo/tests/foundation-practice-test-1')
  assert.match(await page.locator('body').innerText(), /DSC/)
  assert.equal(await page.getByRole('heading', { name: 'Student accounts are coming soon.' }).count(), 0)
  await page.setViewportSize({ width: 320, height: 700 })
  await page.goto(origin)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  assert.deepEqual(external, [], 'Public preview must not contact external services')
  assert.deepEqual(errors, [])
  console.log('PASS: brochure, 7 gated account routes, direct demo route, 320px fit, no external requests or page errors; deployment headers served locally.')
} finally {
  await browser.close()
  await new Promise(resolve => server.close(resolve))
}
