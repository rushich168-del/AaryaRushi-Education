import { test, expect } from '@playwright/test'

// No real account or backend is contacted. Auth responses are test fixtures.
test.beforeEach(async ({ context }) => {
  await context.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.hostname === '127.0.0.1') return route.continue()
    if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password') {
      const user = { id: '00000000-0000-4000-8000-000000000001', email: 'student@example.com', aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-09-10T00:00:00Z' }
      const exp = Math.floor(Date.now() / 1000) + 3600
      const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
      const token = encode({ alg: 'HS256', typ: 'JWT' }) + '.' + encode({ sub: user.id, exp, aud: 'authenticated', role: 'authenticated' }) + '.test-signature'
      return route.fulfill({ json: { access_token: token, token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: 'test-refresh', user } })
    }
    if (url.pathname === '/auth/v1/logout') return route.fulfill({ status: 204 })
    return route.fulfill({ status: 503, json: { message: 'External services disabled during KSC checks' } })
  })
})

test('exam discovery, mobile menu, and unknown exam recovery', async ({ page }, testInfo) => {
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await expect(page).toHaveTitle(/AaryaRushi Education/)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('A clear start to your preparation.')
  await page.screenshot({ path: 'docs/ksc/review/home-' + testInfo.project.name + '.png', fullPage: true })
  if (testInfo.project.name === 'mobile') {
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeHidden()
    await page.getByRole('button', { name: 'Open navigation' }).click()
    await expect(page.getByRole('button', { name: 'Close navigation' })).toHaveAttribute('aria-expanded', 'true')
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Competitive Exams', exact: true }).click()
  } else {
    await page.getByRole('link', { name: 'Explore Competitive Exams', exact: true }).click()
  }
  await expect(page.locator('article')).toHaveCount(5)
  for (const [slug, title] of [['sainik-school', 'Sainik School'], ['rms', 'RMS'], ['rimc', 'RIMC'], ['shreshta', 'SHRESHTA']]) {
    await page.locator('article').filter({ has: page.getByRole('heading', { name: title, exact: true }) }).getByRole('link').click()
    await expect(page).toHaveURL(new RegExp('/exams/' + slug + '$'))
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(title)
    await expect(page.getByText('Official details awaiting review')).toBeVisible()
    if (slug === 'rimc') await page.screenshot({ path: 'docs/ksc/review/exam-' + testInfo.project.name + '.png', fullPage: true })
    await expect(page.locator('main')).not.toContainText(/150|300 Marks|Class V or VIII/)
    await page.getByRole('link', { name: 'All competitive exams' }).click()
  }
  await page.goto('/exams/unknown-exam')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Exam not found')
  await page.getByRole('link', { name: 'Browse competitive exams' }).click()
  await expect(page).toHaveURL(/\/exams$/)
  expect(errors).toEqual([])
})

test('public routes have honest states and no horizontal overflow', async ({ page }) => {
  const routes = [
    ['/', 'A clear start to your preparation.'], ['/about', 'About AaryaRushi Education'],
    ['/courses', 'Programs'], ['/branches', 'Branches'], ['/contact', 'Contact AaryaRushi Education'],
    ['/exams/rimc/', 'RIMC'], ['/missing', 'Page not found'],
    ['/dashboard-other', 'Page not found'], ['/dashboard/admin-extra', 'Page not found'],
    ['/dashboard/unknown', 'Page not found'], ['/exams/rms/nested', 'Exam not found'],
  ]
  for (const [path, title] of routes) {
    await page.goto(path)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(title)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await expect(page.locator('body')).not.toContainText(/Project Atlas|Placeholder|top ranks|leading institute/)
  }
  await page.goto('/contact')
  await expect(page.getByText(/Online enquiries are not open yet/)).toBeVisible()
  await expect(page.locator('form')).toHaveCount(0)
})

test('legacy localStorage bypass cannot open protected areas', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('PLAYWRIGHT_TEST_BYPASS', 'true'))
  for (const path of ['/dashboard', '/dashboard/tests', '/dashboard/admin']) {
    await page.goto(path)
    await expect(page).toHaveURL(/\/login$/)
    await expect(page.getByRole('heading', { name: 'Welcome to AaryaRushi Education' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'System Overview' })).toHaveCount(0)
  }
})

test('student shell, staff closure and sign out with mocked auth', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('Email', { exact: true }).fill('student@example.com')
  await page.getByLabel('Password', { exact: true }).fill('local-test-password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).toHaveURL(/\/dashboard$/)
  await expect(page.getByText('No scores or test counts are available.', { exact: false })).toBeVisible()
  for (const [label, title] of [['Mock tests', 'Mock tests'], ['Performance', 'Performance'], ['Account settings', 'Account settings']]) {
    await page.getByRole('navigation', { name: 'Student navigation' }).getByRole('link', { name: label, exact: true }).click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(title)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  }
  await page.goto('/dashboard/admin/questions')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Staff area is not available yet')
  await expect(page.locator('main')).not.toContainText(/1,204|15,430|Launch Generator/)
  await page.getByRole('link', { name: 'Back to student area' }).click()
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(page).toHaveURL(/\/login$/)
})
