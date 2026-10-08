import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BACKEND_URL, PROJECT_REF, stagingEnvironment, stagingHeaders } from './staging-config.mjs'
const jwt = payload => `e30.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.synthetic`
const env = key => ({ VITE_SUPABASE_URL: BACKEND_URL, VITE_SUPABASE_ANON_KEY: key })
test('staging accepts only intended public settings', () => {
  const key = jwt({ role: 'anon', ref: PROJECT_REF })
  assert.deepEqual(stagingEnvironment({ ...env(key), VITE_UNRELATED: 'excluded', VITE_PUBLIC_PREVIEW: 'true' }), { ...env(key), VITE_PUBLIC_PREVIEW: 'false' })
  assert.equal(stagingEnvironment(env('sb_publishable_synthetic')).VITE_PUBLIC_PREVIEW, 'false')
})
test('rejects wrong backend, private keys, wrong project JWT and missing config', () => {
  for (const key of ['', 'sb_secret_synthetic', 'malformed', jwt({ role: 'service_role', ref: PROJECT_REF }), jwt({ role: 'anon', ref: 'another-project' })]) assert.throws(() => stagingEnvironment(env(key)))
  assert.throws(() => stagingEnvironment({ ...env('sb_publishable_synthetic'), VITE_SUPABASE_URL: 'https://another-project.supabase.co' }))
  assert.throws(() => stagingEnvironment({}))
})
test('staging connection policy allows only self, KSC HTTPS backend and Razorpay checkout', () => {
  assert.equal(stagingHeaders.match(/connect-src ([^;]+)/)[1], `'self' ${BACKEND_URL} https://api.razorpay.com https://lumberjack.razorpay.com`)
  assert.equal(stagingHeaders.match(/frame-src ([^;]+)/)[1], 'https://api.razorpay.com https://checkout.razorpay.com')
  assert.match(stagingHeaders, /noindex, nofollow/)
  assert.match(stagingHeaders, /frame-ancestors 'none'/)
})
test('staging CSP admits the in-browser preparation (WebAssembly, same-origin workers, blob: crops) and nothing broader', () => {
  const directive = name => stagingHeaders.match(new RegExp(`${name} ([^;\\n]+)`))[1].trim()
  assert.equal(directive('script-src'), `'self' 'wasm-unsafe-eval' https://checkout.razorpay.com`)
  assert.equal(directive('worker-src'), `'self'`)
  assert.equal(directive('style-src'), `'self' 'unsafe-inline' https://fonts.googleapis.com`)
  assert.equal(directive('font-src'), `'self' data: https://fonts.gstatic.com`)
  assert.equal(directive('img-src'), `'self' data: blob: ${BACKEND_URL} https://*.razorpay.com`)
  assert.doesNotMatch(stagingHeaders, /'unsafe-eval'|script-src[^;]*blob:|https:\/\/cdn|jsdelivr|unpkg/)
})
